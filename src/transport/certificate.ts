import * as path from 'node:path';
import { readFileOrNull, writeFileAtomic } from './atomic';

/**
 * The community-known Samsung client certificate (C=KR, O=Samsung Electronics,
 * CN=AC14K_M). It bundles a PRIVATE KEY, so it is deliberately NOT vendored
 * into this repository — it is fetched once at setup time and stored on the
 * machine running Homebridge.
 */
export const DEFAULT_CERTIFICATE_URL =
  'https://raw.githubusercontent.com/SebuZet/samsungrac/master/custom_components/climate_ip/ac14k_m.pem';

export const CERTIFICATE_FILE_NAME = 'ac14k_m.pem';

export class CertificateError extends Error {}

/** The directory this plugin owns inside the Homebridge storage path. */
export function storageDirectory(homebridgeStoragePath: string): string {
  return path.join(homebridgeStoragePath, 'samsung-rac');
}

/**
 * A captive portal, a proxy error page or a renamed upstream file would all
 * download successfully and then fail much later as an unexplained TLS error.
 * Check that what arrived is actually the key + chain we need.
 */
function assertUsable(pem: string, source: string): void {
  if (!/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/.test(pem)) {
    throw new CertificateError(`The file fetched from ${source} contains no private key.`);
  }
  if (!/-----BEGIN CERTIFICATE-----/.test(pem)) {
    throw new CertificateError(`The file fetched from ${source} contains no certificate.`);
  }
}

export interface CertificateStoreOptions {
  storagePath: string;
  url?: string;
}

/**
 * Holds the client certificate on disk and in memory.
 *
 * `load()` is what the running plugin calls: it re-fetches when the file is
 * missing, so restoring a Homebridge config without the pem still recovers
 * unattended instead of failing every poll.
 */
export class CertificateStore {
  private cached: Buffer | null = null;
  private readonly url: string;
  private readonly filePath: string;

  constructor(options: CertificateStoreOptions) {
    this.url = options.url || DEFAULT_CERTIFICATE_URL;
    this.filePath = path.join(storageDirectory(options.storagePath), CERTIFICATE_FILE_NAME);
  }

  get path(): string {
    return this.filePath;
  }

  /** True when the certificate is already on disk; no network, no download. */
  async isStored(): Promise<boolean> {
    return (await readFileOrNull(this.filePath)) !== null;
  }

  async load(): Promise<Buffer> {
    if (this.cached) {
      return this.cached;
    }

    const stored = await readFileOrNull(this.filePath);
    if (stored) {
      assertUsable(stored.toString('utf8'), this.filePath);
      this.cached = stored;
      return stored;
    }

    return this.fetch();
  }

  /** Download unconditionally, replacing whatever is stored. */
  async fetch(): Promise<Buffer> {
    let response: Response;
    try {
      response = await fetch(this.url);
    } catch (error) {
      throw new CertificateError(
        `Could not download the client certificate from ${this.url}: ${(error as Error).message}`,
      );
    }

    if (!response.ok) {
      throw new CertificateError(
        `Could not download the client certificate from ${this.url}: HTTP ${response.status}.`,
      );
    }

    const pem = await response.text();
    assertUsable(pem, this.url);

    const buffer = Buffer.from(pem, 'utf8');
    await writeFileAtomic(this.filePath, buffer);
    this.cached = buffer;
    return buffer;
  }
}
