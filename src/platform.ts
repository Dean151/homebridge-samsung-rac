import type {
  API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service,
} from 'homebridge';
import { normaliseConfig, NormalisedConfig } from './config';
import { DeviceAdapter } from './deviceAdapter';
import { SamsungRacAccessory } from './platformAccessory';
import { devicesFrom, RacDeviceDocument, RacDevicesResponse } from './racStatus';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { CertificateStore } from './transport/certificate';
import { LocalApi, TokenInvalidError } from './transport/localApi';
import { TokenStore } from './transport/tokenStore';

interface AccessoryContext {
  host: string;
  deviceId: string;
  model?: string;
  uuid?: string;
}

export class SamsungRacPlatform implements DynamicPlatformPlugin {
  readonly Service: typeof Service;
  readonly Characteristic: typeof Characteristic;
  readonly settings: NormalisedConfig;

  private readonly cachedAccessories: PlatformAccessory[] = [];
  private readonly handlers: SamsungRacAccessory[] = [];
  private readonly certificates: CertificateStore;
  private readonly tokens: TokenStore;

  constructor(
    readonly log: Logging,
    config: PlatformConfig,
    readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.settings = normaliseConfig(config, log);

    const storagePath = api.user.storagePath();
    this.certificates = new CertificateStore({ storagePath, url: this.settings.certificateUrl });
    this.tokens = new TokenStore(storagePath);

    this.api.on('didFinishLaunching', () => {
      void this.discoverDevices();
    });

    this.api.on('shutdown', () => {
      for (const handler of this.handlers) {
        handler.stop();
      }
    });
  }

  /** Homebridge hands back every accessory it has cached for this platform. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.log.debug('Loading accessory from cache:', accessory.displayName);
    this.cachedAccessories.push(accessory);
  }

  private async discoverDevices(): Promise<void> {
    if (!this.settings.devices.length) {
      return;
    }

    let pem: Buffer;
    try {
      pem = await this.certificates.load();
    } catch (error) {
      this.log.error(
        `Cannot load the Samsung client certificate: ${messageOf(error)} `
        + 'Open the plugin settings and fetch it, or check this machine can reach GitHub.',
      );
      return;
    }

    const liveUuids = new Set<string>();
    let allReachable = true;

    for (const device of this.settings.devices) {
      const token = device.token ?? (await this.tokens.get(device.host))?.token;

      if (!token) {
        // Not an error: a fresh install has hosts configured and nothing paired
        // yet, and the plugin should still boot cleanly.
        this.log.info(
          `${device.host} has no device token yet. Open the plugin settings and pair it there.`,
        );
        allReachable = false;
        continue;
      }

      const api = new LocalApi({
        host: device.host,
        pem,
        token,
        timeoutMs: this.settings.requestTimeoutMs,
      });

      let documents: RacDeviceDocument[];
      try {
        documents = devicesFrom(await api.get<RacDevicesResponse>('/devices'));
      } catch (error) {
        allReachable = false;
        api.close();
        if (error instanceof TokenInvalidError) {
          this.log.error(`${device.host}: ${messageOf(error)}`);
        } else {
          this.log.error(`Cannot reach the air conditioner at ${device.host}: ${messageOf(error)}`);
        }
        continue;
      }

      if (!documents.length) {
        allReachable = false;
        api.close();
        this.log.warn(`${device.host} answered but reported no devices.`);
        continue;
      }

      for (const document of documents) {
        const uuid = await this.registerDevice(device.host, document, api, documents.length > 1);
        liveUuids.add(uuid);
      }
    }

    // Only prune when every configured unit answered. Otherwise one air
    // conditioner being unplugged at restart would delete its HomeKit tile,
    // taking the user's automations and room assignment with it.
    if (allReachable) {
      this.removeStaleAccessories(liveUuids);
    } else if (this.cachedAccessories.some((accessory) => !liveUuids.has(accessory.UUID))) {
      this.log.info('Keeping cached accessories for units that did not answer; nothing was removed.');
    }
  }

  private async registerDevice(
    host: string,
    document: RacDeviceDocument,
    api: LocalApi,
    multiple: boolean,
  ): Promise<string> {
    const deviceId = document.id ?? '0';
    // Key on the unit's own uuid rather than its address, so a DHCP move does
    // not orphan the accessory and its automations.
    const seed = document.uuid ? `samsung-rac:${document.uuid}` : `samsung-rac:${host}:${deviceId}`;
    const uuid = this.api.hap.uuid.generate(seed);

    const configured = this.settings.devices.find((device) => device.host === host)?.name;
    const displayName = configured
      ? (multiple ? `${configured} ${deviceId}` : configured)
      : document.name ?? document.description ?? `Samsung AC ${host}`;

    const context: AccessoryContext = { host, deviceId, model: document.description, uuid: document.uuid };

    const existing = this.cachedAccessories.find((accessory) => accessory.UUID === uuid);
    const accessory = existing ?? new this.api.platformAccessory(displayName, uuid);
    accessory.context = { ...accessory.context, ...context };

    const adapter = new DeviceAdapter(api, deviceId, this.log);

    // Populate before HomeKit ever sees the accessory, so its first look
    // already has real values rather than placeholders.
    this.handlers.push(await SamsungRacAccessory.create(this, accessory, adapter));

    if (existing) {
      this.log.info('Restoring accessory from cache:', displayName);
      this.api.updatePlatformAccessories([accessory]);
    } else {
      this.log.info('Adding new accessory:', displayName);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.cachedAccessories.push(accessory);
    }

    return uuid;
  }

  /**
   * Drop cached accessories for units that are no longer configured. Without
   * this they linger in the Home app forever as unresponsive tiles.
   */
  private removeStaleAccessories(liveUuids: Set<string>): void {
    const stale = this.cachedAccessories.filter((accessory) => !liveUuids.has(accessory.UUID));
    if (!stale.length) {
      return;
    }

    for (const accessory of stale) {
      this.log.info('Removing accessory that is no longer configured:', accessory.displayName);
      const index = this.cachedAccessories.indexOf(accessory);
      if (index >= 0) {
        this.cachedAccessories.splice(index, 1);
      }
    }

    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
