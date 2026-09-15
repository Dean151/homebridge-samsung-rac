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
}

export interface NormalisedConfig {
  devices: DeviceConfig[];
  /** Seconds between status polls. This is a LAN, so it can be brisk. */
  updateInterval: number;
  requestTimeoutMs: number;
  /** What to write to Wind.direction when HomeKit asks for swing. */
  swingDirection: string;
  /**
   * How to read the unit's outdoor sensor, or null not to publish it at all.
   * Not inferable from the unit's own scale — see RacStatusOptions.
   */
  outdoorTemperatureUnit: 'C' | 'F' | null;
  certificateUrl?: string;
}

export const DEFAULT_UPDATE_INTERVAL = 10;
export const DEFAULT_REQUEST_TIMEOUT = 5;
export const DEFAULT_SWING_DIRECTION = 'Up_And_Low';
export const DEFAULT_OUTDOOR_TEMPERATURE_UNIT = 'F';

/**
 * 'fahrenheit' (the default, and the only behaviour observed on real hardware),
 * 'celsius', or 'off' to leave the sensor out. Anything unrecognised falls back
 * to the default rather than silently disabling a feature the user asked for.
 */
function toOutdoorUnit(value: unknown, log: Logging): 'C' | 'F' | null {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';

  if (!raw) {
    return DEFAULT_OUTDOOR_TEMPERATURE_UNIT;
  }
  if (raw === 'off' || raw === 'none' || raw === 'false') {
    return null;
  }
  if (raw.startsWith('c')) {
    return 'C';
  }
  if (raw.startsWith('f')) {
    return 'F';
  }

  log.warn(
    `Ignoring an unrecognised outdoorTemperature setting '${value}'; `
    + `using ${DEFAULT_OUTDOOR_TEMPERATURE_UNIT === 'F' ? 'Fahrenheit' : 'Celsius'}.`,
  );
  return DEFAULT_OUTDOOR_TEMPERATURE_UNIT;
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
    });
  }

  if (!devices.length) {
    log.info('No air conditioners are configured yet. Add one in the plugin settings and pair it there.');
  }

  return {
    devices,
    updateInterval: Math.max(5, toNumber(config.updateInterval, DEFAULT_UPDATE_INTERVAL)),
    requestTimeoutMs: Math.max(1, toNumber(config.requestTimeout, DEFAULT_REQUEST_TIMEOUT)) * 1000,
    swingDirection: typeof config.swingDirection === 'string' && config.swingDirection.trim()
      ? config.swingDirection.trim()
      : DEFAULT_SWING_DIRECTION,
    outdoorTemperatureUnit: toOutdoorUnit(config.outdoorTemperature, log),
    certificateUrl: typeof config.certificateUrl === 'string' && config.certificateUrl.trim()
      ? config.certificateUrl.trim()
      : undefined,
  };
}

function toNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
