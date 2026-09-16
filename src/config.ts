import type { Logging, PlatformConfig } from 'homebridge';

/**
 * Config is normalised once, here, rather than defaulted with `??` at every use
 * site — otherwise every consumer has to re-read `platform.config` and the
 * defaults drift apart.
 */

export interface DeviceConfig {
  name?: string;
  host: string;
  /** Optional: overrides the paired token in the token store. */
  token?: string;
  /**
   * Force heat support on or off, or undefined to work it out from the unit.
   * Needed because `Mode.supportedModes` omits modes the unit really has — see
   * RacStatus.heatCapable.
   */
  heating?: boolean;
}

/**
 * One switch the user asked for, in either group.
 *
 * `value` is the unit's own word — what gets written, what the switch reads
 * itself back from, and what its HomeKit subtype is keyed on. Renaming a switch
 * therefore never disturbs the automations pointing at it.
 */
export interface ModeSwitchConfig {
  value: string;
  /**
   * What to call it in the Home app, used exactly as written — no air
   * conditioner name in front of it. Undefined falls back to the derived
   * '<air conditioner> <mode>', which is what every config before 0.4.0 got.
   */
  name?: string;
}

/** 'linked' hangs the sensor off the air conditioner; 'separate' gives it its own accessory. */
export type OutdoorTemperaturePlacement = 'linked' | 'separate';

export interface NormalisedConfig {
  devices: DeviceConfig[];
  /** Seconds between status polls. This is a LAN, so it can be brisk. */
  updateInterval: number;
  requestTimeoutMs: number;
  /** What to write to Wind.direction when HomeKit asks for swing. */
  swingDirection: string;
  /**
   * Where the unit's outdoor sensor goes in HomeKit: on the air conditioner
   * itself, where it takes the AC's room, or as an accessory of its own, which
   * can be put in a different room. Null leaves it out entirely.
   */
  outdoorTemperaturePlacement: OutdoorTemperaturePlacement | null;
  /**
   * How to read the unit's outdoor sensor, or null not to publish it at all.
   * Not inferable from the unit's own scale — see RacStatusOptions.
   * Null exactly when the placement is null, so either can be tested for.
   */
  outdoorTemperatureUnit: 'C' | 'F' | null;
  /**
   * Whether to stop reporting the outdoor reading while the unit is off. Some
   * units keep publishing a figure with the compressor stopped, and it is not
   * one the sensor measured — on the reference unit it drifts towards the
   * indoor temperature. Off by default: a unit that reads correctly when idle
   * should keep reporting, and this is not detectable from what it publishes.
   */
  hideOutdoorTemperatureWhenOff: boolean;
  /**
   * Whether to hold the room temperature at its last running value while the
   * unit is off, rather than report what the unit publishes with the fan
   * stopped. Same unreliability as the outdoor sensor, but this one cannot be
   * answered with "No Response": CurrentTemperature is required on
   * HeaterCooler, so an error there takes the whole tile — and the means of
   * switching the unit back on — with it. Off by default.
   */
  freezeIndoorTemperatureWhenOff: boolean;
  /**
   * Which `Comode` values get a switch in HomeKit — the convenience modes,
   * where WindFree lives. Empty by default, and deliberately so: the unit
   * publishes the value it holds but never the ones it would accept, so any
   * default would be a guess that leaves dead switches on a model whose
   * vocabulary differs. See RacStatus.comode.
   */
  convenienceModes: ModeSwitchConfig[];
  /**
   * Which `Mode.modes` values get a switch — the modes `HeaterCooler` has no
   * way to express, `Dry` and `Wind`. Without one they can only be reached from
   * the Samsung app; the plugin reports them as Auto and leaves them alone.
   */
  modeSwitches: ModeSwitchConfig[];
  certificateUrl?: string;
}

export const DEFAULT_UPDATE_INTERVAL = 10;
export const DEFAULT_REQUEST_TIMEOUT = 5;
export const DEFAULT_SWING_DIRECTION = 'Up_And_Low';
export const DEFAULT_OUTDOOR_TEMPERATURE_PLACEMENT: OutdoorTemperaturePlacement = 'linked';
export const DEFAULT_OUTDOOR_TEMPERATURE_UNIT = 'F';

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * 'linked' (the default), 'separate', or 'off' to leave the sensor out.
 *
 * Up to 0.2.0 this key carried the scale instead — 'fahrenheit' or 'celsius' —
 * and those configs are still out there, meaning "show it", the only way it was
 * shown then. The scale they name is read by toOutdoorUnit below, so such a
 * config keeps behaving exactly as it did.
 */
