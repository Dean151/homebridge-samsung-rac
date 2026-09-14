import { constants } from 'node:crypto';
import type { SecureContextOptions } from 'node:tls';

/**
 * TLS settings for talking to the AC, used identically by the API client, the
 * pairing listener and the probe CLI.
 *
 * Three of these four options are load-bearing and were each established the
 * hard way against real hardware:
 *
 * - `cert` and `key` get the *same* buffer. ac14k_m.pem bundles a private key
 *   plus a four-certificate chain, exactly like `curl --cert x --key x`.
 * - `rejectUnauthorized: false` because the AC presents a self-signed server
 *   certificate. We still send our own client certificate; nginx on the unit
 *   rejects the connection outright without it.
 * - The unit runs nginx 1.2.7 with an ancient TLS stack. OpenSSL 3 refuses it
 *   at the default security level, so drop to SECLEVEL 0 and allow TLS 1.0.
 */
export function tlsOptions(pem: Buffer): SecureContextOptions & { rejectUnauthorized: boolean } {
  return {
    cert: pem,
    key: pem,
    rejectUnauthorized: false,
    minVersion: 'TLSv1',
    ciphers: 'ALL:@SECLEVEL=0',
    secureOptions: constants.SSL_OP_LEGACY_SERVER_CONNECT,
  };
}

/**
 * A TLS handshake failure is the most likely first-run problem, and Node's own
 * message ("write EPROTO ... unsupported protocol") names nothing the user can
 * act on. Turn it into one line that does.
 */
export function describeTlsError(error: unknown, host: string): string | null {
  const code = (error as NodeJS.ErrnoException | undefined)?.code ?? '';
  const message = error instanceof Error ? error.message : String(error);

  if (!code.startsWith('ERR_SSL') && code !== 'EPROTO' && !/ssl|tls|handshake/i.test(message)) {
    return null;
  }

  return `TLS handshake with ${host} failed (${code || 'no code'}: ${message}). The unit runs a very old TLS `
    + 'stack; this plugin already asks for TLS 1.0 and OpenSSL security level 0. If your Node build has '
    + 'legacy TLS compiled out entirely, the local API cannot be reached from it.';
}
