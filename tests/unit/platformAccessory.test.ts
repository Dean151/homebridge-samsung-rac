import { SamsungRacAccessory } from '../../src/platformAccessory';
import type { RacStatus } from '../../src/racStatus';
import type { ModeSwitchConfig } from '../../src/config';
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
  /** Only when the harness was built with an outdoor accessory of its own. */
  outdoor?: FakeAccessory;
  publish: jest.Mock;
}

/** `'Quiet'` and `{ value: 'Quiet', name: 'Silence' }` are both allowed here. */
function switchList(value: unknown): ModeSwitchConfig[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => (typeof entry === 'string' ? { value: entry } : entry as ModeSwitchConfig));
}

async function build(options: {
  status?: Partial<RacStatus>;
  settings?: Record<string, unknown>;
  accessory?: FakeAccessory;
  /** Hand the accessory a separate home for the outdoor sensor, as 'separate' does. */
  outdoor?: FakeAccessory | true;
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
    setComode: jest.fn(applied('Quiet')),
    close: jest.fn(),
  };

  const accessory = options.accessory ?? new FakeAccessory();

  const publish = jest.fn();
  const outdoorAccessory = options.outdoor
    ? (options.outdoor === true ? new FakeAccessory('Test AC Outdoor', 'test-uuid-outdoor') : options.outdoor)
    : undefined;
  const outdoor = outdoorAccessory ? { accessory: outdoorAccessory, publish } : undefined;

  const platform = {
    Service,
    Characteristic,
    log,
    api: {
      hap: { HapStatusError: FakeHapStatusError, HAPStatus },
      updatePlatformAccessories: jest.fn(),
    },
    // A long interval keeps the poll timer from firing on its own mid-test.
    settings: {
      updateInterval: 3600,
      swingDirection: 'Up_And_Low',
      ...options.settings,
      // Tests name modes as plain strings; the real config carries objects, so
      // an entry that wants a custom name can still be written out in full.
      // Empty by default, exactly as a config that has not asked for switches.
      convenienceModes: switchList(options.settings?.convenienceModes),
      modeSwitches: switchList(options.settings?.modeSwitches),
    },
  };

  await SamsungRacAccessory.create(
    platform as never, accessory as never, adapter as never, outdoor as never,
  );

  return {
    accessory,
    heaterCooler: accessory.getService(Service.HeaterCooler) as FakeService,
    adapter: adapter as unknown as Record<string, jest.Mock>,
    log,
    outdoor: outdoorAccessory,
    publish,
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

  describe('the room temperature frozen while the unit is off', () => {
    const frozen = { freezeIndoorTemperatureWhenOff: true };

    it('holds the last reading taken while the unit was running', async () => {
      const { heaterCooler, adapter, setStatus } = await build({
        status: { currentTemperature: 23 },
        settings: frozen,
      });

      setStatus({ active: false, currentTemperature: 31 });
      await pollOnce(adapter.getStatus);

      expect(heaterCooler.findCharacteristic(Characteristic.CurrentTemperature)?.getHandler?.()).toBe(23);
      expect(heaterCooler.findCharacteristic(Characteristic.CurrentTemperature)?.value).toBe(23);
    });

    it('goes live again the moment the unit starts', async () => {
      const { heaterCooler, adapter, setStatus } = await build({
        status: { currentTemperature: 23 },
        settings: frozen,
      });

      setStatus({ active: false, currentTemperature: 31 });
      await pollOnce(adapter.getStatus);
      setStatus({ active: true, currentTemperature: 24.5 });
      await pollOnce(adapter.getStatus);

      expect(heaterCooler.findCharacteristic(Characteristic.CurrentTemperature)?.getHandler?.()).toBe(24.5);
    });

    it('freezes at the newest running reading, not the first one seen', async () => {
      const { heaterCooler, adapter, setStatus } = await build({
        status: { currentTemperature: 23 },
        settings: frozen,
      });

      setStatus({ currentTemperature: 21 });
      await pollOnce(adapter.getStatus);
      setStatus({ active: false, currentTemperature: 31 });
      await pollOnce(adapter.getStatus);

      expect(heaterCooler.findCharacteristic(Characteristic.CurrentTemperature)?.getHandler?.()).toBe(21);
    });

    it('survives a restart, so a Homebridge restarted while off keeps the held value', async () => {
      // The same cached accessory a restart hands back, context and all.
      const cached = new FakeAccessory();
      const first = await build({ status: { currentTemperature: 23 }, accessory: cached, settings: frozen });
      first.setStatus({ active: false, currentTemperature: 31 });
      await pollOnce(first.adapter.getStatus);

      const { heaterCooler } = await build({
        status: { active: false, currentTemperature: 31 },
        accessory: cached,
        settings: frozen,
      });

      expect(heaterCooler.findCharacteristic(Characteristic.CurrentTemperature)?.getHandler?.()).toBe(23);
    });

    it('reports the live reading when the unit has never run, doubtful beating unusable', async () => {
      // Nothing remembered yet: the alternative is the bottom of the setpoint
      // range, which is what an unusable reading reports as.
      const { heaterCooler } = await build({
        status: { active: false, currentTemperature: 31 },
        settings: frozen,
      });

      expect(heaterCooler.findCharacteristic(Characteristic.CurrentTemperature)?.getHandler?.()).toBe(31);
    });

    it('remembers even with the option off, so turning it on freezes straight away', async () => {
      const cached = new FakeAccessory();
      const running = await build({ status: { currentTemperature: 23 }, accessory: cached });
      running.setStatus({ active: false, currentTemperature: 31 });
      await pollOnce(running.adapter.getStatus);

      const { heaterCooler } = await build({
        status: { active: false, currentTemperature: 31 },
        accessory: cached,
        settings: frozen,
      });

      expect(heaterCooler.findCharacteristic(Characteristic.CurrentTemperature)?.getHandler?.()).toBe(23);
    });

    it('leaves the reading alone when the option is off', async () => {
      const { heaterCooler, adapter, setStatus } = await build({ status: { currentTemperature: 23 } });

      setStatus({ active: false, currentTemperature: 31 });
      await pollOnce(adapter.getStatus);

      expect(heaterCooler.findCharacteristic(Characteristic.CurrentTemperature)?.getHandler?.()).toBe(31);
    });

    it('still reports Inactive rather than a state inferred from the held reading', async () => {
      const { heaterCooler, adapter, setStatus } = await build({
        status: { mode: 'Auto', currentTemperature: 23, targetTemperature: 18 },
        settings: frozen,
      });

      setStatus({ active: false });
      await pollOnce(adapter.getStatus);

      expect(heaterCooler.findCharacteristic(Characteristic.CurrentHeaterCoolerState)?.getHandler?.())
        .toBe(Characteristic.CurrentHeaterCoolerState.INACTIVE);
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

    // The reference unit reports modes: ['Heat'] and a supportedModes that
    // omits Heat, in the same document, and applies a write of 'Heat'. Trusting
    // the advertised list alone hid working heating from HomeKit.
    it('offers HEAT on a nonzero WarmCapa even when supportedModes omits Heat', async () => {
      const { heaterCooler } = await build({
        status: { heatCapable: true, options: { WarmCapa: '60', CoolCapa: '50' } },
      });
      expect(heaterCooler.findCharacteristic(Characteristic.TargetHeaterCoolerState)?.props.validValues)
        .toEqual([0, 1, 2]);
    });

    it('does not offer HEAT on a zero WarmCapa', async () => {
      const { heaterCooler } = await build({
        status: { heatCapable: false, options: { WarmCapa: '0' } },
      });
      expect(heaterCooler.findCharacteristic(Characteristic.TargetHeaterCoolerState)?.props.validValues)
        .toEqual([Characteristic.TargetHeaterCoolerState.AUTO, Characteristic.TargetHeaterCoolerState.COOL]);
    });

    it('offers HEAT when devices[].heating forces it on against every other signal', async () => {
      const accessory = new FakeAccessory();
      accessory.context = { heating: true };
      const { heaterCooler } = await build({ accessory, status: { heatCapable: false } });
      expect(heaterCooler.findCharacteristic(Characteristic.TargetHeaterCoolerState)?.props.validValues)
        .toEqual([0, 1, 2]);
    });

    it('hides HEAT when devices[].heating forces it off against every other signal', async () => {
      const accessory = new FakeAccessory();
      accessory.context = { heating: false };
      const { heaterCooler } = await build({
        accessory,
        status: { supportedModes: ['Cool', 'Heat', 'Auto'], heatCapable: true },
      });
      expect(heaterCooler.findCharacteristic(Characteristic.TargetHeaterCoolerState)?.props.validValues)
        .toEqual([Characteristic.TargetHeaterCoolerState.AUTO, Characteristic.TargetHeaterCoolerState.COOL]);
    });

    it('adopts HEAT later when the unit only reports it once running', async () => {
      const { heaterCooler, adapter, setStatus } = await build();
      expect(heaterCooler.findCharacteristic(Characteristic.TargetHeaterCoolerState)?.props.validValues)
        .not.toContain(Characteristic.TargetHeaterCoolerState.HEAT);

      setStatus({ heatCapable: true, options: { WarmCapa: '60' } });
      await pollOnce(adapter.getStatus);

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

    it('names the filter service after the unit, not the accessory', async () => {
      const { accessory } = await build();

      expect(accessory.getService(Service.FilterMaintenance)
        ?.findCharacteristic(Characteristic.ConfiguredName)?.value)
        .toBe('Test AC Filter');
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

    it('reports how much of the filter is left', async () => {
      const { accessory } = await build({
        status: { filterHours: 250, filterAlarmHours: 500, filterLife: 50 },
      });

      expect(accessory.getService(Service.FilterMaintenance)
        ?.findCharacteristic(Characteristic.FilterLifeLevel)?.getHandler?.())
        .toBe(50);
    });

    it('leaves the level out for a unit that publishes no hours', async () => {
      const { accessory } = await build();

      expect(accessory.getService(Service.FilterMaintenance)
        ?.findCharacteristic(Characteristic.FilterLifeLevel))
        .toBeUndefined();
    });

    it('follows the level down without being asked', async () => {
      const { accessory, adapter, setStatus } = await build({ status: { filterLife: 50 } });

      setStatus({ filterLife: 49 });
      await pollOnce(adapter.getStatus);

      expect(accessory.getService(Service.FilterMaintenance)
        ?.findCharacteristic(Characteristic.FilterLifeLevel)?.value)
        .toBe(49);
    });

    it('adopts the hours when a unit only starts counting once it runs', async () => {
      const { accessory, adapter, setStatus } = await build();
      expect(accessory.getService(Service.FilterMaintenance)
        ?.findCharacteristic(Characteristic.FilterLifeLevel)).toBeUndefined();

      setStatus({ filterLife: 100 });
      await pollOnce(adapter.getStatus);

      expect(accessory.getService(Service.FilterMaintenance)
        ?.findCharacteristic(Characteristic.FilterLifeLevel)?.getHandler?.())
        .toBe(100);
    });
  });

  describe('outdoor temperature', () => {
    it('publishes a temperature sensor when the unit reports one', async () => {
      const { accessory } = await build({ status: { outdoorTemperature: 21.7 } });

      expect(accessory.getService(Service.TemperatureSensor)
        ?.findCharacteristic(Characteristic.CurrentTemperature)?.getHandler?.())
        .toBe(21.7);
    });

    it('leaves it unlinked, so it reads as a tile rather than part of the control', async () => {
      const { accessory, heaterCooler } = await build({ status: { outdoorTemperature: 21.7 } });

      expect(heaterCooler.linkedServices)
        .not.toContain(accessory.getService(Service.TemperatureSensor));
    });

    it('stays away when the unit reports no outdoor temperature', async () => {
      const { accessory } = await build();
      expect(accessory.getService(Service.TemperatureSensor)).toBeUndefined();
    });

    it('keeps the indoor reading on the heater-cooler untouched', async () => {
      // Two temperatures on one accessory: getting them crossed would show the
      // outdoors as the room temperature the setpoint is chasing.
      const { accessory, heaterCooler } = await build({
        status: { currentTemperature: 23, outdoorTemperature: 21.7 },
      });

      expect(heaterCooler.findCharacteristic(Characteristic.CurrentTemperature)?.getHandler?.()).toBe(23);
      expect(accessory.getService(Service.TemperatureSensor)
        ?.findCharacteristic(Characteristic.CurrentTemperature)?.getHandler?.())
        .toBe(21.7);
    });

    it('pushes a change the unit made on its own', async () => {
      const { accessory, adapter, setStatus } = await build({ status: { outdoorTemperature: 21.7 } });

      setStatus({ outdoorTemperature: 18.3 });
      await pollOnce(adapter.getStatus);

      expect(accessory.getService(Service.TemperatureSensor)
        ?.findCharacteristic(Characteristic.CurrentTemperature)?.value)
        .toBe(18.3);
    });

    it('reports No Response rather than 0°C if the reading disappears', async () => {
      const { accessory, adapter, setStatus } = await build({ status: { outdoorTemperature: 21.7 } });
      const sensor = accessory.getService(Service.TemperatureSensor);

      setStatus({ outdoorTemperature: undefined });
      await pollOnce(adapter.getStatus);

      expect(() => sensor?.findCharacteristic(Characteristic.CurrentTemperature)?.getHandler?.())
        .toThrow(FakeHapStatusError);
      // Never withdrawn, in case the unit starts reporting it again.
      expect(accessory.getService(Service.TemperatureSensor)).toBeDefined();
    });

    describe('hidden while the unit is off', () => {
      const hidden = { hideOutdoorTemperatureWhenOff: true };

      it('reports No Response instead of a reading the sensor never took', async () => {
        const { accessory } = await build({
          status: { outdoorTemperature: 21.7, active: false },
          settings: hidden,
        });

        expect(() => accessory.getService(Service.TemperatureSensor)
          ?.findCharacteristic(Characteristic.CurrentTemperature)?.getHandler?.())
          .toThrow(FakeHapStatusError);
      });

      it('still publishes the sensor, so a unit off at startup keeps its tile', async () => {
        const { accessory } = await build({
          status: { outdoorTemperature: 21.7, active: false },
          settings: hidden,
        });

        expect(accessory.getService(Service.TemperatureSensor)).toBeDefined();
      });

      it('reports normally while the unit is running', async () => {
        const { accessory } = await build({
          status: { outdoorTemperature: 21.7, active: true },
          settings: hidden,
        });

        expect(accessory.getService(Service.TemperatureSensor)
          ?.findCharacteristic(Characteristic.CurrentTemperature)?.getHandler?.())
          .toBe(21.7);
      });

      it('pushes the error the moment the unit is switched off', async () => {
        // Without the push the Home app keeps the last figure on screen until
        // something asks for it again.
        const { accessory, adapter, setStatus } = await build({
          status: { outdoorTemperature: 21.7 },
          settings: hidden,
        });

        setStatus({ active: false, outdoorTemperature: 24.9 });
        await pollOnce(adapter.getStatus);

        expect(accessory.getService(Service.TemperatureSensor)
          ?.findCharacteristic(Characteristic.CurrentTemperature)?.value)
          .toBeInstanceOf(FakeHapStatusError);
      });

      it('comes back live when the unit starts again', async () => {
        const { accessory, adapter, setStatus } = await build({
          status: { outdoorTemperature: 21.7, active: false },
          settings: hidden,
        });

        setStatus({ active: true, outdoorTemperature: 18.3 });
        await pollOnce(adapter.getStatus);

        expect(accessory.getService(Service.TemperatureSensor)
          ?.findCharacteristic(Characteristic.CurrentTemperature)?.value)
          .toBe(18.3);
      });

      it('leaves the reading alone when the option is off', async () => {
        const { accessory } = await build({
          status: { outdoorTemperature: 21.7, active: false },
        });

        expect(accessory.getService(Service.TemperatureSensor)
          ?.findCharacteristic(Characteristic.CurrentTemperature)?.getHandler?.())
          .toBe(21.7);
      });

      it('leaves the indoor reading reporting, off or not', async () => {
        // Only the outdoor sensor is withheld: a "No Response" on the
        // heater-cooler's own temperature would take the whole tile with it,
        // and with it any way to switch the unit back on.
        const { heaterCooler } = await build({
          status: { currentTemperature: 23, outdoorTemperature: 21.7, active: false },
          settings: hidden,
        });

        expect(heaterCooler.findCharacteristic(Characteristic.CurrentTemperature)?.getHandler?.()).toBe(23);
      });
    });

    describe('on an accessory of its own', () => {
      it('puts the sensor there rather than on the air conditioner', async () => {
        const { accessory, outdoor, publish } = await build({
          status: { outdoorTemperature: 21.7 },
          outdoor: true,
        });

        expect(outdoor?.getService(Service.TemperatureSensor)
          ?.findCharacteristic(Characteristic.CurrentTemperature)?.getHandler?.())
          .toBe(21.7);
        // Or the reading would show up twice, in two rooms.
        expect(accessory.getService(Service.TemperatureSensor)).toBeUndefined();
        expect(publish).toHaveBeenCalledTimes(1);
      });

      it('keeps it off HomeKit entirely when the unit reports no reading', async () => {
        const { outdoor, publish } = await build({ outdoor: true });

        expect(outdoor?.getService(Service.TemperatureSensor)).toBeUndefined();
        expect(publish).not.toHaveBeenCalled();
      });

      it('publishes it once a reading finally turns up', async () => {
        const { outdoor, publish, adapter, setStatus } = await build({ outdoor: true });

        setStatus({ outdoorTemperature: 21.7 });
        await pollOnce(adapter.getStatus);

        expect(outdoor?.getService(Service.TemperatureSensor)).toBeDefined();
        expect(publish).toHaveBeenCalledTimes(1);
      });

      it('pushes a change the unit made on its own', async () => {
        const { outdoor, adapter, setStatus } = await build({
          status: { outdoorTemperature: 21.7 },
          outdoor: true,
        });

        setStatus({ outdoorTemperature: 18.3 });
        await pollOnce(adapter.getStatus);

        expect(outdoor?.getService(Service.TemperatureSensor)
          ?.findCharacteristic(Characteristic.CurrentTemperature)?.value)
          .toBe(18.3);
      });

      it('takes the sensor off an air conditioner left carrying one', async () => {
        // The setting was 'linked' last run, so the cached accessory still has
        // the service; leaving it there would show the reading in both rooms.
        const cached = new FakeAccessory();
        cached.addService(Service.TemperatureSensor);

        const { accessory, outdoor } = await build({
          status: { outdoorTemperature: 21.7 },
          accessory: cached,
          outdoor: true,
        });

        expect(accessory.getService(Service.TemperatureSensor)).toBeUndefined();
        expect(outdoor?.getService(Service.TemperatureSensor)).toBeDefined();
      });
    });
  });

  describe('late capabilities', () => {
    it('adds the outdoor sensor once the unit starts reporting one', async () => {
      const { accessory, adapter, setStatus } = await build();
      expect(accessory.getService(Service.TemperatureSensor)).toBeUndefined();

      setStatus({ outdoorTemperature: 21.7 });
      await pollOnce(adapter.getStatus);

      expect(accessory.getService(Service.TemperatureSensor)).toBeDefined();
    });

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

  describe('mode switches', () => {
    const switches = (accessory: FakeAccessory) =>
      accessory.services.filter((service) => service.UUID === Service.Switch.UUID);
    const on = (service?: FakeService) => service?.findCharacteristic(Characteristic.On);
    const convenience = { convenienceModes: ['Quiet', 'Comfort'] };

    it('publishes none until the config asks for one', async () => {
      const { accessory } = await build({ status: { comode: 'Off' } });
      expect(switches(accessory)).toHaveLength(0);
    });

    it('leaves the air conditioner as the accessory the Home app leads with', async () => {
      const { accessory, heaterCooler } = await build({
        status: { comode: 'Off' },
        settings: convenience,
      });

      expect(heaterCooler.primary).toBe(true);
      expect(switches(accessory).every((service) => !service.primary)).toBe(true);
    });

    it('publishes one per convenience mode, linked to the air conditioner', async () => {
      const { accessory, heaterCooler } = await build({
        status: { comode: 'Off' },
        settings: convenience,
      });

      expect(switches(accessory).map((service) => service.subtype))
        .toEqual(['comode-quiet', 'comode-comfort']);
      expect(switches(accessory).map((service) => service.displayName))
        .toEqual(['Test AC Quiet', 'Test AC Comfort']);
      expect(heaterCooler.linkedServices).toEqual(expect.arrayContaining(switches(accessory)));
    });

    describe('named in the config', () => {
      it('uses the name exactly as written, with no air conditioner in front of it', async () => {
        const { accessory } = await build({
          status: { comode: 'Off' },
          settings: { convenienceModes: [{ value: 'Quiet', name: 'Silence' }] },
        });

        expect(switches(accessory)
          .map((service) => service.findCharacteristic(Characteristic.ConfiguredName)?.value))
          .toEqual(['Silence']);
      });

      it('keys the subtype on the unit\'s word, so renaming does not move an automation', async () => {
        const { accessory } = await build({
          status: { comode: 'Off' },
          settings: { convenienceModes: [{ value: 'Quiet', name: 'Silence' }] },
        });

        expect(switches(accessory).map((service) => service.subtype)).toEqual(['comode-quiet']);
      });

      it('still writes the unit\'s word, not the name shown', async () => {
        const { accessory, adapter } = await build({
          status: { comode: 'Off' },
          settings: { convenienceModes: [{ value: 'Quiet', name: 'Silence' }] },
        });

        await switches(accessory)[0].findCharacteristic(Characteristic.On)?.setHandler?.(true);

        expect(adapter.setComode).toHaveBeenCalledWith('Quiet');
      });

      it('renames a switch published under the derived name, keeping its subtype', async () => {
        // The switch already exists from a run before the name was set; it must
        // be renamed in place rather than published a second time.
        const cached = new FakeAccessory();
        await build({ status: { comode: 'Off' }, accessory: cached, settings: { convenienceModes: ['Quiet'] } });

        const { accessory } = await build({
          status: { comode: 'Off' },
          accessory: cached,
          settings: { convenienceModes: [{ value: 'Quiet', name: 'Silence' }] },
        });

        expect(switches(accessory).map((service) => service.subtype)).toEqual(['comode-quiet']);
      });

      it('names a mode switch the same way', async () => {
        const { accessory } = await build({
          settings: { modeSwitches: [{ value: 'Wind', name: 'Ventilation' }] },
        });

        expect(switches(accessory)
          .map((service) => service.findCharacteristic(Characteristic.ConfiguredName)?.value))
          .toEqual(['Ventilation']);
      });

      it('beats the tidied-up label the plugin would otherwise pick', async () => {
        // Wind reads as 'Fan Only' by default; an explicit name outranks it.
        const { accessory } = await build({
          settings: { modeSwitches: [{ value: 'Wind', name: 'Ventilation' }] },
        });

        expect(switches(accessory)
          .map((service) => service.findCharacteristic(Characteristic.ConfiguredName)?.value))
          .not.toContain('Test AC Fan Only');
      });

      it('leaves an unnamed entry on the derived name, so two units stay apart', async () => {
        const { accessory } = await build({
          status: { comode: 'Off' },
          settings: { convenienceModes: [{ value: 'Quiet', name: 'Silence' }, 'Comfort'] },
        });

        expect(switches(accessory)
          .map((service) => service.findCharacteristic(Characteristic.ConfiguredName)?.value))
          .toEqual(['Silence', 'Test AC Comfort']);
      });
    });

    it('gives each switch a name of its own, which is what the Home app reads', async () => {
      const { accessory } = await build({ status: { comode: 'Off' }, settings: convenience });

      // Name alone leaves both tiles reading the accessory's name.
      expect(switches(accessory)
        .map((service) => service.findCharacteristic(Characteristic.ConfiguredName)?.value))
        .toEqual(['Test AC Quiet', 'Test AC Comfort']);
    });

    it('keeps a rename made in the Home app, rather than undoing it on restart', async () => {
      const shared = new FakeAccessory();
      const first = await build({ accessory: shared, status: { comode: 'Off' }, settings: convenience });

      const quiet = shared.getServiceById(Service.Switch, 'comode-quiet');
      await quiet?.findCharacteristic(Characteristic.ConfiguredName)?.setHandler?.('WindFree');
      expect(first.log.info.mock.calls.flat().join(' ')).toContain('renamed to');

      // What the next Homebridge start does with the cached accessory.
      await build({ accessory: shared, status: { comode: 'Off' }, settings: convenience });

      expect(shared.getServiceById(Service.Switch, 'comode-quiet')
        ?.findCharacteristic(Characteristic.ConfiguredName)?.value)
        .toBe('WindFree');
    });

    it('reads on only for the mode the unit is actually in', async () => {
      const { accessory } = await build({ status: { comode: 'Quiet' }, settings: convenience });

      expect(on(accessory.getServiceById(Service.Switch, 'comode-quiet'))?.getHandler?.()).toBe(true);
      expect(on(accessory.getServiceById(Service.Switch, 'comode-comfort'))?.getHandler?.()).toBe(false);
    });

    it('writes the mode when switched on, and Off when switched off', async () => {
      const { accessory, adapter, setStatus } = await build({
        status: { comode: 'Off' },
        settings: convenience,
      });
      const quiet = on(accessory.getServiceById(Service.Switch, 'comode-quiet'));

      await quiet?.setHandler?.(true);
      expect(adapter.setComode).toHaveBeenCalledWith('Quiet');

      // The unit took it, so this is now the switch that is on — which is what
      // makes switching it off mean something.
      setStatus({ comode: 'Quiet' });
      await pollOnce(adapter.getStatus);

      await quiet?.setHandler?.(false);
      expect(adapter.setComode).toHaveBeenLastCalledWith('Off');
    });

    it('turns the rest off when one comes on, including from the remote', async () => {
      const { accessory, adapter, setStatus } = await build({
        status: { comode: 'Comfort' },
        settings: convenience,
      });

      setStatus({ comode: 'Quiet' });
      await pollOnce(adapter.getStatus);

      expect(on(accessory.getServiceById(Service.Switch, 'comode-quiet'))?.value).toBe(true);
      expect(on(accessory.getServiceById(Service.Switch, 'comode-comfort'))?.value).toBe(false);
    });

    it('turns the others off at once, not when the unit gets round to answering', async () => {
      const { accessory, adapter, setStatus } = await build({
        status: { comode: 'Comfort' },
        settings: convenience,
      });
      const comfort = on(accessory.getServiceById(Service.Switch, 'comode-comfort'));
      expect(comfort?.getHandler?.()).toBe(true);

      // The unit takes a second and a half to answer, and is read back after
      // that; two tiles must not both read on in the meantime.
      let release = () => undefined as void;
      const answered = new Promise<void>((resolve) => {
        release = () => resolve();
      });
      adapter.setComode.mockImplementation(async () => {
        await answered;
        setStatus({ comode: 'Quiet' });
        return { applied: true, requested: 'Quiet', actual: 'Quiet', status: await adapter.getStatus() };
      });

      const write = on(accessory.getServiceById(Service.Switch, 'comode-quiet'))?.setHandler?.(true);
      expect(comfort?.value).toBe(false);

      release();
      await write;

      expect(on(accessory.getServiceById(Service.Switch, 'comode-quiet'))?.value).toBe(true);
      expect(comfort?.value).toBe(false);
    });

    it('sends nothing when a switch that is already off is switched off', async () => {
      const { accessory, adapter } = await build({ status: { comode: 'Quiet' }, settings: convenience });

      // What a scene that turns the whole group off does: one write per switch,
      // and the ones that were already off must not cancel anything.
      await on(accessory.getServiceById(Service.Switch, 'comode-comfort'))?.setHandler?.(false);

      expect(adapter.setComode).not.toHaveBeenCalled();
      expect(on(accessory.getServiceById(Service.Switch, 'comode-quiet'))?.getHandler?.()).toBe(true);
    });

    it('leaves a switch in the other group alone', async () => {
      const { accessory } = await build({
        status: { comode: 'Off', mode: 'Dry' },
        settings: { convenienceModes: ['Quiet'], modeSwitches: ['Dry'] },
      });
      const dry = on(accessory.getServiceById(Service.Switch, 'mode-dry'));

      await on(accessory.getServiceById(Service.Switch, 'comode-quiet'))?.setHandler?.(true);

      // The convenience mode and the mode are different fields: one says
      // nothing about the other.
      expect(dry?.getHandler?.()).toBe(true);
    });

    it('publishes nothing for a unit that reports no convenience mode at all', async () => {
      const { accessory, log } = await build({ settings: { convenienceModes: ['Quiet'] } });

      expect(switches(accessory)).toHaveLength(0);
      expect(log.info.mock.calls.flat().join(' ')).toContain('not publishing a Quiet switch');
    });

    it('adopts a convenience mode the unit only reports once it is running', async () => {
      const { accessory, adapter, setStatus } = await build({ settings: { convenienceModes: ['Quiet'] } });
      expect(switches(accessory)).toHaveLength(0);

      setStatus({ comode: 'Off' });
      await pollOnce(adapter.getStatus);

      expect(accessory.getServiceById(Service.Switch, 'comode-quiet')).toBeDefined();
    });

    it('drops a switch the config no longer asks for', async () => {
      const cached = new FakeAccessory();
      cached.addService(Service.Switch, 'Test AC Quiet', 'comode-quiet');

      const { accessory } = await build({ accessory: cached, status: { comode: 'Off' } });

      expect(switches(accessory)).toHaveLength(0);
    });

    it('leaves a switch it does not own where it is', async () => {
      const cached = new FakeAccessory();
      cached.addService(Service.Switch, 'Someone else', 'not-ours');

      const { accessory } = await build({ accessory: cached, status: { comode: 'Off' } });

      expect(accessory.getServiceById(Service.Switch, 'not-ours')).toBeDefined();
    });

    it('gives Dry and fan-only the switch HeaterCooler has no room for', async () => {
      const { accessory, adapter } = await build({ settings: { modeSwitches: ['Dry', 'Wind'] } });

      // The unit calls it Wind; a tile called "Wind" would not tell anyone what
      // it does, and the Home app can still rename it.
      expect(accessory.getServiceById(Service.Switch, 'mode-wind')?.displayName).toBe('Test AC Fan Only');

      await on(accessory.getServiceById(Service.Switch, 'mode-dry'))?.setHandler?.(true);
      expect(adapter.setMode).toHaveBeenCalledWith('Dry');
    });

    it('returns to the mode the unit was in before, when a mode switch goes off', async () => {
      const { accessory, adapter, setStatus } = await build({
        status: { mode: 'Auto' },
        settings: { modeSwitches: ['Dry'] },
      });

      setStatus({ mode: 'Dry' });
      await pollOnce(adapter.getStatus);
      expect(on(accessory.getServiceById(Service.Switch, 'mode-dry'))?.value).toBe(true);

      await on(accessory.getServiceById(Service.Switch, 'mode-dry'))?.setHandler?.(false);
      expect(adapter.setMode).toHaveBeenCalledWith('Auto');
    });

    it('falls back to a mode HomeKit can drive when it never saw another one', async () => {
      // Homebridge restarted while the unit was already in Dry: there is no
      // "no mode" to go back to, so off has to mean something.
      const { accessory, adapter } = await build({
        status: { mode: 'Dry' },
        settings: { modeSwitches: ['Dry'] },
      });

      await on(accessory.getServiceById(Service.Switch, 'mode-dry'))?.setHandler?.(false);
      expect(adapter.setMode).toHaveBeenCalledWith('Cool');
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
          api: { hap: { HapStatusError: FakeHapStatusError, HAPStatus }, updatePlatformAccessories: jest.fn() },
          settings: { updateInterval: 3600, swingDirection: 'Up_And_Low', convenienceModes: [], modeSwitches: [] },
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
          api: { hap: { HapStatusError: FakeHapStatusError, HAPStatus }, updatePlatformAccessories: jest.fn() },
          settings: { updateInterval: 3600, swingDirection: 'Up_And_Low', convenienceModes: [], modeSwitches: [] },
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