function toOutdoorPlacement(value: unknown, log: Logging): OutdoorTemperaturePlacement | null {
  const raw = text(value);

  if (!raw) {
    return DEFAULT_OUTDOOR_TEMPERATURE_PLACEMENT;
  }
  if (raw === 'off' || raw === 'none' || raw === 'false') {
    return null;
  }
  if (raw === 'separate' || raw === 'accessory' || raw === 'device') {
    return 'separate';
  }
  if (raw === 'linked' || raw === 'on' || raw === 'true') {
    return 'linked';
  }
  if (raw.startsWith('c') || raw.startsWith('f')) {
    return 'linked';
  }

  log.warn(
    `Ignoring an unrecognised outdoorTemperature setting '${value}'; `
    + 'showing the sensor on the air conditioner itself.',
  );
  return DEFAULT_OUTDOOR_TEMPERATURE_PLACEMENT;
}

/**
 * The scale the outdoor sensor reports in, which the unit states nowhere — see
 * RacStatusOptions. Reads `outdoorTemperatureUnit`, falling back to the scale a
 * pre-0.3.0 config wrote into `outdoorTemperature` itself.
 */
function toOutdoorUnit(value: unknown, legacy: unknown, log: Logging): 'C' | 'F' {
  const carried = text(legacy);
  const raw = text(value) || (carried.startsWith('c') || carried.startsWith('f') ? carried : '');

  if (!raw) {
    return DEFAULT_OUTDOOR_TEMPERATURE_UNIT;
  }
  if (raw.startsWith('c')) {
    return 'C';
  }
  if (raw.startsWith('f')) {
    return 'F';
  }

  log.warn(
    `Ignoring an unrecognised outdoorTemperatureUnit setting '${value}'; `
    + `using ${DEFAULT_OUTDOOR_TEMPERATURE_UNIT === 'F' ? 'Fahrenheit' : 'Celsius'}.`,
  );
  return DEFAULT_OUTDOOR_TEMPERATURE_UNIT;
}

/**
 * 'auto' (the default) detects heating from the unit, 'on' and 'off' force it.
 * Booleans are accepted too, because a hand-written config.json is likelier to
 * say `true` than `"on"`.
 */
function toHeating(value: unknown, host: string, log: Logging): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }

  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!raw || raw === 'auto') {
    return undefined;
  }
  if (raw === 'on' || raw === 'true' || raw === 'yes') {
    return true;
  }
  if (raw === 'off' || raw === 'false' || raw === 'no') {
    return false;
  }

  log.warn(
    `Ignoring an unrecognised heating setting '${value}' for ${host}; `
    + 'detecting heat support from the unit instead.',
  );
  return undefined;
}

export function normaliseConfig(config: PlatformConfig, log: Logging): NormalisedConfig {
  const raw = Array.isArray(config.devices) ? (config.devices as unknown[]) : [];
  const devices: DeviceConfig[] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    const candidate = entry as Partial<DeviceConfig> | null;
    const host = typeof candidate?.host === 'string' ? candidate.host.trim() : '';

    if (!host) {
      log.warn('Ignoring a device in the config with no host address.');
      continue;
    }
    if (seen.has(host)) {
      log.warn(`Ignoring a duplicate device entry for ${host}.`);
      continue;
    }

    seen.add(host);
    devices.push({
      host,
      name: typeof candidate?.name === 'string' && candidate.name.trim() ? candidate.name.trim() : undefined,
      token: typeof candidate?.token === 'string' && candidate.token.trim() ? candidate.token.trim() : undefined,
      heating: toHeating((candidate as { heating?: unknown } | null)?.heating, host, log),
    });
  }

  if (!devices.length) {
    log.info('No air conditioners are configured yet. Add one in the plugin settings and pair it there.');
  }

  const placement = toOutdoorPlacement(config.outdoorTemperature, log);

  return {
    devices,
    updateInterval: Math.max(5, toNumber(config.updateInterval, DEFAULT_UPDATE_INTERVAL)),
    requestTimeoutMs: Math.max(1, toNumber(config.requestTimeout, DEFAULT_REQUEST_TIMEOUT)) * 1000,
    swingDirection: typeof config.swingDirection === 'string' && config.swingDirection.trim()
      ? config.swingDirection.trim()
      : DEFAULT_SWING_DIRECTION,
    outdoorTemperaturePlacement: placement,
    outdoorTemperatureUnit: placement === null
      ? null
      : toOutdoorUnit(config.outdoorTemperatureUnit, config.outdoorTemperature, log),
    hideOutdoorTemperatureWhenOff: toBoolean(config.hideOutdoorTemperatureWhenOff, 'hideOutdoorTemperatureWhenOff', log),
    freezeIndoorTemperatureWhenOff: toBoolean(
      config.freezeIndoorTemperatureWhenOff, 'freezeIndoorTemperatureWhenOff', log),
    convenienceModes: toSwitchList(config.convenienceModes, 'convenienceModes', log),
    modeSwitches: toSwitchList(config.modeSwitches, 'modeSwitches', log),
    certificateUrl: typeof config.certificateUrl === 'string' && config.certificateUrl.trim()
      ? config.certificateUrl.trim()
      : undefined,
  };
}

