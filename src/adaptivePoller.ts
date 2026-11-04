import type { RacStatus } from './racStatus';

/** Control changes start follow-up checks; sensor drift and usage counters do not. */
export function controlFingerprint(status: RacStatus): string {
  return JSON.stringify([
    status.active, status.mode, status.targetTemperature, status.speedLevel,
    status.windDirection, status.comode, status.options.Autoclean, status.options.Spi,
  ]);
}

/** Schedule from completion, so a slow request never creates overlapping polls. */
export class AdaptivePoller {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private running = false;
  private failures = 0;
  private activeUntil = 0;

  constructor(
    private readonly normalMs: number,
    private readonly adaptive: boolean,
    private readonly poll: () => Promise<boolean>,
  ) {}

  start(healthy = true): void {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    this.failures = healthy ? 0 : 1;
    this.schedule();
  }

  /** Called after a confirmed HomeKit command or an observed control change. */
  activity(): void {
    if (this.stopped || !this.adaptive) {
      return;
    }
    this.activeUntil = Date.now() + 30000;
    this.failures = 0;
    if (!this.running) {
      this.schedule();
    }
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    clearTimeout(this.timer);
    if (this.stopped) {
      return;
    }
    let delay = this.normalMs;
    if (this.adaptive) {
      if (this.failures > 0) {
        const cap = Math.max(this.normalMs, 60000);
        delay = Math.min(cap, this.normalMs * 2 ** Math.min(this.failures, 10));
      } else if (Date.now() + 2000 <= this.activeUntil) {
        delay = Math.min(this.normalMs, 2000);
      }
    }
    this.timer = setTimeout(() => { void this.run(); }, delay);
    this.timer.unref();
  }

  private async run(): Promise<void> {
    if (this.stopped || this.running) {
      return;
    }
    this.running = true;
    try {
      if (await this.poll()) {
        this.failures = 0;
      } else {
        this.failures++;
        this.activeUntil = 0;
      }
    } catch {
      this.failures++;
      this.activeUntil = 0;
    } finally {
      this.running = false;
      this.schedule();
    }
  }
}
