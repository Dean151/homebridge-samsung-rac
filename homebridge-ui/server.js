const path = require('path');
const os = require('os');
const { HomebridgePluginUiServer, RequestError } = require('@homebridge/plugin-ui-utils');

/**
 * The custom UI server.
 *
 * It deliberately contains no transport logic of its own: it requires the
 * plugin's own compiled modules, so the certificate handling, the pairing
 * ritual and the token file format cannot drift between the setup wizard and
 * the running plugin.
 */
function plugin(name) {
  try {
    return require(path.join(__dirname, '..', 'dist', name));
  } catch (error) {
    throw new RequestError(
      `The plugin is not built yet (${error.message}). Run "npm run build" in the plugin directory.`,
      { status: 500 },
    );
  }
}

class SamsungRacUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();

    this.storagePath = this.homebridgeStoragePath || path.join(os.homedir(), '.homebridge');
    this.pairing = null;

    this.onRequest('/status', this.status.bind(this));
    this.onRequest('/certificate/fetch', this.fetchCertificate.bind(this));
    this.onRequest('/device/test', this.testDevice.bind(this));
    this.onRequest('/pair/start', this.pairStart.bind(this));
    this.onRequest('/pair/cancel', this.pairCancel.bind(this));
    this.onRequest('/token/set', this.tokenSet.bind(this));
    this.onRequest('/token/forget', this.tokenForget.bind(this));

    this.ready();
  }

  certificates(url) {
    const { CertificateStore } = plugin('transport/certificate');
    return new CertificateStore({ storagePath: this.storagePath, url: url || undefined });
  }

  tokens() {
    const { TokenStore } = plugin('transport/tokenStore');
    return new TokenStore(this.storagePath);
  }

  /**
   * One rich state object rather than a boolean, so the card can render every
   * state it has without a second round trip.
   */
  async status({ hosts, certificateUrl } = {}) {
    const store = this.certificates(certificateUrl);
    const tokens = await this.tokens().all();

    return {
      certificate: {
        stored: await store.isStored(),
        path: store.path,
      },
      storagePath: this.storagePath,
      pairing: this.pairing ? this.pairing.host : null,
      devices: (hosts || []).map((host) => {
        const record = tokens[host];
        return {
          host,
          paired: Boolean(record && record.token),
          model: record ? record.model : undefined,
          name: record ? record.name : undefined,
          pairedAt: record ? record.pairedAt : undefined,
        };
      }),
    };
  }

  async fetchCertificate({ certificateUrl } = {}) {
    const store = this.certificates(certificateUrl);
    try {
      await store.fetch();
    } catch (error) {
      throw new RequestError(error.message, { status: 502 });
    }
    return { stored: true, path: store.path };
  }

  async testDevice({ host, certificateUrl } = {}) {
    if (!host) {
      throw new RequestError('Enter the air conditioner\'s IP address first.', { status: 400 });
    }

    const { LocalApi } = plugin('transport/localApi');
    const { devicesFrom } = plugin('racStatus');

    const pem = await this.loadCertificate(certificateUrl);
    const record = await this.tokens().get(host);
    const api = new LocalApi({ host, pem, token: record ? record.token : undefined, timeoutMs: 8000 });

    try {
      const device = devicesFrom(await api.get('/devices'))[0];
      if (!device) {
        throw new RequestError(`${host} answered but reported no devices.`, { status: 502 });
      }
      return {
        model: device.description,
        name: device.name,
        uuid: device.uuid,
        power: device.Operation ? device.Operation.power : undefined,
      };
    } catch (error) {
      if (error instanceof RequestError) {
        throw error;
      }
      throw new RequestError(error.message, { status: 502 });
    } finally {
      api.close();
    }
  }

  async pairStart({ host, certificateUrl } = {}) {
    if (!host) {
      throw new RequestError('Enter the air conditioner\'s IP address first.', { status: 400 });
    }
    if (this.pairing) {
      throw new RequestError(
        `Pairing with ${this.pairing.host} is already running. Only one unit can pair at a time — `
        + 'they all call back on the same port.',
        { status: 409 },
      );
    }

    const { pairDevice } = plugin('transport/pairing');
    const pem = await this.loadCertificate(certificateUrl);
    const controller = new AbortController();
    this.pairing = { host, controller };

    try {
      const result = await pairDevice({
        host,
        pem,
        signal: controller.signal,
        onProgress: (progress) => this.pushEvent('pair-progress', { host, ...progress }),
      });

      await this.tokens().set(host, {
        token: result.token,
        deviceUuid: result.deviceUuid,
        model: result.model,
        name: result.name,
      });

      return { paired: true, model: result.model, name: result.name };
    } catch (error) {
      throw new RequestError(error.message, { status: 502 });
    } finally {
      this.pairing = null;
    }
  }

  async pairCancel() {
    if (this.pairing) {
      this.pairing.controller.abort();
    }
    return { cancelled: true };
  }

  async tokenSet({ host, token } = {}) {
    if (!host || !token) {
      throw new RequestError('Both an IP address and a token are needed.', { status: 400 });
    }
    await this.tokens().set(host, { token: token.trim() });
    return { paired: true };
  }

  async tokenForget({ host } = {}) {
    if (!host) {
      throw new RequestError('No air conditioner given.', { status: 400 });
    }
    await this.tokens().remove(host);
    return { paired: false };
  }

  async loadCertificate(url) {
    try {
      return await this.certificates(url).load();
    } catch (error) {
      throw new RequestError(
        `Could not load the Samsung client certificate: ${error.message}`,
        { status: 502 },
      );
    }
  }
}

(() => new SamsungRacUiServer())();
