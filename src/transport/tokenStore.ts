import * as path from 'node:path';
import { readFileOrNull, writeFileAtomic } from './atomic';
import { storageDirectory } from './certificate';
import { normaliseDeviceUuid } from '../discovery/ssdp';

/**
 * Device tokens live beside the certificate rather than in config.json.
 *
 * IMPORTANT: this file is read and written from two places — the running plugin
 * (through this module) and the custom UI server (homebridge-ui/server.js,
 * which requires the compiled build of this very file). Keep them in sync by
 * never duplicating the shape; the UI must go through this class.
 */
export const TOKEN_FILE_NAME = 'tokens.json';

export interface DeviceTokenRecord {
  token: string;
  deviceUuid?: string;
  model?: string;
  name?: string;
  pairedAt?: string;
}

type TokenFile = Record<string, DeviceTokenRecord>;

export class TokenStore {
  private readonly filePath: string;

  constructor(homebridgeStoragePath: string) {
    this.filePath = path.join(storageDirectory(homebridgeStoragePath), TOKEN_FILE_NAME);
  }

  get path(): string {
    return this.filePath;
  }

  async all(): Promise<TokenFile> {
    const raw = await readFileOrNull(this.filePath);
    if (!raw) {
      return {};
    }
    try {
      const parsed = JSON.parse(raw.toString('utf8'));
      return typeof parsed === 'object' && parsed !== null ? (parsed as TokenFile) : {};
    } catch {
      // A corrupt store must not take the whole plugin down: the user can
      // re-pair, which is the same recovery as a missing file.
      return {};
    }
  }

  async get(host: string): Promise<DeviceTokenRecord | null> {
    return (await this.all())[host] ?? null;
  }

  /** Find existing pairings after DHCP moves without rewriting or exposing credentials. */
  async getForDevice(host: string, deviceUuid?: string): Promise<DeviceTokenRecord | null> {
    if (!deviceUuid) {
      return this.get(host);
    }
    const uuid = normaliseDeviceUuid(deviceUuid);
    if (!uuid) {
      return null;
    }
    const all = await this.all();
    const matches = Object.values(all).filter(record => record && typeof record.token === 'string'
      && normaliseDeviceUuid(record.deviceUuid) === uuid);
    // A later pairing may replace an old token still stored under a previous IP.
    matches.sort((a, b) => (b.pairedAt ?? '').localeCompare(a.pairedAt ?? ''));
    if (matches.length) {
      return matches[0];
    }
    const legacy = all[host];
    return legacy && !legacy.deviceUuid ? legacy : null;
  }

  async set(host: string, record: DeviceTokenRecord): Promise<void> {
    const all = await this.all();
    all[host] = { ...record, pairedAt: record.pairedAt ?? new Date().toISOString() };
    await writeFileAtomic(this.filePath, JSON.stringify(all, null, 2));
  }

  async remove(host: string): Promise<void> {
    const all = await this.all();
    if (!(host in all)) {
      return;
    }
    delete all[host];
    await writeFileAtomic(this.filePath, JSON.stringify(all, null, 2));
  }

  async removeForDevice(host: string, deviceUuid?: string): Promise<void> {
    if (!deviceUuid) {
      return this.remove(host);
    }
    const uuid = normaliseDeviceUuid(deviceUuid);
    if (!uuid) {
      throw new Error('Invalid device UUID.');
    }
    const all = await this.all();
    for (const [key, record] of Object.entries(all)) {
      if (normaliseDeviceUuid(record?.deviceUuid) === uuid || (key === host && record && !record.deviceUuid)) {
        delete all[key];
      }
    }
    await writeFileAtomic(this.filePath, JSON.stringify(all, null, 2));
  }
}