/**
 * The switches asked for in one group, from any of the shapes a config may hold.
 *
 * Three of them, because this key has had two lives. Up to 0.3.1 it was a list
 * of the unit's own names and nothing else — `["Quiet"]`, or `"Quiet,Comfort"`
 * from a hand-written config.json — and those still mean exactly what they
 * meant. From 0.4.0 an entry can instead be an object carrying the name to show
 * in the Home app alongside the unit's word for the mode.
 *
 * Case is the unit's business, so `value` is kept as written and only
 * duplicates that differ by case are dropped.
 */
function toSwitchList(value: unknown, key: string, log: Logging): ModeSwitchConfig[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];

  if (!Array.isArray(value) && typeof value !== 'string' && value !== undefined && value !== null) {
    log.warn(`Ignoring a ${key} setting that is neither a list nor a comma-separated string.`);
    return [];
  }

  const entries: ModeSwitchConfig[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    const entry = toSwitchEntry(item, key, log);
    if (!entry) {
      continue;
    }
    // A switch for 'Off' would be the off position of every other switch in the
    // group, permanently disagreeing with them.
    if (entry.value.toLowerCase() === 'off') {
      log.warn(`Ignoring 'Off' in ${key}: switching a convenience mode off is what the other switches do.`);
      continue;
    }
    if (seen.has(entry.value.toLowerCase())) {
      log.warn(`Ignoring a second ${key} entry for '${entry.value}'; one switch per mode.`);
      continue;
    }
    seen.add(entry.value.toLowerCase());
    entries.push(entry);
  }

  return entries;
}

/**
 * One entry: the unit's name on its own, or an object pairing it with the name
 * to show. `mode` and `value` both name the mode, since neither spelling is the
 * obvious one for both groups and a hand-written config may reach for either.
 */
function toSwitchEntry(item: unknown, key: string, log: Logging): ModeSwitchConfig | null {
  if (typeof item === 'string') {
    const value = item.trim();
    return value ? { value } : null;
  }

  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    log.warn(`Ignoring a ${key} entry that is neither a mode name nor an object naming one.`);
    return null;
  }

  const candidate = item as { mode?: unknown; value?: unknown; name?: unknown };
  const value = trimmed(candidate.mode) || trimmed(candidate.value);

  if (!value) {
    // A name with no mode behind it would publish a switch wired to nothing.
    log.warn(`Ignoring a ${key} entry with no mode name in it.`);
    return null;
  }

  const name = trimmed(candidate.name);
  return name ? { value, name } : { value };
}

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * A plain opt-in flag: absent means off. A hand-written config.json may say
 * `"true"` rather than `true`, so both are read.
 */
function toBoolean(value: unknown, key: string, log: Logging): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === 'boolean') {
    return value;
  }

  const raw = text(value);
  if (raw === 'true' || raw === 'on' || raw === 'yes') {
    return true;
  }
  if (raw === 'false' || raw === 'off' || raw === 'no' || raw === '') {
    return false;
  }

  log.warn(`Ignoring an unrecognised ${key} setting '${value}'; leaving it off.`);
  return false;
}

function toNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
