/**
 * The raw shape of `GET /devices` on the unit, and the flat DTO everything
 * above the transport works with.
 *
 * A real capture from the reference unit (TP6X_RAC_16K) lives in
 * tests/fixtures/devices.json and is the fixture for the parser tests.
 */

import {
  normaliseTemperatureUnit,
  toCelsius,
  toCelsiusSetpoint,
  type TemperatureUnit,
} from './temperature';

export interface RacAlarm {
  alarmType?: string;
  code?: string;
  id?: string;
  triggeredTime?: string;
}

export interface RacTemperature {
  id?: string;
  current?: number;
  desired?: number;
  minimum?: number;
  maximum?: number;
  unit?: string;
}

export interface RacDeviceDocument {
  id?: string;
  uuid?: string;
  name?: string;
  description?: string;
  type?: string;
  connected?: boolean;
  resources?: string[];
  Alarms?: RacAlarm[];
  Mode?: { modes?: string[]; supportedModes?: string[]; options?: string[] };
  Operation?: { power?: string };
  Temperatures?: RacTemperature[];
  Wind?: { direction?: string; speedLevel?: number; maxSpeedLevel?: number };
}

export interface RacDevicesResponse {
  Devices?: RacDeviceDocument[];
}

export interface RacStatusOptions {
  /**
   * How to read `Mode.options.OutdoorTemp`, or null to leave it out entirely.
   *
   * Deliberately NOT inferred from `Temperatures[].unit`. The reference unit
   * reports its own temperatures in Celsius and its outdoor sensor in
   * Fahrenheit, in the same document, with only the former labelled — so the
   * two scales are independent and one says nothing about the other.
   * Fahrenheit is the default because it is the only behaviour ever observed,
   * but for any other model that is a guess, which is why it is configurable.
   */
  outdoorTemperatureUnit?: TemperatureUnit | null;
}

/** Everything the HomeKit layer is allowed to know about the unit. */
export interface RacStatus {
  active: boolean;
  mode: string;
  supportedModes: string[];
  currentTemperature: number;
  targetTemperature: number;
  minSetpoint?: number;
  maxSetpoint?: number;
  /** Which entry of `Temperatures` the setpoint belongs to; usually '0'. */
  temperatureId: string;
  /**
   * The scale the UNIT stores its temperatures in. Every temperature above is
   * already Celsius regardless; this is here so the write path can convert
   * back. See ./temperature.ts.
   */
  temperatureUnit: TemperatureUnit;
  windDirection?: string;
  speedLevel?: number;
  maxSpeedLevel?: number;
  filterAlarm: boolean;
  /**
   * The outdoor sensor reading in Celsius, absent when the unit does not
   * publish one or publishes something that cannot be a temperature.
   */
  outdoorTemperature?: number;
  /** The unit's own resource list, e.g. ['Alarms', 'Mode', 'Wind', ...]. */
  resources: string[];
  options: Record<string, string>;
  connected: boolean;
  id: string;
  uuid?: string;
  name?: string;
  model?: string;
}

/**
 * `Mode.options` is a flat array of `Key_Value` strings. Split on the LAST
 * underscore: several keys contain one themselves (`FilterCleanAlarm_0`,
 * `UpdateAllow_NotAllowed`), and values can too.
 */
export function parseOptions(options: string[] | undefined): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const option of options ?? []) {
    const separator = option.lastIndexOf('_');
    if (separator <= 0) {
      continue;
    }
    parsed[option.slice(0, separator)] = option.slice(separator + 1);
  }
  return parsed;
}

function firstFinite(...values: (number | undefined)[]): number | undefined {
  return values.find((value) => Number.isFinite(value));
}

/**
 * Outdoor temperatures a room air conditioner could plausibly be reporting, in
 * Celsius. `Mode.options` is a grab-bag of unrelated counters — `UsagesDB_254`,
 * `OptionCode_53432` — so a unit that does not publish OutdoorTemp at all, or
 * publishes something that is not a temperature, must not reach HomeKit as a
 * confident reading of 123 °C.
 */
const plausibleOutdoorCelsius = { min: -60, max: 70 };

function outdoorTemperatureFrom(
  options: Record<string, string>,
  unit: TemperatureUnit | null | undefined,
): number | undefined {
  if (unit === null) {
    return undefined;
  }

  const raw = options.OutdoorTemp?.trim();
  if (!raw) {
    return undefined;
  }

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return undefined;
  }

  const celsius = toCelsius(value, unit ?? 'F');
  return celsius >= plausibleOutdoorCelsius.min && celsius <= plausibleOutdoorCelsius.max
    ? celsius
    : undefined;
}

export function toRacStatus(device: RacDeviceDocument, settings: RacStatusOptions = {}): RacStatus {
  const temperature = device.Temperatures?.[0];

  // Normalise to Celsius here, at the transport boundary, so that nothing above
  // this file has to remember which scale a given unit reports in.
  const unit = normaliseTemperatureUnit(temperature?.unit);
  const modeOptions = parseOptions(device.Mode?.options);

  return {
    active: device.Operation?.power === 'On',
    // `modes` is the active mode list; the unit reports exactly one.
    mode: device.Mode?.modes?.[0] ?? '',
    supportedModes: device.Mode?.supportedModes ?? [],
    currentTemperature: toCelsius(temperature?.current ?? NaN, unit),
    targetTemperature: toCelsiusSetpoint(temperature?.desired, unit) ?? NaN,
    temperatureId: temperature?.id ?? '0',
    temperatureUnit: unit,
    minSetpoint: toCelsiusSetpoint(firstFinite(temperature?.minimum), unit),
    maxSetpoint: toCelsiusSetpoint(firstFinite(temperature?.maximum), unit),
    windDirection: device.Wind?.direction,
    speedLevel: firstFinite(device.Wind?.speedLevel),
    maxSpeedLevel: firstFinite(device.Wind?.maxSpeedLevel),
    filterAlarm: (device.Alarms ?? []).some((alarm) => alarm.code === 'FilterAlarm'),
    outdoorTemperature: outdoorTemperatureFrom(modeOptions, settings.outdoorTemperatureUnit),
    resources: device.resources ?? [],
    options: modeOptions,
    connected: device.connected !== false,
    id: device.id ?? '0',
    uuid: device.uuid,
    name: device.name,
    model: device.description,
  };
}

/** Pull the device entries out of a `GET /devices` response. */
export function devicesFrom(response: RacDevicesResponse): RacDeviceDocument[] {
  return response.Devices ?? [];
}
