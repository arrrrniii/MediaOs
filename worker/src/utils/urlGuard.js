/**
 * SSRF guard for outbound user-supplied URLs (webhooks).
 *
 * Two layers:
 *   1. validateWebhookUrl() — syntactic checks at registration time.
 *   2. resolveAndValidate() + createPinnedDispatcher() — DNS checked at send
 *      time, then the connection is pinned to the exact addresses that were
 *      checked so a rebind between check and connect cannot redirect us.
 */

const net = require('net');
const dns = require('dns').promises;

const ALLOWED_PROTOCOLS = ['http:', 'https:'];
const ALLOWED_PORTS = ['80', '443', '8080', '8443'];
const BLOCKED_SUFFIXES = ['.local', '.internal', '.localhost'];

function guardError(code, message) {
  const err = new Error(message);
  err.status = 400;
  err.code = code;
  return err;
}

// ── IPv4 ─────────────────────────────────────────────────

// [network, prefix length] — 0/8, 10/8, 100.64/10, 127/8, 169.254/16,
// 172.16/12, 192.0.0/24, 192.168/16, 198.18/15, 224/4, 240/4 (incl. broadcast)
const V4_RESERVED = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function v4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function isPublicIpv4(ip) {
  const value = v4ToInt(ip);
  if (value === null) return false;
  for (const [network, bits] of V4_RESERVED) {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((value & mask) >>> 0 === ((v4ToInt(network) & mask) >>> 0)) return false;
  }
  return true;
}

// ── IPv6 ─────────────────────────────────────────────────

/** Expand any IPv6 text form (incl. "::" and trailing dotted-quad) to 16 bytes. */
function ipv6ToBytes(input) {
  let ip = String(input);
  const zone = ip.indexOf('%');
  if (zone !== -1) ip = ip.slice(0, zone);

  const lastColon = ip.lastIndexOf(':');
  if (lastColon === -1) return null;

  const tail = ip.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (!net.isIPv4(tail)) return null;
    const o = tail.split('.').map(Number);
    ip = ip.slice(0, lastColon + 1)
      + ((o[0] << 8) | o[1]).toString(16) + ':'
      + ((o[2] << 8) | o[3]).toString(16);
  }

  const halves = ip.split('::');
  if (halves.length > 2) return null;

  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 0) return null;

  const groups = [
    ...head,
    ...new Array(halves.length === 2 ? missing : 0).fill('0'),
    ...rest,
  ];

  const bytes = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    const value = parseInt(group, 16);
    bytes.push(value >> 8, value & 0xff);
  }
  return bytes;
}

function isPublicIpv6(ip) {
  const b = ipv6ToBytes(ip);
  if (!b) return false;

  if (b.every((byte) => byte === 0)) return false;                       // ::
  if (b.slice(0, 15).every((byte) => byte === 0) && b[15] === 1) return false; // ::1
  if ((b[0] & 0xfe) === 0xfc) return false;                              // fc00::/7
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return false;             // fe80::/10
  if (b[0] === 0xff) return false;                                       // ff00::/8

  // 64:ff9b::/96 — NAT64 well-known prefix
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b
    && b.slice(4, 12).every((byte) => byte === 0)) return false;

  const first10Zero = b.slice(0, 10).every((byte) => byte === 0);
  if (first10Zero && b[10] === 0xff && b[11] === 0xff) {
    // ::ffff:0:0/96 — IPv4-mapped; judge by the embedded v4 address
    return isPublicIpv4(b.slice(12).join('.'));
  }
  // ::a.b.c.d — deprecated IPv4-compatible form
  if (first10Zero && b[10] === 0x00 && b[11] === 0x00) return false;

  return true;
}

/** True only for addresses that are globally routable and safe to connect to. */
function isPublicIp(ip) {
  if (typeof ip !== 'string') return false;
  const bare = ip.startsWith('[') && ip.endsWith(']') ? ip.slice(1, -1) : ip;
  if (net.isIPv4(bare)) return isPublicIpv4(bare);
  if (net.isIPv6(bare)) return isPublicIpv6(bare);
  return false;
}

// ── Hostnames ────────────────────────────────────────────

function normalizeHostname(hostname) {
  let host = String(hostname || '').trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  while (host.endsWith('.')) host = host.slice(0, -1);
  return host;
}

