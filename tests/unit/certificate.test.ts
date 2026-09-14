import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CertificateStore } from '../../src/transport/certificate';
import { TokenStore } from '../../src/transport/tokenStore';

const validPem = [
  '-----BEGIN PRIVATE KEY-----',
  'bm90LWEtcmVhbC1rZXk=',
  '-----END PRIVATE KEY-----',
  '-----BEGIN CERTIFICATE-----',
  'bm90LWEtcmVhbC1jZXJ0',
  '-----END CERTIFICATE-----',
].join('\n');

function stubFetch(body: string, ok = true, status = 200): jest.Mock {
  const mock = jest.fn(async () => ({ ok, status, text: async () => body }));
  global.fetch = mock as unknown as typeof fetch;
  return mock;
}

describe('CertificateStore', () => {
  let storagePath: string;

  beforeEach(async () => {
    storagePath = await fs.mkdtemp(path.join(os.tmpdir(), 'samsung-rac-test-'));
  });

  afterEach(async () => {
    await fs.rm(storagePath, { recursive: true, force: true });
  });

  it('downloads and stores the certificate, readable only by the owner', async () => {
    const store = new CertificateStore({ storagePath });
    stubFetch(validPem);

    const pem = await store.fetch();

    expect(pem.toString('utf8')).toBe(validPem);
    expect((await fs.stat(store.path)).mode & 0o777).toBe(0o600);
  });

  it('rejects a download that is not actually a certificate', async () => {
    // A captive portal or proxy error page downloads fine and then fails much
    // later as an unexplained TLS error.
    const store = new CertificateStore({ storagePath });
    stubFetch('<html>Sign in to the guest network</html>');

    await expect(store.fetch()).rejects.toThrow('no private key');
    expect(await store.isStored()).toBe(false);
  });

  it('rejects a key with no certificate chain behind it', async () => {
    const store = new CertificateStore({ storagePath });
    stubFetch('-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----');
    await expect(store.fetch()).rejects.toThrow('no certificate');
  });

  it('reports a failed download in terms of where it was looking', async () => {
    const store = new CertificateStore({ storagePath, url: 'https://example.invalid/ac.pem' });
    stubFetch('', false, 404);
    await expect(store.fetch()).rejects.toThrow('https://example.invalid/ac.pem');
  });

  it('re-downloads when the file has gone missing, so a restore recovers on its own', async () => {
    const store = new CertificateStore({ storagePath });
    const download = stubFetch(validPem);

    await store.load();
    expect(download).toHaveBeenCalledTimes(1);

    // A fresh store stands in for a plugin restart with no in-memory cache.
    await fs.rm(store.path);
    await expect(new CertificateStore({ storagePath }).load()).resolves.toBeDefined();
    expect(download).toHaveBeenCalledTimes(2);
  });

  it('does not go to the network when the certificate is already stored', async () => {
    stubFetch(validPem);
    await new CertificateStore({ storagePath }).fetch();

    const download = stubFetch('should not be called');
    await new CertificateStore({ storagePath }).load();
    expect(download).not.toHaveBeenCalled();
  });
});

describe('TokenStore', () => {
  let storagePath: string;

  beforeEach(async () => {
    storagePath = await fs.mkdtemp(path.join(os.tmpdir(), 'samsung-rac-test-'));
  });

  afterEach(async () => {
    await fs.rm(storagePath, { recursive: true, force: true });
  });

  it('keeps a token per unit, since the config holds several', async () => {
    const store = new TokenStore(storagePath);
    await store.set('10.0.0.1', { token: 'one' });
    await store.set('10.0.0.2', { token: 'two', model: 'TP6X_RAC_16K' });

    expect((await store.get('10.0.0.1'))?.token).toBe('one');
    expect((await store.get('10.0.0.2'))?.model).toBe('TP6X_RAC_16K');
  });

  it('stamps when a unit was paired', async () => {
    const store = new TokenStore(storagePath);
    await store.set('10.0.0.1', { token: 'one' });
    expect(Date.parse((await store.get('10.0.0.1'))!.pairedAt!)).not.toBeNaN();
  });

  it('writes the file readable only by the owner', async () => {
    const store = new TokenStore(storagePath);
    await store.set('10.0.0.1', { token: 'one' });
    expect((await fs.stat(store.path)).mode & 0o777).toBe(0o600);
  });

  it('treats a missing store as nothing paired', async () => {
    expect(await new TokenStore(storagePath).get('10.0.0.1')).toBeNull();
  });

  it('survives a corrupt store rather than taking the plugin down with it', async () => {
    const store = new TokenStore(storagePath);
    await store.set('10.0.0.1', { token: 'one' });
    await fs.writeFile(store.path, '{ this is not json');

    expect(await store.get('10.0.0.1')).toBeNull();
    await store.set('10.0.0.1', { token: 'two' });
    expect((await store.get('10.0.0.1'))?.token).toBe('two');
  });

  it('forgets one unit without touching the others', async () => {
    const store = new TokenStore(storagePath);
    await store.set('10.0.0.1', { token: 'one' });
    await store.set('10.0.0.2', { token: 'two' });

    await store.remove('10.0.0.1');

    expect(await store.get('10.0.0.1')).toBeNull();
    expect((await store.get('10.0.0.2'))?.token).toBe('two');
  });
});
