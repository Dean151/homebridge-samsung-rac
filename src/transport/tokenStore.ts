import * as path from 'node:path';
import { readFileOrNull, writeFileAtomic } from './atomic';
import { storageDirectory } from './certificate';

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
}
