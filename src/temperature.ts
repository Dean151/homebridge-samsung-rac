/**
 * Temperature units.
 *
 * HomeKit transports every temperature in Celsius, always — the °F a user sees
 * in the Home app is a display conversion done on the phone. The unit, however,
 * reports whichever scale it was configured for, so everything above the
 * transport works in Celsius and this module is the only place that knows the
 * difference.
 *
 * Two traps this exists to avoid:
 *
 * 1. `Temperatures[0].unit` is the ONLY labelled scale in the device document.
 *    `Mode.options.OutdoorTemp_*` is Fahrenheit on the reference unit and says
 *    so nowhere (see notes/HANDOFF.md). Never infer one from the other.
 * 2. A Fahrenheit unit's numbers passed through unconverted look plausible
 *    rather than absurd — 71 °F arriving as "71 °C" is wrong by fifty degrees,
 *    but a HeaterCooler will happily display it.
 */

export type TemperatureUnit = 'C' | 'F';

/**
 * The reference unit spells it `"Celsius"`. Accept the obvious variants rather
 * than only that exact string, and treat anything unrecognised as Celsius:
 * it is what every unit seen so far reports, and it is also the scale HomeKit
 * wants, so an unknown value degrades to a no-op instead of a wrong conversion.
 */
export function normaliseTemperatureUnit(raw: string | undefined): TemperatureUnit {
  return /^f/i.test(raw?.trim() ?? '') ? 'F' : 'C';
}

/**
 * The step to advertise to HomeKit for a setpoint.
 *
 * A Fahrenheit unit stores whole degrees F, which is 5/9 °C ≈ 0.56 °C — finer
 * than HomeKit's usual 1 °C step. Advertising 0.5 °C keeps every value the unit
 * can hold reachable; 1 °C would put roughly half of them out of reach.
 */
export function setpointStep(unit: TemperatureUnit): number {
  return unit === 'F' ? 0.5 : 1;
}

/** Round to a grid, avoiding the float dust that makes 23.5 read as 23.499999. */
function roundTo(value: number, step: number): number {
  return Math.round(value / step) * step;
}

/**
 * A measurement from the unit, in Celsius. Kept at 0.1 °C: a whole degree F is
 * 0.56 °C, so rounding a reading harder than that would discard resolution the
 * unit actually has.
 */
export function toCelsius(value: number, unit: TemperatureUnit): number {
  if (!Number.isFinite(value)) {
    return value;
  }
  return unit === 'F' ? roundTo((value - 32) * 5 / 9, 0.1) : value;
}

/**
 * A setpoint or a range bound from the unit, in Celsius, snapped to the grid
 * HomeKit is told about in setpointStep(). Setpoints must land exactly on that
 * grid: HomeKit rejects a value off it, and the write path compares against
 * this to decide whether the unit took a change.
 */
export function toCelsiusSetpoint(value: number | undefined, unit: TemperatureUnit): number | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return value;
  }
  return unit === 'F' ? roundTo((value - 32) * 5 / 9, setpointStep(unit)) : value;
}

/**
 * Celsius back to what the unit stores: whole degrees, in its own scale.
 *
 * Not a lossless inverse of toCelsiusSetpoint, and it cannot be — the device
 * grid is coarser in places than the one HomeKit is offered. Callers that need
 * to know what a write will read back as must round-trip through this and
 * toCelsiusSetpoint rather than assuming they get their own value back.
 */
export function fromCelsius(celsius: number, unit: TemperatureUnit): number {
  return unit === 'F' ? Math.round(celsius * 9 / 5 + 32) : Math.round(celsius);
}
