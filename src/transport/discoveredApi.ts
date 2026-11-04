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
  private retryAfter = 0;
  private lastHost: string;
  private readonly uuid: string;

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
    if (!devices.length || devices.some(device => !device || normaliseDeviceUuid(device.uuid) !== this.uuid)) {
      throw new DeviceIdentityError(`The AC at the discovered address does not match UUID ${this.uuid}.`);
    }
  }

  private async connect(): Promise<LocalApi> {
    const discovered = await this.discovery.resolve(this.uuid);
    if (this.closed) {
      throw new UnreachableError('Discovery stopped.');
    }
    const candidates = [...new Set([discovered, this.lastHost, this.options.host].filter((host): host is string => Boolean(host)))];
    let failure: unknown = new UnreachableError(`No address found for ${this.uuid}.`);
    // At most two attempts: the advertisement, then the last-known address.
    for (const host of candidates.slice(0, 2)) {
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
        failure = error;
        if (this.closed) {
          break;
        }
      }
    }
    this.retryAfter = this.now() + 30000;
    throw failure;
  }

  private async ready(): Promise<LocalApi> {
    if (this.closed) {
      throw new UnreachableError('Discovery stopped.');
    }
    if (this.current) {
      return this.current;
    }
    if (this.now() < this.retryAfter) {
      throw new UnreachableError(`Waiting to rediscover ${this.uuid}.`);
    }
    this.connecting ??= this.connect().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private failed(api: LocalApi, error: unknown): void {
    if (this.current === api && (error instanceof UnreachableError || error instanceof TokenInvalidError
      || error instanceof DeviceIdentityError)) {
      this.current = undefined;
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

  async getText(path: string): Promise<string> {
    const api = await this.ready();
    try {
      return await api.getText(path);
    } catch (error) {
      this.failed(api, error);
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
