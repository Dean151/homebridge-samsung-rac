import {
  fromCelsius,
  normaliseTemperatureUnit,
  setpointStep,
  toCelsius,
  toCelsiusSetpoint,
} from '../../src/temperature';

describe('normaliseTemperatureUnit', () => {
  it('recognises how the reference unit spells Celsius', () => {
    expect(normaliseTemperatureUnit('Celsius')).toBe('C');
  });

  it('recognises Fahrenheit however it is spelled', () => {
    for (const spelling of ['Fahrenheit', 'fahrenheit', 'F', 'f', ' F ']) {
      expect(normaliseTemperatureUnit(spelling)).toBe('F');
    }
  });

  it('falls back to Celsius for a missing or unrecognised unit', () => {
    // Celsius is both what every unit seen so far reports and the scale HomeKit
    // wants, so guessing it wrong is a no-op rather than a 50-degree error.
    expect(normaliseTemperatureUnit(undefined)).toBe('C');
    expect(normaliseTemperatureUnit('')).toBe('C');
    expect(normaliseTemperatureUnit('Kelvin')).toBe('C');
  });
});

describe('toCelsius', () => {
  it('leaves a Celsius reading alone', () => {
    expect(toCelsius(23, 'C')).toBe(23);
  });

  it('converts the reading that settled the OutdoorTemp question', () => {
    // 2026-09-15: the unit reported 71 while it was genuinely 21°C outside.
    expect(toCelsius(71, 'F')).toBe(21.7);
    expect(toCelsius(74, 'F')).toBe(23.3);
  });

  it('does not hand HomeKit binary float dust', () => {
    // 71°F is 21.666…°C. Rounding it as `Math.round(v / 0.1) * 0.1` yields
    // 21.700000000000003, and that is the number the log and HomeKit then show.
    for (let f = -40; f <= 130; f++) {
      const celsius = toCelsius(f, 'F');
      expect(String(celsius)).toBe(String(Number(celsius.toFixed(1))));
    }
  });

  it('passes NaN through rather than inventing a temperature', () => {
    expect(toCelsius(NaN, 'F')).toBeNaN();
  });
});

describe('toCelsiusSetpoint', () => {
  it('snaps a Fahrenheit setpoint onto the grid HomeKit is told about', () => {
    expect(toCelsiusSetpoint(75, 'F')).toBe(24);
    expect(toCelsiusSetpoint(74, 'F')).toBe(23.5);
    expect(toCelsiusSetpoint(60, 'F')).toBe(15.5);
  });

  it('preserves undefined, so a unit that reports no range still reports none', () => {
    expect(toCelsiusSetpoint(undefined, 'F')).toBeUndefined();
    expect(toCelsiusSetpoint(undefined, 'C')).toBeUndefined();
  });
});

describe('fromCelsius', () => {
  it('writes whole degrees in the unit\'s own scale', () => {
    expect(fromCelsius(24, 'C')).toBe(24);
    expect(fromCelsius(24, 'F')).toBe(75);
    expect(fromCelsius(23.5, 'F')).toBe(74);
  });
});

describe('round-tripping a setpoint', () => {
  /**
   * The property the write path depends on: whatever we send, reading it back
   * and converting must give the value setTargetTemperature predicted. If this
   * breaks, every setpoint write on a Fahrenheit unit is reported as silently
   * discarded — the one failure this plugin exists to detect.
   */
  it('is stable for every step on the advertised grid', () => {
    const step = setpointStep('F');
    for (let celsius = 15.5; celsius <= 30; celsius += step) {
      const device = fromCelsius(celsius, 'F');
      const readBack = toCelsiusSetpoint(device, 'F') as number;

      expect(Number.isInteger(device)).toBe(true);
      // Re-sending what we read back must not drift further.
      expect(fromCelsius(readBack, 'F')).toBe(device);
    }
  });

  it('is exact for Celsius units, where the grids match', () => {
    for (let celsius = 16; celsius <= 30; celsius++) {
      expect(toCelsiusSetpoint(fromCelsius(celsius, 'C'), 'C')).toBe(celsius);
    }
  });
});
