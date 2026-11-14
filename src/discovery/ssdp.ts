import * as dgram from 'node:dgram';
import { isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';

export function normaliseDeviceUuid(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const uuid = value.trim().replace(/^uuid:/i, '').toLowerCase();
  return /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(uuid) ? uuid : undefined;
}

export interface DiscoveryTarget {
  uuid: string;
  /** An optional last-known address, used only as a unicast search hint. */
  host?: string;
}

export interface LanInterface {
  address: string;
  netmask: string;
}

function ipv4Number(value: string): number {
  return value.split('.').reduce((number, octet) => ((number << 8) | Number(octet)) >>> 0, 0);
}

export function isLanAddress(address: string): boolean {
  if (!isIPv4(address)) {
    return false;
  }
  const [a, b] = address.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 169 && b === 254);
}

function onSubnet(address: string, network: LanInterface): boolean {
  const mask = ipv4Number(network.netmask);
  return isLanAddress(address) && (ipv4Number(address) & mask) === (ipv4Number(network.address) & mask);
}

/** SSDP is a hint, not proof of identity; the authenticated API is checked separately. */
export function parseSsdpResponse(packet: Buffer, sourceAddress: string): DiscoveryTarget | undefined {
  if (packet.length > 8192 || !isLanAddress(sourceAddress)) {
    return undefined;
  }
  const lines = packet.toString('utf8').split(/\r?\n/);
  if (!/^HTTP\/1\.[01] 200(?:\s|$)/i.test(lines.shift() ?? '')) {
    return undefined;
  }
  const headers = new Map<string, string>();
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon < 1) {
      continue;
    }
    const key = line.slice(0, colon).trim().toLowerCase();
    if (headers.has(key) && (key === 'usn' || key === 'location')) {
      return undefined;
    }
    headers.set(key, line.slice(colon + 1).trim());
  }
  const usn = headers.get('usn') ?? '';
  const uuid = normaliseDeviceUuid(usn.split('::')[0]);
  if (!uuid || !/::urn:SmartHomeAlliance-org:device:Air_Conditioner:/i.test(usn)) {
    return undefined;
  }
  try {
    const location = new URL(headers.get('location') ?? '');
    // Never follow an advertisement to a different host, port, path or DNS name.
    if (location.protocol !== 'https:' || location.hostname !== sourceAddress || location.port !== '8888'
      || location.pathname !== '/capability' || location.username || location.password || location.search || location.hash) {
      return undefined;
    }
    return { uuid, host: sourceAddress };
  } catch {
    return undefined;
  }
}

export interface ScanOptions {
  targets: DiscoveryTarget[];
  signal?: AbortSignal;
  timeoutMs?: number;
  interfaces?: LanInterface[];
}

/** Bounded, shared M-SEARCH scan. No subnet sweep and no credentials in UDP packets. */
export function scanSsdp(options: ScanOptions): Promise<Map<string, string>> {
  const interfaces = options.interfaces ?? Object.values(networkInterfaces()).flatMap(entries =>
    (entries ?? []).filter(entry => entry.family === 'IPv4' && !entry.internal && isLanAddress(entry.address)));
  const wanted = new Set(options.targets.map(target => normaliseDeviceUuid(target.uuid)).filter(Boolean));
  return new Promise(resolve => {
    const found = new Map<string, string>();
    const conflicts = new Set<string>();
    const sockets: dgram.Socket[] = [];
    const timers: ReturnType<typeof setTimeout>[] = [];
    let finished = false;
    const close = (socket: dgram.Socket) => {
      try {
        socket.close();
      } catch {
        // An interface may have disappeared before bind completed.
      }
    };
    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      for (const timer of timers) {
        clearTimeout(timer);
      }
      options.signal?.removeEventListener('abort', finish);
      for (const socket of sockets) {
        close(socket);
      }
      resolve(found);
    };
    if (options.signal?.aborted || !interfaces.length || !wanted.size) {
      finish();
      return;
    }
    options.signal?.addEventListener('abort', finish, { once: true });
    timers.push(setTimeout(finish, options.timeoutMs ?? 3500));
    for (const network of interfaces) {
      const socket = dgram.createSocket('udp4');
      sockets.push(socket);
      socket.on('error', () => close(socket));
      socket.on('message', (packet, remote) => {
        if (finished || !onSubnet(remote.address, network)) {
          return;
        }
        const target = parseSsdpResponse(packet, remote.address);
        if (!target?.host || !wanted.has(target.uuid) || conflicts.has(target.uuid)) {
          return;
        }
        if (found.has(target.uuid) && found.get(target.uuid) !== target.host) {
          found.delete(target.uuid);
          conflicts.add(target.uuid);
        } else {
          found.set(target.uuid, target.host);
        }
      });
      socket.bind(0, network.address, () => {
        if (finished) {
          close(socket);
          return;
        }
        try {
          socket.setMulticastInterface(network.address);
          socket.setMulticastTTL(2);
        } catch {
          close(socket);
          return;
        }
        const destinations = new Set(['239.255.255.250', ...options.targets
          .map(target => target.host).filter((host): host is string => Boolean(host && onSubnet(host, network)))]);
        const search = () => {
          if (finished) {
            return;
          }
          for (const destination of destinations) {
            for (const type of ['ssdp:all', 'urn:SmartHomeAlliance-org:device:Air_Conditioner:1.0']) {
              const packet = Buffer.from('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\n'
                + `MAN: "ssdp:discover"\r\nMX: 1\r\nST: ${type}\r\n\r\n`);
              try {
                socket.send(packet, 1900, destination, () => undefined);
              } catch {
                // A failed interface must not prevent discovery on another one.
              }
            }
          }
        };
        search();
        timers.push(setTimeout(search, 1000), setTimeout(search, 2000));
      });
    }
  });
}

export interface AddressDiscovery {
  resolve(uuid: string): Promise<string | undefined>;
  invalidate(uuid: string, host: string): void;
}

/** One scanner per platform, shared by simultaneous reconnects and startup. */
export class SsdpDiscovery implements AddressDiscovery {
  private addresses = new Map<string, string>();
  private scannedAt = -Infinity;
  private pending?: Promise<void>;
  private readonly controller = new AbortController();

  constructor(
    private readonly targets: DiscoveryTarget[],
    private readonly scanner: typeof scanSsdp = scanSsdp,
    private readonly now: () => number = Date.now,
  ) {}

  async resolve(uuid: string): Promise<string | undefined> {
    if (this.controller.signal.aborted) {
      return undefined;
    }
    if (this.now() - this.scannedAt >= 30000) {
      this.pending ??= this.scanner({ targets: this.targets, signal: this.controller.signal }).then(result => {
        this.addresses = result;
        this.scannedAt = this.now();
      }).finally(() => { this.pending = undefined; });
      await this.pending;
    }
    return this.addresses.get(normaliseDeviceUuid(uuid) ?? '');
  }

  invalidate(uuid: string, host: string): void {
    const key = normaliseDeviceUuid(uuid) ?? '';
    if (this.addresses.get(key) === host) {
      this.addresses.delete(key);
    }
    this.scannedAt = -Infinity;
  }

  close(): void {
    this.controller.abort();
  }
}
