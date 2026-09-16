import {
  DEFAULT_OUTDOOR_TEMPERATURE_PLACEMENT, DEFAULT_OUTDOOR_TEMPERATURE_UNIT, DEFAULT_SWING_DIRECTION,
  DEFAULT_UPDATE_INTERVAL, normaliseConfig,
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
      outdoorTemperaturePlacement: DEFAULT_OUTDOOR_TEMPERATURE_PLACEMENT,
      outdoorTemperatureUnit: DEFAULT_OUTDOOR_TEMPERATURE_UNIT,
      hideOutdoorTemperatureWhenOff: false,
      freezeIndoorTemperatureWhenOff: false,
    });
  });

  describe('the outdoor temperature setting', () => {
    const placementFor = (outdoorTemperature: unknown, log = logger()) =>
      normaliseConfig({ platform: 'x', outdoorTemperature } as never, log as never).outdoorTemperaturePlacement;

    it('defaults to the sensor sitting on the air conditioner', () => {
      expect(DEFAULT_OUTDOOR_TEMPERATURE_PLACEMENT).toBe('linked');
      expect(placementFor(undefined)).toBe('linked');
    });

    it('gives it an accessory of its own when asked', () => {
      expect(placementFor('separate')).toBe('separate');
      expect(placementFor(' Separate ')).toBe('separate');
    });

    it('switches the sensor off', () => {
      expect(placementFor('off')).toBeNull();
      expect(normaliseConfig({ platform: 'x', outdoorTemperature: 'off' } as never, logger() as never)
        .outdoorTemperatureUnit).toBeNull();
    });

    it('falls back to the default rather than silently dropping the sensor', () => {
      const log = logger();
      expect(placementFor('sideways', log)).toBe(DEFAULT_OUTDOOR_TEMPERATURE_PLACEMENT);
      expect(log.warn).toHaveBeenCalled();
    });
  });

  describe('hiding the outdoor reading while the unit is off', () => {
    const hideFor = (hideOutdoorTemperatureWhenOff: unknown, log = logger()) =>
      normaliseConfig({ platform: 'x', hideOutdoorTemperatureWhenOff } as never, log as never)
        .hideOutdoorTemperatureWhenOff;

    it('stays off unless asked for: a unit that reads correctly when idle should keep reporting', () => {
      expect(hideFor(undefined)).toBe(false);
      expect(hideFor(null)).toBe(false);
    });

    it('turns on when asked', () => {
      expect(hideFor(true)).toBe(true);
    });

    // A hand-written config.json is likelier to quote it than a form is.
    it('reads the string a hand-written config would use', () => {
      expect(hideFor('true')).toBe(true);
      expect(hideFor(' Yes ')).toBe(true);
      expect(hideFor('false')).toBe(false);
      expect(hideFor('no')).toBe(false);
    });

    it('leaves it off and says so when the value makes no sense', () => {
      const log = logger();
      expect(hideFor('sometimes', log)).toBe(false);
      expect(log.warn).toHaveBeenCalled();
    });
  });

  describe('freezing the room temperature while the unit is off', () => {
    const freezeFor = (freezeIndoorTemperatureWhenOff: unknown, log = logger()) =>
      normaliseConfig({ platform: 'x', freezeIndoorTemperatureWhenOff } as never, log as never)
        .freezeIndoorTemperatureWhenOff;

    it('stays off unless asked for', () => {
      expect(freezeFor(undefined)).toBe(false);
    });

    it('turns on when asked, however the config spells it', () => {
      expect(freezeFor(true)).toBe(true);
      expect(freezeFor('true')).toBe(true);
      expect(freezeFor('no')).toBe(false);
    });

    it('is independent of the outdoor setting: a unit can be wrong about one and not the other', () => {
      const settings = normaliseConfig(
        { platform: 'x', hideOutdoorTemperatureWhenOff: true } as never, logger() as never,
      );
      expect(settings.hideOutdoorTemperatureWhenOff).toBe(true);
      expect(settings.freezeIndoorTemperatureWhenOff).toBe(false);
    });

    it('leaves it off and says so when the value makes no sense', () => {
      const log = logger();
      expect(freezeFor('sometimes', log)).toBe(false);
      expect(log.warn).toHaveBeenCalled();
    });
  });

  describe('the outdoor temperature scale', () => {
    const scaleFor = (outdoorTemperatureUnit: unknown, log = logger()) =>
      normaliseConfig({ platform: 'x', outdoorTemperatureUnit } as never, log as never).outdoorTemperatureUnit;

    it('defaults to Fahrenheit, the only behaviour seen on real hardware', () => {
      expect(DEFAULT_OUTDOOR_TEMPERATURE_UNIT).toBe('F');
      expect(scaleFor(undefined)).toBe('F');
    });

    it('takes either scale, however it is written', () => {
      expect(scaleFor('fahrenheit')).toBe('F');
      expect(scaleFor('Celsius')).toBe('C');
      expect(scaleFor(' c ')).toBe('C');
    });

    it('falls back to the default rather than silently dropping the sensor', () => {
      const log = logger();
      expect(scaleFor('kelvin', log)).toBe(DEFAULT_OUTDOOR_TEMPERATURE_UNIT);
      expect(log.warn).toHaveBeenCalled();
    });
  });

  describe('a config written before the setting was split in two', () => {
    // 0.2.0 wrote the scale into outdoorTemperature itself. Those configs are
    // still out there and have to keep behaving exactly as they did.
    const settingsFor = (outdoorTemperature: unknown) =>
      normaliseConfig({ platform: 'x', outdoorTemperature } as never, logger() as never);

    it('reads the scale it names, and shows the sensor the only way it could then', () => {
      expect(settingsFor('celsius')).toMatchObject({
        outdoorTemperaturePlacement: 'linked',
        outdoorTemperatureUnit: 'C',
      });
      expect(settingsFor('fahrenheit')).toMatchObject({
        outdoorTemperaturePlacement: 'linked',
        outdoorTemperatureUnit: 'F',
      });
    });

    it('is overridden by the scale picker once that has been saved', () => {
      const settings = normaliseConfig(
        { platform: 'x', outdoorTemperature: 'fahrenheit', outdoorTemperatureUnit: 'celsius' } as never,
        logger() as never,
      );
      expect(settings.outdoorTemperatureUnit).toBe('C');
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

  describe('devices[].heating', () => {
    const heating = (value: unknown) => normaliseConfig(
      { platform: 'x', devices: [{ host: '10.0.0.1', heating: value }] },
      logger() as never,
    ).devices[0].heating;

    it('leaves detection to the unit by default', () => {
      expect(heating(undefined)).toBeUndefined();
      expect(heating('auto')).toBeUndefined();
      expect(heating('')).toBeUndefined();
    });

    it('forces heat on or off when asked', () => {
      expect(heating('on')).toBe(true);
      expect(heating('off')).toBe(false);
    });

    it('accepts the booleans a hand-written config.json is likely to use', () => {
      expect(heating(true)).toBe(true);
      expect(heating(false)).toBe(false);
      expect(heating('true')).toBe(true);
      expect(heating('false')).toBe(false);
    });

    it('falls back to detection on a value it cannot read, and says so', () => {
      const log = logger();
      const settings = normaliseConfig(
        { platform: 'x', devices: [{ host: '10.0.0.1', heating: 'maybe' }] },
        log as never,
      );
      expect(settings.devices[0].heating).toBeUndefined();
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('heating'));
    });
  });

  describe('the switch lists', () => {
    const modesFor = (convenienceModes: unknown, log = logger()) =>
      normaliseConfig({ platform: 'x', convenienceModes } as never, log as never).convenienceModes;

    it('publishes no switches until asked, for want of anything to detect from', () => {
      const settings = normaliseConfig({ platform: 'x' }, logger() as never);
      expect(settings.convenienceModes).toEqual([]);
      expect(settings.modeSwitches).toEqual([]);
    });

    it('keeps the names as written, since the casing is the unit\'s business', () => {
      expect(modesFor(['Quiet', '2Step'])).toEqual([{ value: 'Quiet' }, { value: '2Step' }]);
    });

    it('accepts a comma-separated string, which a hand-written config may well hold', () => {
      expect(modesFor('Quiet, Comfort')).toEqual([{ value: 'Quiet' }, { value: 'Comfort' }]);
    });

    it('drops blanks and case-insensitive duplicates', () => {
      expect(modesFor(['Quiet', '', '  ', 'quiet'])).toEqual([{ value: 'Quiet' }]);
    });

    it('refuses Off, which is what every other switch in the group already means', () => {
      const log = logger();
      expect(modesFor(['Off', 'Quiet'], log)).toEqual([{ value: 'Quiet' }]);
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('convenienceModes'));
    });

    it('ignores a setting that is not a list at all', () => {
      const log = logger();
      expect(modesFor(42, log)).toEqual([]);
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('convenienceModes'));
    });

    it('reads the mode switches the same way', () => {
      const settings = normaliseConfig(
        { platform: 'x', modeSwitches: ['Dry', 'Wind', 'dry'] } as never, logger() as never);
      expect(settings.modeSwitches).toEqual([{ value: 'Dry' }, { value: 'Wind' }]);
    });

    describe('naming a switch', () => {
      it('carries the name alongside the mode', () => {
        expect(modesFor([{ mode: 'Quiet', name: 'Silence' }]))
          .toEqual([{ value: 'Quiet', name: 'Silence' }]);
      });

      it('takes value as a spelling of mode, since neither is obvious for both groups', () => {
        expect(modesFor([{ value: 'Quiet', name: 'Silence' }]))
          .toEqual([{ value: 'Quiet', name: 'Silence' }]);
      });

      it('leaves an unnamed object exactly where a bare string would leave it', () => {
        expect(modesFor([{ mode: 'Quiet' }])).toEqual([{ value: 'Quiet' }]);
        expect(modesFor([{ mode: 'Quiet', name: '   ' }])).toEqual([{ value: 'Quiet' }]);
      });

      it('mixes the two shapes, so one named entry need not rewrite the rest', () => {
        expect(modesFor(['Comfort', { mode: 'Quiet', name: 'Silence' }]))
          .toEqual([{ value: 'Comfort' }, { value: 'Quiet', name: 'Silence' }]);
      });

      it('still counts a named entry as the same mode when deduplicating', () => {
        const log = logger();
        expect(modesFor([{ mode: 'Quiet', name: 'Silence' }, 'quiet'], log))
          .toEqual([{ value: 'Quiet', name: 'Silence' }]);
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('one switch per mode'));
      });

      it('drops a name with no mode behind it, which would wire a switch to nothing', () => {
        const log = logger();
        expect(modesFor([{ name: 'Silence' }], log)).toEqual([]);
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('convenienceModes'));
      });

      it('drops an entry that is neither a name nor an object, and says so', () => {
        const log = logger();
        expect(modesFor([42, 'Quiet'], log)).toEqual([{ value: 'Quiet' }]);
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('convenienceModes'));
      });

      it('refuses Off however it is spelled', () => {
        expect(modesFor([{ mode: 'Off', name: 'Nothing' }], logger())).toEqual([]);
      });
    });
  });

  it('refuses a poll interval that would hammer the unit', () => {
    expect(normaliseConfig({ platform: 'x', updateInterval: 1 }, logger() as never).updateInterval).toBe(5);
  });

  it('ignores values that are not numbers at all', () => {
    const settings = normaliseConfig({ platform: 'x', updateInterval: 'soon' }, logger() as never);
    expect(settings.updateInterval).toBe(DEFAULT_UPDATE_INTERVAL);
  });
});
