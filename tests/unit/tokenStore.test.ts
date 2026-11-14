import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TokenStore } from '../../src/transport/tokenStore';

const uuid = 'C097276C-06FB-0000-0000-000000000000';
let directory: string;
let store: TokenStore;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'rac-tokens-')); store = new TokenStore(directory); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

it('finds an existing token by UUID at a different address without rewriting it', async () => {
  await store.set('192.168.1.227', { token: 'old-pairing', deviceUuid: uuid });
  const before = await readFile(store.path, 'utf8');
  expect((await store.getForDevice('192.168.1.228', uuid.toLowerCase()))?.token).toBe('old-pairing');
  expect(await readFile(store.path, 'utf8')).toBe(before);
});

it('uses the newest pairing when older addresses have stale tokens', async () => {
  await store.set('192.168.1.227', { token: 'stale', deviceUuid: uuid, pairedAt: '2026-01-01T00:00:00Z' });
  await store.set('192.168.1.228', { token: 'current', deviceUuid: uuid, pairedAt: '2026-02-01T00:00:00Z' });
  expect((await store.getForDevice('192.168.1.227', uuid))?.token).toBe('current');
});

it('does not use a different AC token just because its IP matches', async () => {
  await store.set('192.168.1.227', { token: 'wrong-unit', deviceUuid: 'C097276C-0C0F-0000-0000-000000000000' });
  expect(await store.getForDevice('192.168.1.227', uuid)).toBeNull();
});

it('preserves legacy address-only pairings', async () => {
  await store.set('192.168.1.227', { token: 'legacy' });
  expect((await store.getForDevice('192.168.1.227'))?.token).toBe('legacy');
  expect((await store.getForDevice('192.168.1.227', uuid))?.token).toBe('legacy');
});

it('forgets all old addresses for the selected AC and keeps other pairings', async () => {
  await store.set('192.168.1.227', { token: 'old', deviceUuid: uuid });
  await store.set('192.168.1.228', { token: 'new', deviceUuid: uuid });
  await store.set('192.168.1.170', { token: 'other', deviceUuid: 'C097276C-0C0F-0000-0000-000000000000' });
  await store.removeForDevice('192.168.1.229', uuid);
  expect(Object.keys(await store.all())).toEqual(['192.168.1.170']);
});
