import { DeviceAdapter, DeviceAdapterOptions } from '../../src/deviceAdapter';
import type { RacDeviceDocument } from '../../src/racStatus';

function baseDocument(): RacDeviceDocument {
  return {
    id: '0',
    uuid: 'C0972767-7559-0000-0000-000000000000',
    name: 'RAC',
    description: 'TP6X_RAC_16K',
    connected: true,
    resources: ['Alarms', 'Mode', 'Operation', 'Temperatures', 'Wind'],
    Alarms: [],
    Mode: { modes: ['Cool'], supportedModes: ['Cool', 'Dry', 'Wind', 'Auto'], options: [] },
    Operation: { power: 'On' },
    Temperatures: [{ id: '0', current: 23, desired: 24, minimum: 16, maximum: 30, unit: 'Celsius' }],
    Wind: { direction: 'Fix', speedLevel: 0, maxSpeedLevel: 4 },
  };
}

interface Harness {
  adapter: DeviceAdapter;
  put: jest.Mock;
  get: jest.Mock;
  log: { debug: jest.Mock; info: jest.Mock; warn: jest.Mock; error: jest.Mock };
  document: RacDeviceDocument;
  /** Make the unit accept writes by mutating the document the reads return. */
  applyWrites: (apply: (body: any, document: RacDeviceDocument) => void) => void;
}

function build(options: DeviceAdapterOptions = {}): Harness {
  const document = baseDocument();
  let onWrite: ((body: any, document: RacDeviceDocument) => void) | null = null;

  const get = jest.fn(async () => ({ Devices: [document] }));
  const put = jest.fn(async (_path: string, body: unknown) => {
    onWrite?.(body, document);
    return '';
  });

  const log = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const api = { get, put, close: jest.fn(), description: '10.0.0.1:8888' };

  const adapter = new DeviceAdapter(api as never, '0', log as never, {
    settleMs: 0,
    minWriteIntervalMs: 0,
    cacheMs: 0,
    ...options,
  });

  return {
    adapter, put, get, log, document,
    applyWrites: (apply) => {
      onWrite = apply;
    },
  };
}

describe('debug logging', () => {
  const lines = (log: { debug: jest.Mock }) => log.debug.mock.calls.map((call) => call.join(' '));

  it('dumps the raw device document once, not on every poll', async () => {
    const { adapter, log } = build();

    await adapter.getStatus();
    await adapter.getStatus();

    expect(lines(log).filter((line) => line.includes('raw device document'))).toHaveLength(1);
  });

  it('logs what changed between two reads, and nothing when nothing did', async () => {
    const { adapter, log, document } = build();

    await adapter.getStatus();
    log.debug.mockClear();

    await adapter.getStatus();
    expect(lines(log).filter((line) => line.includes('changed:'))).toHaveLength(0);

    document.Operation = { power: 'Off' };
    document.Temperatures = [{ id: '0', current: 22, desired: 24, minimum: 16, maximum: 30 }];
    await adapter.getStatus();

    const changed = lines(log).find((line) => line.includes('changed:'));
    expect(changed).toContain('active true -> false');
    expect(changed).toContain('currentTemperature 23 -> 22');
  });

  it('names the unit the way the log does', async () => {
    const { adapter, log } = build({ label: 'Living room AC' });

    await adapter.getStatus();

    expect(lines(log).some((line) => line.startsWith('Living room AC'))).toBe(true);
  });
});

