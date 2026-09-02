import { describe, expect, it } from 'vitest';
import {
  anyIpAllowed,
  ipMatchesCidr,
  parseCidr,
  parseHostList,
} from '../../server/rest/cidr.js';

describe('parseCidr', () => {
  it('parses IPv4 ranges and plain hosts', () => {
    expect(parseCidr('10.0.0.0/8')).toEqual({ value: 10n * 2n ** 24n, bits: 8, version: 4 });
    expect(parseCidr('192.168.1.5')).toEqual({
      value: 3232235781n,
      bits: 32,
      version: 4,
    });
  });

  it('parses IPv6 ranges (with :: compression) and plain hosts', () => {
    const cidr = parseCidr('2001:db8::/32');
    expect(cidr).not.toBeNull();
    expect(cidr!.version).toBe(6);
    expect(cidr!.bits).toBe(32);
    const host = parseCidr('::1');
    expect(host).toMatchObject({ bits: 128, version: 6 });
  });

  it('rejects malformed entries', () => {
    for (const bad of ['abc', '256.1.1.1', '1.2.3', '1.2.3.4/33', '1.2.3.4/-1', '1.2.3.4/x', '1.2.3.4::5', '::1::2', '']) {
      expect(parseCidr(bad)).toBeNull();
    }
  });
});

describe('ipMatchesCidr', () => {
  const v4 = parseCidr('192.168.1.0/24')!;
  const v6 = parseCidr('2001:db8::/32')!;

  it('matches addresses inside the range', () => {
    expect(ipMatchesCidr('192.168.1.5', v4)).toBe(true);
    expect(ipMatchesCidr('192.168.1.255', v4)).toBe(true);
    expect(ipMatchesCidr('2001:db8:dead::1', v6)).toBe(true);
  });

  it('rejects addresses outside the range', () => {
    expect(ipMatchesCidr('192.168.2.1', v4)).toBe(false);
    expect(ipMatchesCidr('10.0.0.1', v4)).toBe(false);
    expect(ipMatchesCidr('2001:db9::1', v6)).toBe(false);
  });

  it('treats IPv4-mapped IPv6 peers (::ffff:a.b.c.d) as IPv4', () => {
    expect(ipMatchesCidr('::ffff:192.168.1.5', v4)).toBe(true);
    expect(ipMatchesCidr('::ffff:192.168.2.5', v4)).toBe(false);
  });

  it('rejects version mismatches and malformed IPs', () => {
    expect(ipMatchesCidr('2001:db8::1', v4)).toBe(false);
    expect(ipMatchesCidr('192.168.1.1', v6)).toBe(false);
    expect(ipMatchesCidr('not-an-ip', v4)).toBe(false);
  });
});

describe('parseHostList', () => {
  it('parses a comma-separated list, tolerating whitespace', () => {
    const { cidrs, invalid } = parseHostList(' 192.168.1.0/24 , 10.0.0.1 , 2001:db8::/32 ');
    expect(cidrs).toHaveLength(3);
    expect(invalid).toEqual([]);
  });

  it('reports invalid entries instead of dropping them silently', () => {
    const { cidrs, invalid } = parseHostList('10.0.0.0/8, not-a-host, 300.1.1.1/8');
    expect(cidrs).toHaveLength(1);
    expect(invalid).toEqual(['not-a-host', '300.1.1.1/8']);
  });

  it('accepts 0.0.0.0/0 as match-all', () => {
    const all = parseHostList('0.0.0.0/0').cidrs;
    expect(anyIpAllowed('203.0.113.9', all)).toBe(true);
  });
});