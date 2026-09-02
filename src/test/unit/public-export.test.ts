import { describe, expect, it } from 'vitest';
import { evaluatePublicExport } from '../../server/rest/public-export.js';

const liveBase = {
  mode: 'live',
  weblateUrl: 'http://weblate.test',
  apiKey: 'secret-key',
  allowedHosts: '192.168.1.0/24,::1',
} as const;

describe('evaluatePublicExport', () => {
  it('allows any request in mock mode (no live Weblate to validate against)', () => {
    expect(evaluatePublicExport({ ...liveBase, mode: 'mock', apiKey: '', allowedHosts: '', clientIp: '1.2.3.4' })).toEqual({ ok: true });
  });

  it('denies when either variable is missing', () => {
    for (const opts of [
      { ...liveBase, apiKey: '' },
      { ...liveBase, allowedHosts: '   ' },
      { ...liveBase, apiKey: '', allowedHosts: '' },
    ]) {
      const decision = evaluatePublicExport({ ...opts, clientIp: '192.168.1.5' });
      expect(decision).toMatchObject({ ok: false, status: 403 });
      if (!decision.ok) expect(decision.error).toContain('not enabled');
    }
  });

  it('denies on malformed host lists, listing the bad entries', () => {
    const decision = evaluatePublicExport({
      ...liveBase,
      allowedHosts: '10.0.0.0/8, not-a-host',
      clientIp: '10.0.0.1',
    });
    expect(decision).toMatchObject({ ok: false, status: 403 });
    if (!decision.ok) expect(decision.error).toContain('not-a-host');
  });

  it('denies hosts with no valid entry', () => {
    const decision = evaluatePublicExport({ ...liveBase, allowedHosts: ',,', clientIp: '10.0.0.1' });
    expect(decision).toMatchObject({ ok: false, status: 403 });
  });

  it('denies client IPs outside the allowed ranges', () => {
    const decision = evaluatePublicExport({ ...liveBase, clientIp: '10.9.9.9' });
    expect(decision).toMatchObject({ ok: false, status: 403 });
    if (!decision.ok) expect(decision.error).toContain('Client host not allowed');
  });

  it('allows client IPs inside the ranges (IPv4 and IPv6)', () => {
    expect(evaluatePublicExport({ ...liveBase, clientIp: '192.168.1.99' })).toEqual({ ok: true });
    expect(evaluatePublicExport({ ...liveBase, clientIp: '::1' })).toEqual({ ok: true });
  });
});