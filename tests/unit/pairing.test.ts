import { extractToken } from '../../src/transport/pairing';

describe('extractToken', () => {
  const body = (payload: string) =>
    `POST / HTTP/1.1\r\nHost: 10.0.0.9\r\nContent-Length: ${payload.length}\r\n\r\n${payload}`;

  it('reads the token the reference unit sends', () => {
    expect(extractToken(body('{"DeviceToken":"abc123"}'))).toBe('abc123');
  });

  it('accepts any key ending in token, so a firmware variant is not dropped', () => {
    // The user has already power cycled their air conditioner by this point;
    // being strict about spelling would waste that.
    expect(extractToken(body('{"devicetoken":"abc123"}'))).toBe('abc123');
    expect(extractToken(body('{"accessToken":"abc123"}'))).toBe('abc123');
  });

  it('falls back to a loose match when the body is not valid JSON', () => {
    expect(extractToken('DeviceToken = "abc123" trailing junk')).toBe('abc123');
  });

  it('returns null when there is no token to be found', () => {
    expect(extractToken(body('{"status":"ok"}'))).toBeNull();
    expect(extractToken('')).toBeNull();
  });

  it('ignores an empty token value', () => {
    expect(extractToken(body('{"DeviceToken":""}'))).toBeNull();
  });
});
