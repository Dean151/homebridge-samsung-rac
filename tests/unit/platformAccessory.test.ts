import { SamsungRacAccessory } from '../../src/platformAccessory';
import type { RacStatus } from '../../src/racStatus';
import {
  Characteristic, FakeAccessory, FakeHapStatusError, FakeService, HAPStatus, Service,
} from '../mocks/hap.mock';

/** Mirrors what the reference TP6X_RAC_16K actually reports. */
const baseStatus: RacStatus = {
  active: true,
  mode: 'Cool',
  supportedModes: ['Cool', 'Dry', 'Wind', 'Auto'],
  currentTemperature: 23,
  targetTemperature: 24,
  temperatureId: '0',
  temperatureUnit: 'C',
  minSetpoint: 16,
  maxSetpoint: 30,
  windDirection: 'Fix',
  speedLevel: 0,
  maxSpeedLevel: 4,
  filterAlarm: false,
  resources: ['Alarms', 'Mode', 'Operation', 'Temperatures', 'Wind'],
  options: {},
  connected: true,
  id: '0',
  uuid: 'C0972767-7559-0000-0000-000000000000',
  name: 'RAC',
  model: 'TP6X_RAC_16K',
};

interface Harness {
  accessory: FakeAccessory;
  heaterCooler: FakeService;
  adapter: Record<string, jest.Mock>;
  log: { debug: jest.Mock; info: jest.Mock; warn: jest.Mock; error: jest.Mock };
  setStatus: (status: Partial<RacStatus>) => void;
}

async function build(options: {
  status?: Partial<RacStatus>;
  settings?: Record<string, unknown>;
  accessory?: FakeAccessory;
  failReads?: boolean;
} = {}): Promise<Harness> {
  let status: RacStatus = { ...baseStatus, ...options.status };

  const log = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const getStatus = jest.fn(async () => {
    if (options.failReads) {
      throw new Error('ETIMEDOUT');
    }
    return status;
  });

  // Every setter resolves to "the unit took it", unless a test overrides it.
  const applied = (requested: unknown) => async () => ({ applied: true, requested, actual: requested, status });

  const adapter = {
    getStatus,
    setPower: jest.fn(applied(true)),
    setMode: jest.fn(applied('Auto')),
    setTargetTemperature: jest.fn(applied(22)),
    setSpeedLevel: jest.fn(applied(2)),
    setWindDirection: jest.fn(applied('Up_And_Low')),
    close: jest.fn(),
  };

  const accessory = options.accessory ?? new FakeAccessory();

  const platform = {
    Service,
    Characteristic,
    log,
    api: { hap: { HapStatusError: FakeHapStatusError, HAPStatus } },
    // A long interval keeps the poll timer from firing on its own mid-test.
    settings: { updateInterval: 3600, swingDirection: 'Up_And_Low', ...options.settings },
  };

  await SamsungRacAccessory.create(platform as never, accessory as never, adapter as never);

  return {
    accessory,
    heaterCooler: accessory.getService(Service.HeaterCooler) as FakeService,
    adapter: adapter as unknown as Record<string, jest.Mock>,
    log,
    setStatus: (next) => {
      status = { ...status, ...next };
    },
  };
}

/** Drive one poll cycle the way the accessory's own interval would. */
async function pollOnce(getStatus: jest.Mock): Promise<void> {
  const before = getStatus.mock.calls.length;
  jest.advanceTimersByTime(3600 * 1000);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(getStatus.mock.calls.length).toBeGreaterThan(before);
}

