/** Saved in the existing Homebridge accessory context, alongside its identity. */
export interface ShutdownDeadline {
  minutes: number;
  deadline: number;
}

interface ShutdownTimerOptions {
  durations: readonly number[];
  changed: (state: ShutdownDeadline | null) => void;
  /** Check stillCurrent after asynchronous reads, before issuing a power write. */
  turnOff: (stillCurrent: () => boolean) => Promise<boolean>;
  warn: (message: string) => void;
}

// A brief restart or network outage may delay execution. Never apply an old
// countdown hours later, when the user could have started a different session.
export const shutdownGraceMs = 5 * 60 * 1000;
const retryMs = 30000;

/** One persisted, replaceable countdown. No periodic polling of its own. */
export class ShutdownTimer {
  private current: ShutdownDeadline | null = null;
  private timeout?: NodeJS.Timeout;
  private stopped = false;
  private warned = false;

  constructor(private readonly options: ShutdownTimerOptions) {}

  get state(): Readonly<ShutdownDeadline> | null {
    return this.current;
  }

  restore(saved: unknown, active: boolean | undefined): void {
    const state = saved as Partial<ShutdownDeadline> | null;
    if (!state || active === false || !this.options.durations.includes(state.minutes as number)
      || !Number.isSafeInteger(state.deadline)
      || (state.deadline as number) > Date.now() + (state.minutes as number) * 60000 + 1000
      || (state.deadline as number) + shutdownGraceMs <= Date.now()) {
      if (saved !== undefined && saved !== null) {
        this.options.changed(null);
        if (active) {
          this.options.warn('Discarded an invalid, removed, or expired shutoff countdown.');
        }
      }
      return;
    }
    this.current = { minutes: state.minutes as number, deadline: state.deadline as number };
    this.schedule();
  }

  arm(minutes: number): void {
    if (this.stopped || !this.options.durations.includes(minutes)) {
      throw new Error('This shutoff duration is not available.');
    }
    clearTimeout(this.timeout);
    this.current = { minutes, deadline: Date.now() + minutes * 60000 };
    this.warned = false;
    this.options.changed(this.current);
    this.schedule();
  }

  cancel(): void {
    clearTimeout(this.timeout);
    if (this.current) {
      this.current = null;
      this.options.changed(null);
    }
  }

  /** Leave the saved deadline intact so the next process can resume it. */
  stop(): void {
    this.stopped = true;
    clearTimeout(this.timeout);
  }

  private schedule(delay = Math.max(0, (this.current?.deadline ?? 0) - Date.now())): void {
    clearTimeout(this.timeout);
    const state = this.current;
    if (!state || this.stopped) {
      return;
    }
    this.timeout = setTimeout(() => { void this.expire(state); }, delay);
    this.timeout.unref();
  }

  private async expire(state: ShutdownDeadline): Promise<void> {
    const stillCurrent = () => !this.stopped && this.current === state;
    if (!stillCurrent()) {
      return;
    }
    if (Date.now() < state.deadline) {
      this.schedule(); // The system clock moved backwards.
      return;
    }
    if (Date.now() >= state.deadline + shutdownGraceMs) {
      this.options.warn('Shutoff countdown expired during an outage; leaving the AC unchanged.');
      this.cancel();
      return;
    }
    let succeeded = false;
    try {
      succeeded = await this.options.turnOff(stillCurrent);
    } catch {
      // The next attempt reads the AC before deciding whether another off is needed.
    }
    if (!stillCurrent()) {
      return;
    }
    if (succeeded) {
      this.cancel();
    } else {
      if (!this.warned) {
        this.options.warn('Could not confirm timed shutoff; retrying for up to five minutes.');
        this.warned = true;
      }
      this.schedule(Math.min(retryMs, state.deadline + shutdownGraceMs - Date.now()));
    }
  }
}
