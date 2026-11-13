import type { RacStatus } from './racStatus';

interface Reading {
  source: string;
  temperature: number;
  active: boolean;
  observedAt: number;
}

/** One physical outdoor sensor, reported by several indoor units. Never average copies. */
export class SharedOutdoorTemperature {
  private readonly readings = new Map<string, Reading>();
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly maxAgeMs: number,
    private readonly hideWhenOff: boolean,
    private readonly onChange: () => void,
  ) {}

  update(source: string, status?: RacStatus, observedAt = 0): void {
    const temperature = status?.outdoorTemperature;
    if (status && status.connected !== false && Number.isFinite(temperature)
      && (temperature as number) >= -100 && (temperature as number) <= 100 && observedAt > 0) {
      this.readings.set(source, { source, temperature: temperature as number, active: status.active, observedAt });
    } else {
      this.readings.delete(source);
    }
    this.changed();
  }

  get hasReadings(): boolean {
    return this.readings.size > 0;
  }

  current(): Reading | undefined {
    const now = Date.now();
    const fresh = [...this.readings.values()].filter(reading =>
      now - reading.observedAt < this.maxAgeMs && (!this.hideWhenOff || reading.active));
    // Stable insertion order avoids alternating among copies every time one polls.
    // A running indoor unit is preferred when available.
    return fresh.find(reading => reading.active) ?? fresh[0];
  }

  stop(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private changed(): void {
    this.stop();
    this.onChange();
    const now = Date.now();
    const expiries = [...this.readings.values()]
      .map(reading => reading.observedAt + this.maxAgeMs).filter(expiry => expiry > now);
    if (expiries.length) {
      this.timer = setTimeout(() => this.changed(), Math.min(...expiries) - now);
      this.timer.unref();
    }
  }
}
