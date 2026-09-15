import {
  DEFAULT_OUTDOOR_TEMPERATURE_UNIT, DEFAULT_SWING_DIRECTION, DEFAULT_UPDATE_INTERVAL, normaliseConfig,
} from '../../src/config';

function logger() {
  return { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

describe('normaliseConfig', () => {
  it('fills in the defaults', () => {
    const settings = normaliseConfig({ platform: 'SamsungRacLocal' }, logger() as never);
    expect(settings).toMatchObject({
      devices: [],
      updateInterval: DEFAULT_UPDATE_INTERVAL,
      requestTimeoutMs: 5000,
      swingDirection: DEFAULT_SWING_DIRECTION,
      outdoorTemperatureUnit: DEFAULT_OUTDOOR_TEMPERATURE_UNIT,
    });
  });

  describe('the outdoor temperature setting', () => {
    const settingFor = (outdoorTemperature: unknown, log = logger()) =>
      normaliseConfig({ platform: 'x', outdoorTemperature } as never, log as never).outdoorTemperatureUnit;

    it('defaults to Fahrenheit, the only behaviour seen on real hardware', () => {
      expect(DEFAULT_OUTDOOR_TEMPERATURE_UNIT).toBe('F');
      expect(settingFor(undefined)).toBe('F');
    });

    it('takes either scale, however it is written', () => {
      expect(settingFor('fahrenheit')).toBe('F');
      expect(settingFor('Celsius')).toBe('C');
      expect(settingFor(' c ')).toBe('C');
    });

    it('switches the sensor off', () => {
      expect(settingFor('off')).toBeNull();
    });

    it('falls back to the default rather than silently dropping the sensor', () => {
      const log = logger();
      expect(settingFor('kelvin', log)).toBe(DEFAULT_OUTDOOR_TEMPERATURE_UNIT);
      expect(log.warn).toHaveBeenCalled();
    });
  });

  it('keeps several units, which is the point of a list', () => {
    const settings = normaliseConfig(
      { platform: 'x', devices: [{ host: '10.0.0.1', name: 'Lounge' }, { host: '10.0.0.2' }] },
      logger() as never,
    );
    expect(settings.devices).toEqual([
      { host: '10.0.0.1', name: 'Lounge', token: undefined },
      { host: '10.0.0.2', name: undefined, token: undefined },
    ]);
  });

  it('drops entries with no address instead of registering a broken accessory', () => {
    const log = logger();
    const settings = normaliseConfig({ platform: 'x', devices: [{ name: 'Nowhere' }, { host: '  ' }] }, log as never);
    expect(settings.devices).toEqual([]);
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it('drops a duplicate host so two accessories cannot fight over one unit', () => {
    const log = logger();
    const settings = normaliseConfig(
      { platform: 'x', devices: [{ host: '10.0.0.1' }, { host: '10.0.0.1' }] },
      log as never,
    );
    expect(settings.devices).toHaveLength(1);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('duplicate'));
  });

  it('refuses a poll interval that would hammer the unit', () => {
    expect(normaliseConfig({ platform: 'x', updateInterval: 1 }, logger() as never).updateInterval).toBe(5);
  });

  it('ignores values that are not numbers at all', () => {
    const settings = normaliseConfig({ platform: 'x', updateInterval: 'soon' }, logger() as never);
    expect(settings.updateInterval).toBe(DEFAULT_UPDATE_INTERVAL);
  });
});
