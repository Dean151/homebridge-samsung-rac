import type { Logging } from 'homebridge';
import { devicesFrom, RacDevicesResponse, RacStatus, RacStatusOptions, toRacStatus } from './racStatus';
import { fromCelsius, toCelsiusSetpoint, type TemperatureUnit } from './temperature';
import type { DeviceApi } from './transport/localApi';

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
  /**
   * Recompute `body` and `requested` against a fresh status, for a write whose
   * payload depends on something the unit reports — the scale its temperatures
   * are in, so far.
   *
   * This runs INSIDE the queued task, after applyChange() has already claimed
   * the write's place in the queue. Doing the same work in the setter would
   * mean awaiting before joining the queue, letting a setpoint slip behind a
   * power write that queued synchronously — and this hardware discards every
   * write except power while the unit is off.
   */
  resolve?: (status: RacStatus) => Pick<Change, 'body' | 'requested'>;
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
  /** How to read the unit's outdoor sensor; see RacStatusOptions. */
  outdoorTemperatureUnit?: RacStatusOptions['outdoorTemperatureUnit'];
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
   * Reads and writes share one queue. Writes are chained rather than dropped: a HomeKit scene
   * fires Active, mode and temperature together, and dropping the overlap
   * silently loses whichever the user cares about most.
   */
  private queue: Promise<unknown> = Promise.resolve();
  private queueVersion = 0;
  private pendingRead?: { version: number; promise: Promise<RacStatus> };
  private readFailures = 0;

  /** Includes failures served from the stale cache, so polling can back off. */
  get consecutiveReadFailures(): number {
    return this.readFailures;
  }

  private readonly cacheMs: number;
  private readonly maxStaleMs: number;
  private readonly settleMs: number;
  private readonly dedupMs: number;
  private readonly minWriteIntervalMs: number;
  private readonly label: string;
  private readonly statusOptions: RacStatusOptions;

  constructor(
    private readonly api: DeviceApi,
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
    this.statusOptions = { outdoorTemperatureUnit: options.outdoorTemperatureUnit };
  }

  // --- reads ---------------------------------------------------------------

  getStatus(): Promise<RacStatus> {
    if (this.pendingRead?.version === this.queueVersion) {
      return this.pendingRead.promise;
    }
    const promise = this.enqueue(() => this.readStatus());
    const pending = { version: this.queueVersion, promise };
    this.pendingRead = pending;
    const clear = () => {
      if (this.pendingRead === pending) {
        this.pendingRead = undefined;
      }
    };
    void promise.then(clear, clear);
    return promise;
  }

  /** Called only inside the operation queue, including command read-backs. */
  private async readStatus(): Promise<RacStatus> {
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

      const status = toRacStatus(device, this.statusOptions);
      this.logStatusChange(status);
      this.cached = status;
      this.cachedAt = Date.now();
      this.readFailures = 0;
      return this.cached;
    } catch (error) {
      this.readFailures++;
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

  /**
   * @param celsius the setpoint in Celsius, which is what everything above this
   * file speaks. A unit configured in Fahrenheit is written in Fahrenheit.
   */
  setTargetTemperature(celsius: number, temperatureId = '0'): Promise<ApplyResult> {
    // `desired` is what goes over the wire, in the unit's own scale; `requested`
    // is what that will read back as once parsed, which is what the read-back
    // check compares against. They differ on a Fahrenheit unit: its grid is
    // whole degrees F, coarser in places than the 0.5 °C HomeKit is offered, so
    // asking for 22.5 °C can only land on 22.8 °C. Comparing the read-back
    // against what we asked for would report that as a silently discarded write
    // — the one failure this plugin exists to detect — when the unit obeyed.
    const inUnit = (unit: TemperatureUnit) => {
      const desired = fromCelsius(celsius, unit);
      return {
        desired,
        body: { Temperatures: [{ id: temperatureId, desired }] },
        requested: toCelsiusSetpoint(desired, unit) as number,
      };
    };

    const celsiusUnit = inUnit('C');

    return this.applyChange({
      field: 'Temperatures[0].desired',
      read: (status) => status.targetTemperature,
      resource: `/devices/${this.deviceId}/temperatures/${temperatureId}`,
      // Celsius unless the unit says otherwise, which only a status read can
      // tell us — so resolve() settles it inside the write queue.
      body: celsiusUnit.body,
      requested: celsiusUnit.requested,
      resolve: ({ temperatureUnit }) => {
        const { desired, body, requested } = inUnit(temperatureUnit);
        if (temperatureUnit !== 'C') {
          this.log.debug(
            `${this.label} setpoint ${celsius}°C -> ${desired}°${temperatureUnit} `
            + `(reads back as ${requested}°C).`,
          );
        }
        return { body, requested };
      },
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

  /**
   * The convenience mode — `Comode` in `Mode.options`, where WindFree lives.
   *
   * Written as a SINGLE entry, which is the only shape that works: the flat
   * `{"options":[...]}` is ignored and echoing the whole array back is refused
   * outright. The other entries in the array are left alone by this.
   * Measured 2026-09-15; see notes/WRITE-SUPPORT.md.
   */
  setComode(value: string): Promise<ApplyResult> {
    return this.applyChange({
      field: 'Mode.options.Comode',
      resource: `/devices/${this.deviceId}/mode`,
      body: { Mode: { options: [`Comode_${value}`] } },
      requested: value,
      read: (status) => status.comode,
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

  /** A persistent setting, independent of the selected operating mode. */
  setAutoClean(on: boolean): Promise<ApplyResult> {
    const value = on ? 'On' : 'Off';
    return this.applyChange({
      field: 'Mode.options.Autoclean',
      resource: `/devices/${this.deviceId}/mode`,
      body: { Mode: { options: [`Autoclean_${value}`] } },
      requested: value,
      read: (status) => status.options.Autoclean,
    });
  }

  /** Timestamp of the last successful LAN read; cached fallback must not renew freshness. */
  get lastSuccessfulReadAt(): number {
    return this.cachedAt;
  }

  setSpi(on: boolean): Promise<ApplyResult> {
    const value = on ? 'On' : 'Off';
    return this.applyChange({
      field: 'Mode.options.Spi',
      resource: `/devices/${this.deviceId}/mode`,
      body: { Mode: { options: [`Spi_${value}`] } },
      requested: value,
      read: (status) => status.options.Spi,
    });
  }

  /** Native sleep mode, verified on TP6X_RAC_17K. Never cancel with Sleep_0: it powers off. */
  setGoodSleep(minutes: number | null): Promise<ApplyResult> {
    if (minutes !== null && minutes !== 60 && minutes !== 120) {
      return Promise.reject(new Error('Good Sleep supports the verified 60 or 120 minute durations.'));
    }
    this.queueVersion++;
    return this.enqueue(async () => {
      this.invalidate();
      const before = await this.readStatus();
      if (this.readFailures) {
        throw new Error('A fresh AC status is required before changing Good Sleep.');
      }
      if (before.model !== 'TP6X_RAC_17K' || !/^\d+$/.test(before.options.Sleep ?? '')) {
        throw new Error('Native Good Sleep has not been verified for this model.');
      }
      if (minutes !== null && (!before.active || before.mode !== 'Cool')) {
        throw new Error('Turn the AC on in Cool mode before starting Good Sleep.');
      }
      if (minutes === null && before.comode !== 'Sleep') {
        return { applied: true, requested: false, actual: false, status: before };
      }
      const requested = {
        active: before.active, comode: minutes === null ? 'Off' : 'Sleep',
        sleep: minutes === null ? '0' : String(minutes / 30),
      };
      // Stage the duration, enter Sleep, then set it explicitly while active.
      // The first duration write is not necessarily visible until the mode is active.
      // Keep the entire sequence in one queue slot so another control cannot split it.
      const tokens = minutes === null
        ? ['Comode_Off']
        : [`Sleep_${minutes / 30}`, 'Comode_Sleep', `Sleep_${minutes / 30}`];
      this.lastWrite = null;
      for (const token of tokens) {
        const remaining = this.minWriteIntervalMs - (Date.now() - this.lastWriteAt);
        if (remaining > 0) {
          await delay(remaining);
        }
        try {
          await this.api.put(`/devices/${this.deviceId}/mode`, { Mode: { options: [token] } });
        } finally {
          this.lastWriteAt = Date.now();
          this.invalidate();
        }
        await delay(this.settleMs);
      }
      const status = await this.readStatus();
      if (this.readFailures) {
        throw new Error('Could not confirm Good Sleep from a fresh status.');
      }
      const actual = { active: status.active, comode: status.comode, sleep: status.options.Sleep };
      const applied = JSON.stringify(actual) === JSON.stringify(requested);
      if (!applied) {
        this.log.warn(`${this.label}: Good Sleep was not confirmed; requested ${JSON.stringify(requested)}, got ${JSON.stringify(actual)}.`);
      }
      return { applied, requested, actual, status };
    });
  }

  /** Resolve inside the queue so simultaneous axis changes preserve each other. */
  setSwingAxis(axis: 'vertical' | 'horizontal', on: boolean): Promise<ApplyResult> {
    const direction = (current: string | undefined) => {
      if (!['Fix', 'Up_And_Low', 'Left_And_Right', 'All'].includes(current ?? '')) {
        throw new Error('The unit reports an unknown swing direction.');
      }
      const vertical = axis === 'vertical' ? on : current === 'Up_And_Low' || current === 'All';
      const horizontal = axis === 'horizontal' ? on : current === 'Left_And_Right' || current === 'All';
      return vertical ? (horizontal ? 'All' : 'Up_And_Low') : (horizontal ? 'Left_And_Right' : 'Fix');
    };
    return this.applyChange({
      field: 'Wind.direction',
      resource: `/devices/${this.deviceId}/wind`,
      body: {},
      requested: undefined,
      read: status => status.windDirection,
      resolve: status => {
        const requested = direction(status.windDirection);
        return { requested, body: { Wind: { direction: requested } } };
      },
    });
  }

  // --- the write path ------------------------------------------------------

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private applyChange(change: Change): Promise<ApplyResult> {
    // A read requested after this write must not join one queued before it.
    this.queueVersion++;
    return this.enqueue(() => this.write(change));
  }

  private async write(requested: Change): Promise<ApplyResult> {
    // Resolve before anything reads body or requested — including the dedup key,
    // which must key on the value that will actually go over the wire.
    if (requested.resolve && requested.field === 'Wind.direction') {
      this.invalidate();
    }
    const change: Change = requested.resolve
      ? { ...requested, ...requested.resolve(await this.readStatus()) }
      : requested;

    // The dedup key MUST include the value. Keying on the target alone makes
    // every slider drag send its first value and swallow the rest, which is
    // exactly the bug this plugin's predecessor shipped.
    const key = `${change.resource}|${change.field}|${JSON.stringify(change.requested)}`;
    const now = Date.now();

    if (this.lastWrite && this.lastWrite.key === key && now - this.lastWrite.at < this.dedupMs) {
      const status = await this.readStatus();
      const actual = change.read(status);
      if (JSON.stringify(actual) === JSON.stringify(change.requested)) {
        this.log.debug(`Skipping duplicate write ${key}`);
        return { applied: true, requested: change.requested, actual, status };
      }
    }
    this.lastWrite = null;

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
    const status = await this.readStatus();
    const actual = change.read(status);
    const applied = JSON.stringify(actual) === JSON.stringify(change.requested);

    if (!applied) {
      this.reportRejected(change, actual, status);
    } else {
      this.lastWrite = { key, at: Date.now() };
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
  'outdoorTemperature', 'comode', 'filterLife',
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
