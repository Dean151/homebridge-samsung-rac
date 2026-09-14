import type { Logging } from 'homebridge';
import { devicesFrom, RacDevicesResponse, RacStatus, toRacStatus } from './racStatus';
import { LocalApi } from './transport/localApi';

/**
 * The only thing that knows the local API's JSON shapes.
 *
 * Everything above this file speaks RacStatus and the semantic setters below,
 * which is what would let a SmartThings-cloud transport be dropped in later
 * without touching the HomeKit layer.
 */

export interface ApplyResult {
  /** True only when a read-back confirms the unit actually took the change. */
  applied: boolean;
  requested: unknown;
  actual: unknown;
  status: RacStatus;
}

interface Change {
  /** Human-readable target, used for logging and for warn-once bookkeeping. */
  field: string;
  resource: string;
  body: unknown;
  requested: unknown;
  read: (status: RacStatus) => unknown;
}

export interface DeviceAdapterOptions {
  /** How the unit is named in the log; defaults to its address. */
  label?: string;
  /** How long a status read stays fresh enough to reuse. */
  cacheMs?: number;
  /** Past this, a cached status is not served at all and the caller sees the error. */
  maxStaleMs?: number;
  /** How long to let the unit settle before reading a write back. */
  settleMs?: number;
  /** Identical writes repeated inside this window are dropped. */
  dedupMs?: number;
  /** Minimum spacing between writes. */
  minWriteIntervalMs?: number;
}

export class DeviceAdapter {
  private cached: RacStatus | null = null;
  private cachedAt = 0;
  private lastWriteAt = 0;
  private lastWrite: { key: string; at: number } | null = null;
  private warnedFields = new Set<string>();

  /** The first raw document is logged whole; after that only what changed is. */
  private loggedRawDocument = false;

  /**
   * Writes run one at a time, chained rather than dropped: a HomeKit scene
   * fires Active, mode and temperature together, and dropping the overlap
   * silently loses whichever the user cares about most.
   */
  private queue: Promise<unknown> = Promise.resolve();

  private readonly cacheMs: number;
  private readonly maxStaleMs: number;
  private readonly settleMs: number;
  private readonly dedupMs: number;
  private readonly minWriteIntervalMs: number;
  private readonly label: string;

  constructor(
    private readonly api: LocalApi,
    private readonly deviceId: string,
    private readonly log: Logging,
    options: DeviceAdapterOptions = {},
  ) {
    this.cacheMs = options.cacheMs ?? 3000;
    this.maxStaleMs = options.maxStaleMs ?? 60000;
    this.settleMs = options.settleMs ?? 1500;
    this.dedupMs = options.dedupMs ?? 1000;
    this.minWriteIntervalMs = options.minWriteIntervalMs ?? 250;
    this.label = options.label ?? api.description;
  }

  // --- reads ---------------------------------------------------------------

  async getStatus(): Promise<RacStatus> {
    const now = Date.now();
    if (this.cached && now - this.cachedAt < this.cacheMs) {
      return this.cached;
    }

    try {
      const response = await this.api.get<RacDevicesResponse>('/devices');
      const device = devicesFrom(response).find((candidate) => (candidate.id ?? '0') === this.deviceId)
        ?? devicesFrom(response)[0];

      if (!device) {
        throw new Error(`${this.api.description} reported no device with id ${this.deviceId}.`);
      }

      if (!this.loggedRawDocument) {
        // Once, in full: everything this plugin decides is derived from this
        // document, so a bug report is only actionable with it in hand.
        this.loggedRawDocument = true;
        this.log.debug(`${this.label} raw device document: ${JSON.stringify(device)}`);
      }

      const status = toRacStatus(device);
      this.logStatusChange(status);
      this.cached = status;
      this.cachedAt = now;
      return this.cached;
    } catch (error) {
      // Serving a slightly stale reading beats flapping the accessory on one
      // dropped packet — but only briefly. Past maxStaleMs the caller must see
      // the failure, or a unit that has been unplugged for an hour still shows
      // yesterday's temperature instead of "No Response".
      if (this.cached && Date.now() - this.cachedAt < this.maxStaleMs) {
        this.log.debug('Serving cached status after a failed read:', (error as Error).message);
        return this.cached;
      }
      throw error;
    }
  }

  invalidate(): void {
    this.cached = null;
    this.cachedAt = 0;
  }

  close(): void {
    this.api.close();
  }

  // --- semantic writes -----------------------------------------------------

  setPower(on: boolean): Promise<ApplyResult> {
    const power = on ? 'On' : 'Off';
    return this.applyChange({
      field: 'Operation.power',
      resource: `/devices/${this.deviceId}/operation`,
      body: { Operation: { power } },
      requested: power,
      read: (status) => (status.active ? 'On' : 'Off'),
    });
  }

  setMode(mode: string): Promise<ApplyResult> {
    return this.applyChange({
      field: 'Mode.modes',
      resource: `/devices/${this.deviceId}/mode`,
      body: { Mode: { modes: [mode] } },
      requested: mode,
      read: (status) => status.mode,
    });
  }

