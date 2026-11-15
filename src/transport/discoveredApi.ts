import type { Logging } from 'homebridge';
import { AddressDiscovery, normaliseDeviceUuid } from '../discovery/ssdp';
import { devicesFrom, RacDevicesResponse } from '../racStatus';
import { DeviceApi, LocalApi, LocalApiOptions, TokenInvalidError, UnreachableError } from './localApi';

export class DeviceIdentityError extends Error {}

/** Keeps the adapter stable while its underlying address changes. */
export class DiscoveredApi implements DeviceApi {
  private current?: LocalApi;
  private connecting?: Promise<LocalApi>;
  private closed = false;
  private searchAfter = 0;
  private lastHost: string;
  private readonly uuid: string;
  private deviceId?: string;

  constructor(
    private readonly options: LocalApiOptions,
    uuid: string,
    private readonly discovery: AddressDiscovery,
    private readonly log?: Pick<Logging, 'info' | 'debug'>,
    private readonly now: () => number = Date.now,
  ) {
    const normalised = normaliseDeviceUuid(uuid);
    if (!normalised) {
      throw new Error('SSDP discovery requires a valid device UUID.');
    }
    this.uuid = normalised;
    this.lastHost = options.host;
  }

  get description(): string {
    return this.current?.description ?? `${this.uuid} (SSDP)`;
  }

  private verify(response: RacDevicesResponse): void {
    const devices = response && Array.isArray(response.Devices) ? devicesFrom(response) : [];
    const device = this.deviceId === undefined
      ? devices.find(candidate => candidate && normaliseDeviceUuid(candidate.uuid) === this.uuid)
      : devices.find(candidate => candidate && (candidate.id ?? '0') === this.deviceId);
    if (!device || normaliseDeviceUuid(device.uuid) !== this.uuid) {
      throw new DeviceIdentityError(`The AC at the discovered address does not match UUID ${this.uuid}.`);
    }
    // A host can expose siblings with different UUIDs. Bind the matching document,
    // then keep checking that same device ID rather than requiring every sibling to match.
    this.deviceId ??= device.id ?? '0';
  }

  private async connect(): Promise<LocalApi> {
    // Search alongside the known address, never in front of it. Some models do
    // not answer multicast at all; only searches back off, never direct retries.
    let search: Promise<string | undefined> = Promise.resolve(undefined);
    if (this.now() >= this.searchAfter) {
      this.searchAfter = this.now() + 30000;
      search = this.discovery.resolve(this.uuid).catch(() => {
        this.log?.debug(`SSDP search for ${this.uuid} failed; keeping the last-known address.`);
        return undefined;
      });
    }
    const connectAt = async (host: string): Promise<LocalApi> => {
      if (this.closed) {
        throw new UnreachableError('Discovery stopped.');
      }
      const api = new LocalApi({ ...this.options, host });
      try {
        this.verify(await api.get<RacDevicesResponse>('/devices'));
        if (this.closed) {
          throw new UnreachableError('Discovery stopped.');
        }
        this.current = api;
        this.lastHost = host;
        this.log?.info(`SSDP verified ${this.uuid} at ${host}.`);
        return api;
      } catch (error) {
        api.close();
        this.discovery.invalidate(this.uuid, host);
        throw error;
      }
    };
    try {
      return await connectAt(this.lastHost);
    } catch (error) {
      const discovered = await search;
      if (this.closed) {
        throw new UnreachableError('Discovery stopped.');
      }
      // At most two attempts: the last-known address and a different advertisement.
      if (discovered && discovered !== this.lastHost) {
        return connectAt(discovered);
      }
      throw error;
    }
  }

  private async ready(): Promise<LocalApi> {
    if (this.closed) {
      throw new UnreachableError('Discovery stopped.');
    }
    if (this.current) {
      return this.current;
    }
    this.connecting ??= this.connect().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private failed(api: LocalApi, error: unknown): void {
    if (this.current === api && (error instanceof UnreachableError || error instanceof TokenInvalidError
      || error instanceof DeviceIdentityError)) {
      this.current = undefined;
      this.searchAfter = 0;
      api.close();
      this.discovery.invalidate(this.uuid, api.host);
      this.log?.debug(`Connection to ${this.uuid} lost; the next request will rediscover it.`);
    }
  }

  async get<T = unknown>(path: string): Promise<T> {
    const api = await this.ready();
    try {
      const response = await api.get<T>(path);
      if (path === '/devices') {
        this.verify(response as RacDevicesResponse);
      }
      return response;
    } catch (error) {
      this.failed(api, error);
      throw error;
    }
  }

  async put(path: string, body: unknown): Promise<string> {
    const api = await this.ready();
    try {
      return await api.put(path, body);
    } catch (error) {
      this.failed(api, error);
      // Never resend a write: the AC may have applied it before the connection failed.
      throw error;
    }
  }

  async post(path: string, body: unknown): Promise<string> {
    const api = await this.ready();
    try {
      return await api.post(path, body);
    } catch (error) {
      this.failed(api, error);
      throw error;
    }
  }

  close(): void {
    this.closed = true;
    this.current?.close();
  }
}