describe('SamsungRacAccessory', () => {
  beforeEach(() => {
    // The poll interval is armed in initialize(), so the fake clock has to be
    // in place before any harness is built.
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  describe('temperature', () => {
    it('takes the setpoint range from the unit rather than hardcoding it', async () => {
      const { heaterCooler } = await build({ status: { minSetpoint: 18, maxSetpoint: 26 } });
      expect(heaterCooler.findCharacteristic(Characteristic.CoolingThresholdTemperature)?.props)
        .toMatchObject({ minValue: 18, maxValue: 26, minStep: 1 });
    });

    it('caps the heating threshold at what HomeKit allows', async () => {
      const { heaterCooler } = await build();
      expect(heaterCooler.findCharacteristic(Characteristic.HeatingThresholdTemperature)?.props)
        .toMatchObject({ maxValue: 25 });
    });

    it('reports the measured temperature without clamping it to the setpoint range', async () => {
      const { heaterCooler } = await build({ status: { currentTemperature: 9 } });
      expect(heaterCooler.findCharacteristic(Characteristic.CurrentTemperature)?.getHandler?.()).toBe(9);
    });

    it('offers half-degree steps on a Fahrenheit unit, so every setpoint is reachable', async () => {
      // A whole degree F is 0.56°C. A 1°C step would put roughly half the
      // values the unit can actually hold out of the user's reach.
      const { heaterCooler } = await build({
        status: { temperatureUnit: 'F', minSetpoint: 15.5, maxSetpoint: 30 },
      });

      expect(heaterCooler.findCharacteristic(Characteristic.CoolingThresholdTemperature)?.props)
        .toMatchObject({ minValue: 15.5, maxValue: 30, minStep: 0.5 });
    });

    it('sends a Fahrenheit unit a setpoint on the half-degree grid, not a whole one', async () => {
      const { heaterCooler, adapter } = await build({
        status: { temperatureUnit: 'F', minSetpoint: 15.5, maxSetpoint: 30 },
      });

      await heaterCooler.findCharacteristic(Characteristic.CoolingThresholdTemperature)?.setHandler?.(22.5);

      // Rounding to a whole degree here would discard the finer grid the
      // characteristic was just told about.
      expect(adapter.setTargetTemperature).toHaveBeenCalledWith(22.5, '0');
    });

    it('still sends whole degrees to a Celsius unit', async () => {
      const { heaterCooler, adapter } = await build();

      await heaterCooler.findCharacteristic(Characteristic.CoolingThresholdTemperature)?.setHandler?.(22.4);

      expect(adapter.setTargetTemperature).toHaveBeenCalledWith(22, '0');
    });

    it('keeps the configured range when the unit reports an unusable one', async () => {
      const { heaterCooler, log } = await build({ status: { minSetpoint: 30, maxSetpoint: 16 } });
      expect(log.warn).toHaveBeenCalled();
      expect(heaterCooler.findCharacteristic(Characteristic.CoolingThresholdTemperature)?.props)
        .toEqual({});
    });
  });

  describe('modes', () => {
    it('does not offer HEAT on a unit that cannot heat', async () => {
      const { heaterCooler } = await build();
      expect(heaterCooler.findCharacteristic(Characteristic.TargetHeaterCoolerState)?.props.validValues)
        .toEqual([Characteristic.TargetHeaterCoolerState.AUTO, Characteristic.TargetHeaterCoolerState.COOL]);
    });

    it('offers HEAT when the unit says it supports it', async () => {
      const { heaterCooler } = await build({ status: { supportedModes: ['Cool', 'Heat', 'Auto'] } });
      expect(heaterCooler.findCharacteristic(Characteristic.TargetHeaterCoolerState)?.props.validValues)
        .toEqual([0, 1, 2]);
    });

    it('reports Dry as AUTO and IDLE, since HomeKit has no slot for it', async () => {
      const { heaterCooler } = await build({ status: { mode: 'Dry' } });
      expect(heaterCooler.findCharacteristic(Characteristic.TargetHeaterCoolerState)?.getHandler?.())
        .toBe(Characteristic.TargetHeaterCoolerState.AUTO);
      expect(heaterCooler.findCharacteristic(Characteristic.CurrentHeaterCoolerState)?.getHandler?.())
        .toBe(Characteristic.CurrentHeaterCoolerState.IDLE);
    });

    it('is INACTIVE when the unit is off, whatever mode it remembers', async () => {
      const { heaterCooler } = await build({ status: { active: false } });
      expect(heaterCooler.findCharacteristic(Characteristic.CurrentHeaterCoolerState)?.getHandler?.())
        .toBe(Characteristic.CurrentHeaterCoolerState.INACTIVE);
    });

    it('writes the mode using the unit\'s own casing', async () => {
      const { heaterCooler, adapter } = await build({ status: { mode: 'Cool' } });
      await heaterCooler.findCharacteristic(Characteristic.TargetHeaterCoolerState)
        ?.setHandler?.(Characteristic.TargetHeaterCoolerState.AUTO);
      expect(adapter.setMode).toHaveBeenCalledWith('Auto');
    });

    it('leaves a unit sitting in Wind alone when HomeKit asks for AUTO', async () => {
      // Wind and Dry both surface as AUTO, so sending 'Auto' here would kick the
      // unit out of a mode the user chose in the Samsung app.
      const { heaterCooler, adapter } = await build({ status: { mode: 'Wind' } });
      await heaterCooler.findCharacteristic(Characteristic.TargetHeaterCoolerState)
        ?.setHandler?.(Characteristic.TargetHeaterCoolerState.AUTO);
      expect(adapter.setMode).not.toHaveBeenCalled();
    });
  });

  describe('fan speed', () => {
    it('builds a grid-aligned scale from the unit\'s level count', async () => {
      const { heaterCooler } = await build();
      expect(heaterCooler.findCharacteristic(Characteristic.RotationSpeed)?.props)
        .toMatchObject({ minValue: 0, maxValue: 100, minStep: 25 });
    });

    it('maps levels to percentages and back', async () => {
      const { heaterCooler, adapter } = await build({ status: { speedLevel: 3 } });
      expect(heaterCooler.findCharacteristic(Characteristic.RotationSpeed)?.getHandler?.()).toBe(75);

      await heaterCooler.findCharacteristic(Characteristic.RotationSpeed)?.setHandler?.(50);
      expect(adapter.setSpeedLevel).toHaveBeenCalledWith(2);
    });

    it('treats level 0 as a real reading rather than a missing one', async () => {
      const { heaterCooler } = await build({ status: { speedLevel: 0 } });
      expect(heaterCooler.findCharacteristic(Characteristic.RotationSpeed)).toBeDefined();
    });

    it('stays away when the unit reports no fan levels', async () => {
      const { heaterCooler } = await build({ status: { maxSpeedLevel: undefined, speedLevel: undefined } });
      expect(heaterCooler.findCharacteristic(Characteristic.RotationSpeed)).toBeUndefined();
    });
  });

  describe('swing', () => {
    it('reads Fix as swing off', async () => {
      const { heaterCooler } = await build();
      expect(heaterCooler.findCharacteristic(Characteristic.SwingMode)?.getHandler?.())
        .toBe(Characteristic.SwingMode.SWING_DISABLED);
    });

    it('reads any other vane position as swing on', async () => {
      const { heaterCooler } = await build({ status: { windDirection: 'Up_And_Low' } });
      expect(heaterCooler.findCharacteristic(Characteristic.SwingMode)?.getHandler?.())
        .toBe(Characteristic.SwingMode.SWING_ENABLED);
    });

    it('writes the configured direction when switched on, and Fix when switched off', async () => {
      const { heaterCooler, adapter } = await build({ settings: { swingDirection: 'Vertical' } });
      const swing = heaterCooler.findCharacteristic(Characteristic.SwingMode);

      await swing?.setHandler?.(Characteristic.SwingMode.SWING_ENABLED);
      expect(adapter.setWindDirection).toHaveBeenCalledWith('Vertical');

      await swing?.setHandler?.(Characteristic.SwingMode.SWING_DISABLED);
      expect(adapter.setWindDirection).toHaveBeenCalledWith('Fix');
    });

    it('stays away when the unit reports no vane position', async () => {
      const { heaterCooler } = await build({ status: { windDirection: undefined } });
      expect(heaterCooler.findCharacteristic(Characteristic.SwingMode)).toBeUndefined();
    });

    it('corrects HomeKit when the unit accepts a write and discards it', async () => {
      // The whole point of the read-back: the tile must snap back to reality
      // rather than showing a value the unit never took.
      const { heaterCooler, adapter } = await build();
      const swing = heaterCooler.findCharacteristic(Characteristic.SwingMode);

      adapter.setWindDirection.mockResolvedValueOnce({
        applied: false,
        requested: 'Up_And_Low',
        actual: 'Fix',
        status: { ...baseStatus, windDirection: 'Fix' },
      });

      await swing?.setHandler?.(Characteristic.SwingMode.SWING_ENABLED);
      expect(swing?.value).toBe(Characteristic.SwingMode.SWING_DISABLED);
    });
  });

  describe('filter', () => {
    it('publishes a linked filter service when the unit exposes alarms', async () => {
      const { accessory, heaterCooler } = await build();
      const filter = accessory.getService(Service.FilterMaintenance);
      expect(filter).toBeDefined();
      expect(heaterCooler.linkedServices).toContain(filter);
    });

    it('reports a filter alarm', async () => {
      const { accessory } = await build({ status: { filterAlarm: true } });
      expect(accessory.getService(Service.FilterMaintenance)
        ?.findCharacteristic(Characteristic.FilterChangeIndication)?.getHandler?.())
        .toBe(Characteristic.FilterChangeIndication.CHANGE_FILTER);
    });

    it('stays away when the unit has no Alarms resource', async () => {
      const { accessory } = await build({ status: { resources: ['Mode', 'Wind'] } });
      expect(accessory.getService(Service.FilterMaintenance)).toBeUndefined();
    });
  });

  describe('late capabilities', () => {
    it('adds swing once the unit starts reporting a vane position', async () => {
      const { heaterCooler, adapter, setStatus } = await build({ status: { windDirection: undefined } });
      expect(heaterCooler.findCharacteristic(Characteristic.SwingMode)).toBeUndefined();

      setStatus({ windDirection: 'Fix' });
      await pollOnce(adapter.getStatus);

      expect(heaterCooler.findCharacteristic(Characteristic.SwingMode)).toBeDefined();
    });

    it('adds fan speed once the unit starts reporting levels', async () => {
      const { heaterCooler, adapter, setStatus } = await build({
        status: { maxSpeedLevel: undefined, speedLevel: undefined },
      });
      expect(heaterCooler.findCharacteristic(Characteristic.RotationSpeed)).toBeUndefined();

      setStatus({ maxSpeedLevel: 4, speedLevel: 1 });
      await pollOnce(adapter.getStatus);

      expect(heaterCooler.findCharacteristic(Characteristic.RotationSpeed)?.props).toMatchObject({ minStep: 25 });
    });

    it('does not withdraw a service when the reading goes missing again', async () => {
      // Flapping would re-announce the accessory configuration to HomeKit on
      // every poll, which is worse than a stale-looking tile.
      const { heaterCooler, adapter, setStatus } = await build();
      expect(heaterCooler.findCharacteristic(Characteristic.SwingMode)).toBeDefined();

      setStatus({ windDirection: undefined });
      await pollOnce(adapter.getStatus);

      expect(heaterCooler.findCharacteristic(Characteristic.SwingMode)).toBeDefined();
    });

    it('does not treat its own startup configuration as a late arrival', async () => {
      // initialize() reads status *before* configuring anything, so an
      // unguarded adopt step announces capabilities that were there all along.
      const { log, adapter } = await build();
      expect(log.info.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('now reported')))
        .toEqual([]);

      const before = log.info.mock.calls.length;
      await pollOnce(adapter.getStatus);
      expect(log.info.mock.calls.slice(before)).toEqual([]);
    });
  });

  describe('responsiveness', () => {
    it('reports No Response until a status has actually been read', async () => {
      const { heaterCooler } = await build({ failReads: true });
      expect(() => heaterCooler.findCharacteristic(Characteristic.Active)?.getHandler?.())
        .toThrow(FakeHapStatusError);
    });

    it('recovers once the unit answers again', async () => {
      const status = { ...baseStatus };
      const log = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
      let fail = true;
      const getStatus = jest.fn(async () => {
        if (fail) {
          throw new Error('ETIMEDOUT');
        }
        return status;
      });

      const accessory = new FakeAccessory();
      await SamsungRacAccessory.create(
        {
          Service, Characteristic, log,
          api: { hap: { HapStatusError: FakeHapStatusError, HAPStatus } },
          settings: { updateInterval: 3600, swingDirection: 'Up_And_Low' },
        } as never,
        accessory as never,
        { getStatus, close: jest.fn() } as never,
      );

      fail = false;
      await pollOnce(getStatus);

      const heaterCooler = accessory.getService(Service.HeaterCooler) as FakeService;
      expect(heaterCooler.findCharacteristic(Characteristic.Active)?.getHandler?.())
        .toBe(Characteristic.Active.ACTIVE);
    });

    it('warns once for an outage and announces the recovery', async () => {
      const status = { ...baseStatus };
      const log = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
      let fail = true;
      const getStatus = jest.fn(async () => {
        if (fail) {
          throw new Error('ETIMEDOUT');
        }
        return status;
      });

      await SamsungRacAccessory.create(
        {
          Service, Characteristic, log,
          api: { hap: { HapStatusError: FakeHapStatusError, HAPStatus } },
          settings: { updateInterval: 3600, swingDirection: 'Up_And_Low' },
        } as never,
        new FakeAccessory() as never,
        { getStatus, close: jest.fn() } as never,
      );

      // The read in initialize() failed: one warning, and no repeat while the
      // unit stays away.
      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(log.warn.mock.calls[0].join(' ')).toContain('not responding');
      await pollOnce(getStatus);
      expect(log.warn).toHaveBeenCalledTimes(1);

      fail = false;
      await pollOnce(getStatus);
      expect(log.info.mock.calls.map((call) => call.join(' ')).join('\n')).toContain('responding again');
    });
  });

  describe('power', () => {
    it('turns the unit on and off', async () => {
      const { heaterCooler, adapter } = await build();
      const active = heaterCooler.findCharacteristic(Characteristic.Active);

      await active?.setHandler?.(Characteristic.Active.ACTIVE);
      expect(adapter.setPower).toHaveBeenCalledWith(true);

      await active?.setHandler?.(Characteristic.Active.INACTIVE);
      expect(adapter.setPower).toHaveBeenCalledWith(false);
    });
  });
});