  setTargetTemperature(temperature: number, temperatureId = '0'): Promise<ApplyResult> {
    return this.applyChange({
      field: 'Temperatures[0].desired',
      resource: `/devices/${this.deviceId}/temperatures/${temperatureId}`,
      body: { Temperatures: [{ id: temperatureId, desired: temperature }] },
      requested: temperature,
      read: (status) => status.targetTemperature,
    });
  }

  setSpeedLevel(level: number): Promise<ApplyResult> {
    return this.applyChange({
      field: 'Wind.speedLevel',
      resource: `/devices/${this.deviceId}/wind`,
      body: { Wind: { speedLevel: level } },
      requested: level,
      read: (status) => status.speedLevel,
    });
  }

  setWindDirection(direction: string): Promise<ApplyResult> {
    return this.applyChange({
      field: 'Wind.direction',
      resource: `/devices/${this.deviceId}/wind`,
      body: { Wind: { direction } },
      requested: direction,
      read: (status) => status.windDirection,
    });
  }

  // --- the write path ------------------------------------------------------

  private applyChange(change: Change): Promise<ApplyResult> {
    const run = this.queue.then(
      () => this.write(change),
      () => this.write(change),
    );
    // Keep the chain alive regardless of outcome, but don't leave an unhandled
    // rejection behind on the internal handle.
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async write(change: Change): Promise<ApplyResult> {
    // The dedup key MUST include the value. Keying on the target alone makes
    // every slider drag send its first value and swallow the rest, which is
    // exactly the bug this plugin's predecessor shipped.
    const key = `${change.resource}|${change.field}|${JSON.stringify(change.requested)}`;
    const now = Date.now();

    if (this.lastWrite && this.lastWrite.key === key && now - this.lastWrite.at < this.dedupMs) {
      this.log.debug(`Skipping duplicate write ${key}`);
      return { applied: true, requested: change.requested, actual: change.requested, status: await this.getStatus() };
    }
    this.lastWrite = { key, at: now };

    const sinceLastWrite = now - this.lastWriteAt;
    if (sinceLastWrite < this.minWriteIntervalMs) {
      await delay(this.minWriteIntervalMs - sinceLastWrite);
    }

    this.log.debug(`${this.label} writing ${change.field} = ${format(change.requested)}`);

    try {
      await this.api.put(change.resource, change.body);
    } finally {
      this.lastWriteAt = Date.now();
    }

    // HTTP 200 proves nothing on this hardware: the SmartThings cloud returns
    // COMPLETED for commands the unit silently discards, and there is no reason
    // to assume the local API is more honest. Confirm by reading back.
    await delay(this.settleMs);
    this.invalidate();
    const status = await this.getStatus();
    const actual = change.read(status);
    const applied = JSON.stringify(actual) === JSON.stringify(change.requested);

    if (!applied) {
      this.reportRejected(change, actual, status);
    } else {
      this.log.debug(`${this.label} confirmed ${change.field} = ${format(actual)}.`);
      this.warnedFields.delete(change.field);
    }

    return { applied, requested: change.requested, actual, status };
  }

  /**
   * Poll-by-poll noise is useless; a line per actual change is a usable history
   * of what the unit did, including changes made from the remote or the app.
   */
  private logStatusChange(next: RacStatus): void {
    const previous = this.cached;
    if (!previous) {
      this.log.debug(`${this.label} status: ${describe(next)}`);
      return;
    }

    const changes: string[] = [];
    for (const field of trackedFields) {
      const before = previous[field];
      const after = next[field];
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        changes.push(`${field} ${format(before)} -> ${format(after)}`);
      }
    }

    if (changes.length) {
      this.log.debug(`${this.label} changed: ${changes.join(', ')}`);
    }
  }

  private reportRejected(change: Change, actual: unknown, status: RacStatus): void {
    // A powered-off unit buffers some changes and applies them at power-on, so
    // a mismatch there is expected rather than a failure.
    if (!status.active) {
      this.log.debug(
        `${change.field} still reads ${JSON.stringify(actual)} while the unit is off; `
        + `${JSON.stringify(change.requested)} may apply at power-on.`,
      );
      return;
    }

    if (this.warnedFields.has(change.field)) {
      this.log.debug(`${change.field} rejected ${JSON.stringify(change.requested)} again.`);
      return;
    }
    this.warnedFields.add(change.field);

    this.log.warn(
      `The air conditioner accepted a write to ${change.field} and did not apply it: asked for `
      + `${JSON.stringify(change.requested)}, still reads ${JSON.stringify(actual)}. HomeKit will be corrected to `
      + 'match the unit. This model silently discards some commands; the value may only be settable from the '
      + 'Samsung app.',
    );
  }
}

/** The fields worth a log line when they move; the rest never change in practice. */
const trackedFields = [
  'active', 'mode', 'currentTemperature', 'targetTemperature',
  'speedLevel', 'windDirection', 'filterAlarm', 'connected',
] as const satisfies readonly (keyof RacStatus)[];

function format(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
}

function describe(status: RacStatus): string {
  return trackedFields.map((field) => `${field}=${format(status[field])}`).join(' ');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
