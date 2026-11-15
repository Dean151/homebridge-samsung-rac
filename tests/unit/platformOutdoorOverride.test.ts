import { SamsungRacPlatform } from '../../src/platform';
import { CertificateStore } from '../../src/transport/certificate';
import { LocalApi } from '../../src/transport/localApi';
import fixture from '../fixtures/devices.json';
import { Characteristic, FakeAccessory, FakeHapStatusError, HAPStatus, Service } from '../mocks/hap.mock';

describe('per-device outdoor suppression', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.restoreAllMocks(); jest.clearAllTimers(); jest.useRealTimers(); });
  it.each(['linked', 'separate'])('hides one %s sensor while retaining its AC and sibling sensor', async placement => {
    jest.spyOn(CertificateStore.prototype, 'load').mockResolvedValue(Buffer.from('test'));
    jest.spyOn(LocalApi.prototype, 'get').mockImplementation(async function (this: LocalApi) {
      const document = structuredClone(fixture.Devices[0]);
      document.uuid = this.description.split(':')[0];
      document.Mode.options = ['OutdoorTemp_62'];
      return { Devices: [document] };
    });
    const events: Record<string, () => void> = {};
    const api = {
      hap: { Service, Characteristic, HapStatusError: FakeHapStatusError, HAPStatus, uuid: { generate: (value: string) => value } },
      user: { storagePath: () => '/unused' }, platformAccessory: FakeAccessory,
      on: (name: string, callback: () => void) => { events[name] = callback; },
      registerPlatformAccessories: jest.fn(), updatePlatformAccessories: jest.fn(), unregisterPlatformAccessories: jest.fn(),
    };
    const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    const platform = new SamsungRacPlatform(log as never, { platform: 'SamsungRacLocal', outdoorTemperature: placement,
      devices: [{ host: '192.0.2.1', token: 'test', hideOutdoorTemperature: true }, { host: '192.0.2.2', token: 'test' }],
    } as never, api as never);
    const hidden = new FakeAccessory('Hidden', 'samsung-rac:192.0.2.1');
    const visible = new FakeAccessory('Visible', 'samsung-rac:192.0.2.2');
    const oldSensor = new FakeAccessory('Old outdoor', hidden.UUID + ':outdoor');
    hidden.addService(Service.TemperatureSensor);
    for (const accessory of [hidden, visible, oldSensor]) { platform.configureAccessory(accessory as never); }
    events.didFinishLaunching();
    await jest.advanceTimersByTimeAsync(0);
    expect(log.error).not.toHaveBeenCalled();
    expect(hidden.getService(Service.HeaterCooler)).toBeDefined();
    expect(hidden.getService(Service.TemperatureSensor)).toBeUndefined();
    const removed = api.unregisterPlatformAccessories.mock.calls.flatMap(call => call[2]);
    expect(removed).toContain(oldSensor);
    expect(removed).not.toContain(hidden);
    expect(removed).not.toContain(visible);
    if (placement === 'linked') {
      expect(visible.getService(Service.TemperatureSensor)).toBeDefined();
    } else {
      expect(api.registerPlatformAccessories.mock.calls.flatMap(call => call[2])
        .some((a: FakeAccessory) => a.UUID === visible.UUID + ':outdoor')).toBe(true);
    }
    events.shutdown();
  });
});
