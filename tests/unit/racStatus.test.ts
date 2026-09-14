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

  it('exposes the unit resource list, which is what gates optional services', () => {
    expect(status.resources).toContain('Alarms');
    expect(status.resources).toContain('Wind');
  });

  it('parses the flat Mode.options array', () => {
    expect(status.options.OutdoorTemp).toBe('74');
    expect(status.options.FilterAlarmTime).toBe('500');
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
