import { DEVICE_API_PORT } from '../settings';
import { HttpTransport, tlsTransport } from './httpOverTls';
import { describeTlsError } from './tls';

export class LocalApiError extends Error {
  constructor(message: string, readonly status?: number, readonly body?: string) {
    super(message);
  }
}

/** nginx on the unit refused the connection because no client cert was sent. */
export class CertificateRejectedError extends LocalApiError {}

/** The device token is missing, wrong, or was invalidated by a re-pairing. */
export class TokenInvalidError extends LocalApiError {}

/** The unit did not answer at all — powered off, moved by DHCP, or unplugged. */
export class UnreachableError extends LocalApiError {}

export interface LocalApiOptions {
  host: string;
  pem: Buffer;
  token?: string;
  port?: number;
  timeoutMs?: number;
  /** Swappable so the request/response handling can be tested without hardware. */
  transport?: HttpTransport;
}

export interface RawResponse {
  status: number;
  body: string;
}

export class LocalApi {
  private readonly host: string;
  private readonly port: number;
  private readonly timeoutMs: number;
  private readonly pem: Buffer;
  private readonly transport: HttpTransport;
  private token?: string;

  constructor(options: LocalApiOptions) {
    this.host = options.host;
    this.port = options.port ?? DEVICE_API_PORT;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.token = options.token;
    this.pem = options.pem;
    this.transport = options.transport ?? tlsTransport;
  }

  setToken(token: string | undefined): void {
    this.token = token;
  }

  get description(): string {
    return `${this.host}:${this.port}`;
  }

  /**
   * Nothing to release: the unit answers `Connection: close`, so every request
   * uses its own short-lived socket. Kept so callers have one lifecycle to
   * follow if that ever changes.
   */
  close(): void {
    // Intentionally empty.
  }

  async get<T>(path: string): Promise<T> {
    return JSON.parse(await this.send('GET', path)) as T;
  }

  async put(path: string, body: unknown): Promise<string> {
    return this.send('PUT', path, body);
  }

  async post(path: string, body: unknown): Promise<string> {
    return this.send('POST', path, body);
  }

  async send(method: string, path: string, body?: unknown): Promise<string> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const response = await this.raw(method, path, payload);

    if (response.status >= 200 && response.status < 300) {
      return response.body;
    }

    throw this.classify(response, method, path);
  }

  /**
   * The two documented failure bodies become typed errors so callers can react
   * to the cause rather than pattern-matching strings all over the codebase.
   */
  private classify(response: RawResponse, method: string, path: string): LocalApiError {
    const where = `${method} ${path} on ${this.description}`;

    if (response.status === 400 && /required SSL certificate/i.test(response.body)) {
      return new CertificateRejectedError(
        `${where}: the AC rejected our client certificate. Re-fetch it from the plugin settings.`,
        response.status,
        response.body,
      );
    }

    if (response.status === 401) {
      return new TokenInvalidError(
        `${where}: the device token is not valid. Pair again from the plugin settings.`,
        response.status,
        response.body,
      );
    }

    return new LocalApiError(`${where} failed with HTTP ${response.status}.`, response.status, response.body);
  }

  async raw(method: string, path: string, payload?: string): Promise<RawResponse> {
    const headers: Record<string, string> = {
      'X-API-Version': 'v1.0.0',
      'Accept': 'application/json',
      'User-Agent': 'homebridge-samsung-rac',
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }

    try {
      const response = await this.transport({
        host: this.host,
        port: this.port,
        method,
        path,
        headers,
        body: payload,
        timeoutMs: this.timeoutMs,
        pem: this.pem,
      });
      return { status: response.status, body: response.body };
    } catch (error) {
      const tlsMessage = describeTlsError(error, this.description);
      if (tlsMessage) {
        throw new LocalApiError(tlsMessage);
      }
      throw new UnreachableError(`${method} ${path} on ${this.description} failed: ${(error as Error).message}`);
    }
  }
}
