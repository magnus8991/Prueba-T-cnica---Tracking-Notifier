import { lookup as dnsLookup, LookupAddress, LookupOptions } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { ApplicationError } from '../../application/errors';
import { WebhookDestinationPolicy } from '../../application/ports/webhook-sender';

/**
 * Rangos no enrutables públicamente (OWASP SSRF Prevention Cheat Sheet + RFC 6890).
 * Incluye loopback, privadas RFC1918, link-local (metadata cloud 169.254.169.254),
 * CGNAT, ULA/link-local IPv6, multicast, NAT64 y reservadas.
 */
const BLOCKED = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  BLOCKED.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 96], // no especificada, loopback e IPv4-compatible (::a.b.c.d, deprecada)
  ['::ffff:0:0:0', 96], // IPv4-translated (RFC 2765)
  ['2002::', 16], // 6to4: embebe una IPv4 arbitraria
  ['2001::', 32], // Teredo
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  BLOCKED.addSubnet(network, prefix, 'ipv6');
}

const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata.google.internal', 'metadata']);

/** Normaliza IPv4-mapped IPv6 (::ffff:a.b.c.d) a IPv4 antes de comparar (evita bypass). */
function normalize(address: string): { address: string; family: 'ipv4' | 'ipv6' } {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped) return { address: mapped[1]!, family: 'ipv4' };
  return { address, family: isIP(address) === 6 ? 'ipv6' : 'ipv4' };
}

export function isBlockedAddress(address: string): boolean {
  if (isIP(address) === 0) return true; // lo que no es una IP válida no se conecta
  const n = normalize(address);
  return BLOCKED.check(n.address, n.family);
}

export class BlockedDestinationError extends Error {
  readonly code = 'DESTINO_NO_PERMITIDO';
  constructor() {
    super('El destino del webhook resuelve a una dirección no permitida');
  }
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * Función `lookup` para http.request: resuelve el DNS y valida TODAS las IPs en el
 * mismo momento de conectar, de modo que la IP validada es la IP usada (anti DNS rebinding).
 */
export function createGuardedLookup(allowPrivateNetworks: boolean) {
  return (hostname: string, options: LookupOptions, callback: LookupCallback): void => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, []);
      const list = addresses as LookupAddress[];
      if (!allowPrivateNetworks && (list.length === 0 || list.some((a) => isBlockedAddress(a.address)))) {
        return callback(new BlockedDestinationError() as NodeJS.ErrnoException, []);
      }
      if (options.all) return callback(null, list);
      const first = list[0]!;
      return callback(null, first.address, first.family);
    });
  };
}

export interface NetworkPolicySettings {
  allowPrivateNetworks: boolean;
  requireHttps: boolean;
}

/** Validación temprana al configurar el webhook (el chequeo definitivo ocurre al conectar). */
export class NetworkWebhookDestinationPolicy implements WebhookDestinationPolicy {
  constructor(private readonly settings: NetworkPolicySettings) {}

  async assertAllowed(url: URL): Promise<void> {
    if (this.settings.requireHttps && url.protocol !== 'https:') {
      throw new ApplicationError('URL_WEBHOOK_NO_PERMITIDA', 'La URL del webhook debe usar https');
    }
    if (this.settings.allowPrivateNetworks) return;

    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.localhost') || host.endsWith('.internal')) {
      throw new ApplicationError('URL_WEBHOOK_NO_PERMITIDA', 'El host del webhook no está permitido');
    }
    if (isIP(host) !== 0) {
      if (isBlockedAddress(host)) throw new ApplicationError('URL_WEBHOOK_NO_PERMITIDA', 'La IP del webhook no está permitida');
      return;
    }
    const addresses = await new Promise<LookupAddress[]>((resolve) => dnsLookup(host, { all: true }, (err, list) => resolve(err ? [] : list)));
    if (addresses.length === 0) {
      throw new ApplicationError('URL_WEBHOOK_NO_PERMITIDA', 'El host del webhook no se puede resolver');
    }
    if (addresses.some((a) => isBlockedAddress(a.address))) {
      throw new ApplicationError('URL_WEBHOOK_NO_PERMITIDA', 'El host del webhook resuelve a una red no permitida');
    }
  }
}
