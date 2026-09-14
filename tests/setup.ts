import nock from 'nock';

/**
 * Nothing in the unit suite may reach the network. Without this, a mistake in a
 * transport test would quietly hit a real air conditioner — or GitHub, for the
 * certificate download.
 */
beforeAll(() => {
  nock.disableNetConnect();
  nock.enableNetConnect('127.0.0.1');
});

/**
 * nock does not intercept global fetch in this version, and the certificate
 * download uses it. Replace it outright so a test can only reach the network by
 * deliberately stubbing it.
 */
const blockedFetch = (() => {
  throw new Error('Network access is disabled in unit tests. Stub global.fetch in the test that needs it.');
}) as unknown as typeof fetch;

const realFetch = global.fetch;

beforeEach(() => {
  global.fetch = blockedFetch;
});

afterEach(() => {
  global.fetch = realFetch;
  nock.cleanAll();
});

afterAll(() => {
  nock.enableNetConnect();
});