function isBlockedName(host) {
  if (host === 'localhost') return true;
  return BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * Single-integer IPv4 forms (decimal, hex, octal). The WHATWG URL parser
 * normally rewrites these to dotted-quad, but reject them outright rather
 * than trust that: no legitimate webhook host is a bare number.
 */
function isNumericHostForm(host) {
  if (host.includes(':')) return false;
  if (!host.includes('.')) return /^(0x[0-9a-f]+|\d+)$/i.test(host);
  const labels = host.split('.');
  return /^\d+$/.test(labels[labels.length - 1]);
}

/**
 * Validate a user-supplied webhook URL.
 * Throws a typed error ({ status: 400, code: 'INVALID_WEBHOOK_URL' }) on
 * rejection; returns the parsed URL on success.
 */
function validateWebhookUrl(url) {
  if (typeof url !== 'string' || !url.trim()) {
    throw guardError('INVALID_WEBHOOK_URL', 'Webhook URL is required');
  }

  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw guardError('INVALID_WEBHOOK_URL', 'Webhook URL is not a valid URL');
  }

  if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
    throw guardError('INVALID_WEBHOOK_URL', 'Webhook URL must use http or https');
  }

  if (parsed.username || parsed.password) {
    throw guardError('INVALID_WEBHOOK_URL', 'Webhook URL must not contain credentials');
  }

  if (parsed.port && !ALLOWED_PORTS.includes(parsed.port)) {
    throw guardError('INVALID_WEBHOOK_URL', `Webhook URL port ${parsed.port} is not allowed`);
  }

  const host = normalizeHostname(parsed.hostname);
  if (!host) {
    throw guardError('INVALID_WEBHOOK_URL', 'Webhook URL must include a hostname');
  }

  if (isBlockedName(host)) {
    throw guardError('INVALID_WEBHOOK_URL', 'Webhook URL host is not publicly routable');
  }

  if (net.isIP(host)) {
    if (!isPublicIp(host)) {
      throw guardError('INVALID_WEBHOOK_URL', 'Webhook URL host is not publicly routable');
    }
  } else if (isNumericHostForm(host)) {
    throw guardError('INVALID_WEBHOOK_URL', 'Webhook URL host must be a domain name');
  }

  return parsed;
}

/**
 * Resolve a hostname and require every returned address to be public.
 * Returns [{ address, family }] for pinning.
 *
 * Throws code 'BLOCKED_ADDRESS' (permanent — do not retry) when an address is
 * non-public, or 'DNS_FAILED' (transient) when resolution itself fails.
 */
async function resolveAndValidate(hostname) {
  const host = normalizeHostname(hostname);
  if (!host) throw guardError('BLOCKED_ADDRESS', 'Missing hostname');
  if (isBlockedName(host)) {
    throw guardError('BLOCKED_ADDRESS', 'Host is not publicly routable');
  }

  if (net.isIP(host)) {
    if (!isPublicIp(host)) throw guardError('BLOCKED_ADDRESS', 'Host is not publicly routable');
    return [{ address: host, family: net.isIP(host) }];
  }

  if (isNumericHostForm(host)) {
    throw guardError('BLOCKED_ADDRESS', 'Host is not publicly routable');
  }

  let results;
  try {
    results = await dns.lookup(host, { all: true, verbatim: true });
  } catch (err) {
    throw guardError('DNS_FAILED', `DNS lookup failed for ${host}: ${err.message}`);
  }

  if (!results || results.length === 0) {
    throw guardError('DNS_FAILED', `DNS lookup returned no addresses for ${host}`);
  }

  for (const result of results) {
    if (!isPublicIp(result.address)) {
      throw guardError('BLOCKED_ADDRESS', 'Host resolves to a non-public address');
    }
  }

  return results.map((r) => ({ address: r.address, family: r.family }));
}

/**
 * undici Agent that ignores DNS at connect time and dials only the addresses
 * resolveAndValidate() already approved. TLS servername still comes from the
 * URL, so certificate validation is unaffected.
 */
function createPinnedDispatcher(addresses) {
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw guardError('BLOCKED_ADDRESS', 'No validated addresses to connect to');
  }

  const pinned = addresses.map(({ address, family }) => {
    if (!isPublicIp(address)) {
      throw guardError('BLOCKED_ADDRESS', 'Refusing to pin a non-public address');
    }
    return { address, family: family || (net.isIPv6(address) ? 6 : 4) };
  });

  const { Agent } = require('undici');
  return new Agent({
    connect: {
      lookup(_hostname, options, callback) {
        if (options && options.all) return callback(null, pinned);
        callback(null, pinned[0].address, pinned[0].family);
      },
    },
  });
}

module.exports = {
  validateWebhookUrl,
  isPublicIp,
  resolveAndValidate,
  createPinnedDispatcher,
  ALLOWED_PROTOCOLS,
  ALLOWED_PORTS,
};
