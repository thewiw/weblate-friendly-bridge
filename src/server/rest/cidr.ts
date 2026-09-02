/**
 * Minimal CIDR matching for the public-export host allowlist.
 * Supports IPv4 and IPv6 (prefix length required, e.g. 10.0.0.0/8;
 * a bare IP means that single host). Parsing is strict: anything that
 * does not fully parse is reported to the caller, never silently dropped.
 */

export interface Cidr {
  /** Network address as an unsigned big integer. */
  value: bigint;
  /** Prefix length in bits. */
  bits: number;
  version: 4 | 6;
}

/** Parses a decimal IPv4 string into its unsigned 32-bit integer. */
const ipv4ToBigInt = (ip: string): bigint | null => {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = (value << 8n) | BigInt(n);
  }
  return value;
};

/** Parses an IPv6 address (with optional :: compression) into 128 bits. */
const ipv6ToBigInt = (ip: string): bigint | null => {
  const doubleColon = ip.split('::');
  if (doubleColon.length > 2) return null;
  const parseGroups = (s: string): bigint[] | null => {
    if (s === '') return [];
    const groups: bigint[] = [];
    for (const group of s.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      groups.push(BigInt(parseInt(group, 16)));
    }
    return groups;
  };
  const head = parseGroups(doubleColon[0] ?? '');
  const tail = doubleColon.length === 2 ? (parseGroups(doubleColon[1] ?? '') ?? []) : [];
  if (head === null) return null;
  const missing = doubleColon.length === 2 ? 8 - head.length - tail.length : 0;
  if (missing < 0 || (doubleColon.length === 2 && missing === 0)) return null;
  let value = 0n;
  for (const group of head) value = (value << 16n) | group;
  for (let i = 0; i < missing; i++) value = value << 16n;
  for (const group of tail) value = (value << 16n) | group;
  if (doubleColon.length === 1 && head.length !== 8) return null;
  return value;
};

/** Strips the IPv4-mapped-IPv6 wrapper ("::ffff:127.0.0.1" → "127.0.0.1"). */
const normalizeIp = (ip: string): string =>
  ip.toLowerCase().startsWith('::ffff:') && ip.slice(7).includes('.')
    ? ip.slice(7)
    : ip;

const ipToBigInt = (ipRaw: string, version: 4 | 6): bigint | null => {
  const ip = normalizeIp(ipRaw);
  return version === 4 ? ipv4ToBigInt(ip) : ipv6ToBigInt(ip);
};

const detectVersion = (ip: string): 4 | 6 | null => {
  if (ip.includes(':')) {
    // IPv4-mapped IPv6 (::ffff:a.b.c.d) is treated as plain IPv4 — Node
    // reports dual-stack peers this way (req.ip behind a '::' listener).
    if (ip.toLowerCase().startsWith('::ffff:')) {
      return ip.slice(7).includes('.') ? 4 : 6;
    }
    return ip.includes('.') ? null : 6;
  }
  return ip.includes('.') ? 4 : null;
};

/** Parses one CIDR entry ("10.0.0.0/8", "2001:db8::/32", or a plain IP). */
export function parseCidr(entry: string): Cidr | null {
  const trimmed = entry.trim();
  const slashAt = trimmed.indexOf('/');
  const address = (slashAt > -1 ? trimmed.slice(0, slashAt) : trimmed).trim();
  const bitsRaw = slashAt > -1 ? trimmed.slice(slashAt + 1).trim() : undefined;
  if (bitsRaw !== undefined && !/^\d{1,3}$/.test(bitsRaw)) return null;
  const version = detectVersion(address);
  if (version === null) return null;
  const value = ipToBigInt(address, version);
  if (value === null) return null;
  const maxBits = version === 4 ? 32 : 128;
  const bits = bitsRaw === undefined ? maxBits : Number(bitsRaw);
  if (bits > maxBits) return null;
  return { value, bits, version };
}

/** Parses a comma-separated host list, reporting invalid entries. */
export function parseHostList(spec: string): { cidrs: Cidr[]; invalid: string[] } {
  const cidrs: Cidr[] = [];
  const invalid: string[] = [];
  for (const raw of spec.split(',')) {
    const entry = raw.trim();
    if (entry === '') continue;
    const parsed = parseCidr(entry);
    if (parsed === null) invalid.push(entry);
    else cidrs.push(parsed);
  }
  return { cidrs, invalid };
}

/** True when `ip` falls within the given CIDR range (same IP version). */
export function ipMatchesCidr(ip: string, cidr: Cidr): boolean {
  const version = detectVersion(ip.trim());
  if (version === null || version !== cidr.version) return false;
  const value = ipToBigInt(ip.trim(), version);
  if (value === null) return false;
  const hostBits = BigInt(cidr.version === 4 ? 32 - cidr.bits : 128 - cidr.bits);
  return value >> hostBits === cidr.value >> hostBits;
}

/** True when the IP matches at least one CIDR of the parsed list. */
export function anyIpAllowed(ip: string, cidrs: readonly Cidr[]): boolean {
  return cidrs.some((cidr) => ipMatchesCidr(ip, cidr));
}