import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { devicesFrom, parseOptions, RacDevicesResponse, toRacStatus } from '../../src/racStatus';

const fixture = JSON.parse(
  readFileSync(path.join(__dirname, '..', 'fixtures', 'devices.json'), 'utf8'),
) as RacDevicesResponse;

describe('parseOptions', () => {
  it('splits on the last underscore so keys containing one survive', () => {
    expect(parseOptions(['UpdateAllow_NotAllowed', 'FilterCleanAlarm_0', 'OutdoorTemp_74'])).toEqual({
      UpdateAllow: 'NotAllowed',
      FilterCleanAlarm: '0',
      OutdoorTemp: '74',
    });
  });

  it('ignores entries that are not Key_Value at all', () => {
    expect(parseOptions(['nonsense', '_leading', ''])).toEqual({});
  });

  it('treats a missing options array as no options', () => {
    expect(parseOptions(undefined)).toEqual({});
  });
});

describe('toRacStatus', () => {
  const status = toRacStatus(devicesFrom(fixture)[0]);

  it('reads the convenience mode the unit is in, and nothing about the ones it would take', () => {
    expect(status.comode).toBe('Off');
    expect(toRacStatus({ Mode: { options: ['Comode_Quiet'] } }).comode).toBe('Quiet');
    expect(toRacStatus({ Mode: { options: [] } }).comode).toBeUndefined();
  });

  it('reads the reference unit captured from real hardware', () => {
    expect(status).toMatchObject({
      active: false,
      mode: 'Cool',
      supportedModes: ['Cool', 'Dry', 'Wind', 'Auto'],
      currentTemperature: 23,
      targetTemperature: 24,
      minSetpoint: 16,
      maxSetpoint: 30,
      windDirection: 'Fix',
      speedLevel: 0,
      maxSpeedLevel: 4,
      filterAlarm: true,
      model: 'TP6X_RAC_16K',
      id: '0',
    });
  });

  it('records the scale the reference unit reports in', () => {
    expect(status.temperatureUnit).toBe('C');
  });

  it('converts a Fahrenheit unit to Celsius, which is all HomeKit accepts', () => {
    // Nothing above the transport should ever see a Fahrenheit number. Passed
    // through unconverted these look plausible rather than absurd: 71 shown as
    // 71°C is wrong by fifty degrees but renders perfectly happily.
    const converted = toRacStatus({
      Temperatures: [{ id: '0', current: 71, desired: 75, minimum: 60, maximum: 86, unit: 'Fahrenheit' }],
    });

    expect(converted.temperatureUnit).toBe('F');
    expect(converted.currentTemperature).toBe(21.7);
    expect(converted.targetTemperature).toBe(24);
    expect(converted.minSetpoint).toBe(15.5);
    expect(converted.maxSetpoint).toBe(30);
  });

  it('assumes Celsius when the unit does not say, and changes nothing', () => {
    const unlabelled = toRacStatus({
      Temperatures: [{ id: '0', current: 23, desired: 24, minimum: 16, maximum: 30 }],
    });

    expect(unlabelled.temperatureUnit).toBe('C');
    expect(unlabelled.currentTemperature).toBe(23);
    expect(unlabelled.targetTemperature).toBe(24);
  });

  it('exposes the unit resource list, which is what gates optional services', () => {
    expect(status.resources).toContain('Alarms');
    expect(status.resources).toContain('Wind');
  });

  it('parses the flat Mode.options array', () => {
    expect(status.options.OutdoorTemp).toBe('74');
    expect(status.options.FilterAlarmTime).toBe('500');
  });

  describe('the outdoor sensor', () => {
    /** The reference unit's own options array, with OutdoorTemp swapped out. */
    const withOutdoor = (value: string) => ({
      Mode: { options: ['Comode_Off', `OutdoorTemp_${value}`, 'Volume_100'] },
    });

    it('reads Fahrenheit by default, which is what the reference unit reports', () => {
      // 2026-09-15: the unit said 71 while it was genuinely 21°C outside.
      expect(toRacStatus(withOutdoor('71')).outdoorTemperature).toBe(21.7);
    });

    it('reads Celsius when told to, for a unit that differs', () => {
      expect(toRacStatus(withOutdoor('21'), { outdoorTemperatureUnit: 'C' }).outdoorTemperature)
        .toBe(21);
    });

    it('does not infer the scale from the unit\'s own', () => {
      // The reference unit reports itself in Celsius and this in Fahrenheit, in
      // one document, with only the former labelled. Reading Temperatures[].unit
      // to decide would get this exactly backwards.
      const status = toRacStatus({
        Temperatures: [{ id: '0', current: 23, desired: 24, unit: 'Celsius' }],
        ...withOutdoor('71'),
      });

      expect(status.temperatureUnit).toBe('C');
      expect(status.outdoorTemperature).toBe(21.7);
    });

    it('leaves it out entirely when switched off', () => {
      expect(toRacStatus(withOutdoor('71'), { outdoorTemperatureUnit: null }).outdoorTemperature)
        .toBeUndefined();
    });

    it('leaves it out when the unit publishes no such option', () => {
      expect(toRacStatus({ Mode: { options: ['Comode_Off'] } }).outdoorTemperature).toBeUndefined();
      expect(toRacStatus({}).outdoorTemperature).toBeUndefined();
    });

    it('rejects a value that cannot be an outdoor temperature', () => {
      // Mode.options is a grab-bag of unrelated counters, so a unit using this
      // key for something else must not surface as a confident 123°C.
      expect(toRacStatus(withOutdoor('254')).outdoorTemperature).toBeUndefined();
      expect(toRacStatus(withOutdoor('nonsense')).outdoorTemperature).toBeUndefined();
      expect(toRacStatus(withOutdoor('')).outdoorTemperature).toBeUndefined();
    });
  });

  describe('heatCapable', () => {
    const withOptions = (...options: string[]) => ({ Mode: { options } });

    // supportedModes cannot answer this: the reference unit reported
    // modes: ['Heat'] alongside a supportedModes without Heat, and applied a
    // write of 'Heat'. WarmCapa is the only signal that tracks the hardware.
    it('reads a nonzero WarmCapa as heating hardware', () => {
      expect(toRacStatus(withOptions('CoolCapa_50', 'WarmCapa_60')).heatCapable).toBe(true);
    });

    it('reads a zero WarmCapa as no heating hardware', () => {
      expect(toRacStatus(withOptions('CoolCapa_50', 'WarmCapa_0')).heatCapable).toBe(false);
    });

    it('stays undefined when the unit publishes no WarmCapa, which is not a no', () => {
      expect(toRacStatus(withOptions('CoolCapa_50')).heatCapable).toBeUndefined();
      expect(toRacStatus({}).heatCapable).toBeUndefined();
    });

    it('stays undefined when WarmCapa is not a number', () => {
      expect(toRacStatus(withOptions('WarmCapa_NotAllowed')).heatCapable).toBeUndefined();
    });

    it('does not read Heat out of supportedModes, which is a separate question', () => {
      const status = toRacStatus({ Mode: { modes: ['Heat'], supportedModes: ['Cool', 'Dry', 'Wind', 'Auto'] } });
      expect(status.mode).toBe('Heat');
      expect(status.supportedModes).not.toContain('Heat');
      expect(status.heatCapable).toBeUndefined();
    });
  });

  it('reports no filter alarm when the unit lists none', () => {
    expect(toRacStatus({ Alarms: [] }).filterAlarm).toBe(false);
    expect(toRacStatus({}).filterAlarm).toBe(false);
  });

  it('survives a device document with nothing in it', () => {
    const empty = toRacStatus({});
    expect(empty.active).toBe(false);
    expect(Number.isNaN(empty.currentTemperature)).toBe(true);
    expect(empty.supportedModes).toEqual([]);
  });
});