describe('reads', () => {
  it('parses the device the unit reports', async () => {
    const { adapter } = build();
    await expect(adapter.getStatus()).resolves.toMatchObject({ mode: 'Cool', active: true, maxSpeedLevel: 4 });
  });

  it('reuses a fresh status instead of hitting the unit again', async () => {
    const { adapter, get } = build({ cacheMs: 10000 });
    await adapter.getStatus();
    await adapter.getStatus();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('serves the last good status through a brief failure', async () => {
    const { adapter, get } = build({ maxStaleMs: 60000 });
    await adapter.getStatus();

    get.mockRejectedValueOnce(new Error('ETIMEDOUT'));
    await expect(adapter.getStatus()).resolves.toMatchObject({ mode: 'Cool' });
  });

  it('stops serving a status that has gone stale, so HomeKit can show No Response', async () => {
    const { adapter, get } = build({ maxStaleMs: 0 });
    await adapter.getStatus();

    get.mockRejectedValue(new Error('ETIMEDOUT'));
    await expect(adapter.getStatus()).rejects.toThrow('ETIMEDOUT');
  });
});

describe('write deduplication', () => {
  it('sends every value of a slider drag', async () => {
    // The dedup key has to include the value. Keying on the target alone sent
    // the first value of a drag and swallowed the rest, and the Home app tile
    // snapped back to it.
    const { adapter, put, applyWrites } = build({ dedupMs: 10000 });
    applyWrites((body, document) => {
      document.Temperatures![0].desired = body.Temperatures[0].desired;
    });

    await adapter.setTargetTemperature(24);
    await adapter.setTargetTemperature(23);
    await adapter.setTargetTemperature(22);

    expect(put).toHaveBeenCalledTimes(3);
    expect(put.mock.calls.map((call) => call[1].Temperatures[0].desired)).toEqual([24, 23, 22]);
  });

  it('drops a genuinely identical repeat inside the window', async () => {
    const { adapter, put, applyWrites } = build({ dedupMs: 10000 });
    applyWrites((body, document) => {
      document.Wind!.direction = body.Wind.direction;
    });

    await adapter.setWindDirection('Up_And_Low');
    await adapter.setWindDirection('Up_And_Low');

    expect(put).toHaveBeenCalledTimes(1);
  });

  it('keeps writes to different fields apart', async () => {
    const { adapter, put } = build({ dedupMs: 10000 });
    await adapter.setSpeedLevel(2);
    await adapter.setWindDirection('Up_And_Low');
    expect(put).toHaveBeenCalledTimes(2);
  });
});

describe('write verification', () => {
  it('confirms a write by reading it back', async () => {
    const { adapter, applyWrites } = build();
    applyWrites((body, document) => {
      document.Wind!.direction = body.Wind.direction;
    });

    const result = await adapter.setWindDirection('Up_And_Low');
    expect(result).toMatchObject({ applied: true, requested: 'Up_And_Low', actual: 'Up_And_Low' });
  });

  it('reports a write the unit accepted and discarded', async () => {
    // HTTP 200 proves nothing on this hardware; only a changed read-back does.
    const { adapter, log } = build();

    const result = await adapter.setWindDirection('Up_And_Low');

    expect(result).toMatchObject({ applied: false, requested: 'Up_And_Low', actual: 'Fix' });
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toContain('Wind.direction');
  });

  it('warns once per field rather than on every poll', async () => {
    const { adapter, log } = build();
    await adapter.setWindDirection('Up_And_Low');
    await adapter.setWindDirection('Vertical');
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('stays quiet about a mismatch while the unit is off, which it buffers', async () => {
    const { adapter, log, document } = build();
    document.Operation!.power = 'Off';

    const result = await adapter.setWindDirection('Up_And_Low');

    expect(result.applied).toBe(false);
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalled();
  });
});

describe('concurrency', () => {
  it('queues overlapping writes instead of dropping them', async () => {
    // A HomeKit scene fires Active, mode and temperature at once. Dropping the
    // overlap loses whichever the user cared about most.
    const { adapter, put, applyWrites } = build();
    applyWrites((body, document) => {
      if (body.Operation) {
        document.Operation!.power = body.Operation.power;
      }
      if (body.Mode) {
        document.Mode!.modes = body.Mode.modes;
      }
      if (body.Temperatures) {
        document.Temperatures![0].desired = body.Temperatures[0].desired;
      }
    });

    const results = await Promise.all([
      adapter.setPower(true),
      adapter.setMode('Auto'),
      adapter.setTargetTemperature(21),
    ]);

    expect(put).toHaveBeenCalledTimes(3);
    expect(results.every((result) => result.applied)).toBe(true);
  });

  it('keeps running after one write fails', async () => {
    const { adapter, put, applyWrites } = build();
    applyWrites((body, document) => {
      if (body.Wind) {
        document.Wind!.direction = body.Wind.direction;
      }
    });
    put.mockRejectedValueOnce(new Error('EHOSTUNREACH'));

    await expect(adapter.setPower(true)).rejects.toThrow('EHOSTUNREACH');
    await expect(adapter.setWindDirection('Vertical')).resolves.toMatchObject({ applied: true });
  });
});

describe('a unit configured in Fahrenheit', () => {
  /** The same reference unit, switched to the scale a US install would report. */
  function fahrenheit(harness: Harness): Harness {
    harness.document.Temperatures = [
      { id: '0', current: 71, desired: 75, minimum: 60, maximum: 86, unit: 'Fahrenheit' },
    ];
    harness.applyWrites((body, document) => {
      document.Temperatures![0].desired = body.Temperatures[0].desired;
    });
    return harness;
  }

  it('reports its temperatures in Celsius', async () => {
    const { adapter } = fahrenheit(build());

    const status = await adapter.getStatus();
    expect(status.temperatureUnit).toBe('F');
    expect(status.currentTemperature).toBeCloseTo(21.7, 5);
    expect(status.targetTemperature).toBe(24);
    expect(status.minSetpoint).toBe(15.5);
    expect(status.maxSetpoint).toBe(30);
  });

  it('writes the setpoint in Fahrenheit, not the Celsius it was given', async () => {
    const { adapter, put } = fahrenheit(build());

    await adapter.setTargetTemperature(24);

    expect(put.mock.calls[0][1]).toEqual({ Temperatures: [{ id: '0', desired: 75 }] });
  });

  it('does not report a write as discarded when the device grid rounds it', async () => {
    // 22.5°C is 72.5°F, which the unit stores as 73°F and reads back as 23°C.
    // Comparing the read-back against the 22.5 we asked for would call this a
    // silently discarded write — the exact failure the read-back exists to
    // catch — when the unit did precisely what it was told.
    const { adapter, log } = fahrenheit(build());

    const result = await adapter.setTargetTemperature(22.5);

    expect(result.applied).toBe(true);
    expect(result.actual).toBe(23);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('still catches a setpoint the unit really does discard', async () => {
    const { adapter, log, applyWrites } = fahrenheit(build());
    applyWrites(() => undefined); // accept the PUT, change nothing.

    const result = await adapter.setTargetTemperature(20);

    expect(result.applied).toBe(false);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toContain('Temperatures[0].desired');
  });

  it('keeps writes in the order they were called, whatever the scale', async () => {
    // Knowing the scale needs a status read, and doing that read before joining
    // the write queue would let every other write overtake the setpoint. Order
    // is load-bearing here: this unit discards everything except power while it
    // is off, so a scene's writes landing out of order are silently lost.
    const harness = fahrenheit(build());
    harness.applyWrites((body, document) => {
      if (body.Operation) {
        document.Operation!.power = body.Operation.power;
      }
      if (body.Temperatures) {
        document.Temperatures![0].desired = body.Temperatures[0].desired;
      }
    });

    await Promise.all([
      harness.adapter.setTargetTemperature(24),
      harness.adapter.setPower(true),
    ]);

    expect(harness.put.mock.calls.map((call) => call[0])).toEqual([
      '/devices/0/temperatures/0',
      '/devices/0/operation',
    ]);
    expect(harness.put.mock.calls[0][1]).toEqual({ Temperatures: [{ id: '0', desired: 75 }] });
  });

  it('leaves a Celsius unit writing exactly what it was asked for', async () => {
    const { adapter, put, applyWrites } = build();
    applyWrites((body, document) => {
      document.Temperatures![0].desired = body.Temperatures[0].desired;
    });

    const result = await adapter.setTargetTemperature(22);

    expect(put.mock.calls[0][1]).toEqual({ Temperatures: [{ id: '0', desired: 22 }] });
    expect(result).toMatchObject({ applied: true, actual: 22 });
  });
});
