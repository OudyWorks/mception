import { describe, expect, it } from 'vitest';
import { isIpAllowed, validateTargetUrl } from '../../src/security/ssrf.js';

describe('SSRF Protection Engine', () => {
  describe('isIpAllowed()', () => {
    it('always blocks link-local / cloud metadata (169.254.169.254)', () => {
      expect(isIpAllowed('169.254.169.254', false)).toBe(false);
      expect(isIpAllowed('169.254.169.254', true)).toBe(false);
      expect(isIpAllowed('169.254.1.1', false)).toBe(false);
    });

    it('always blocks IPv6 link-local addresses (fe80::/10)', () => {
      expect(isIpAllowed('fe80::1', false)).toBe(false);
      expect(isIpAllowed('fe80::1', true)).toBe(false);
    });

    it('always blocks 0.0.0.0', () => {
      expect(isIpAllowed('0.0.0.0', false)).toBe(false);
      expect(isIpAllowed('0.0.0.0', true)).toBe(false);
    });

    it('allows loopback and RFC 1918 private subnets by default for developer convenience', () => {
      // Loopback
      expect(isIpAllowed('127.0.0.1', false)).toBe(true);
      expect(isIpAllowed('::1', false)).toBe(true);

      // RFC 1918
      expect(isIpAllowed('10.0.0.1', false)).toBe(true);
      expect(isIpAllowed('172.16.0.1', false)).toBe(true);
      expect(isIpAllowed('172.20.0.5', false)).toBe(true); // Docker bridge
      expect(isIpAllowed('192.168.1.100', false)).toBe(true);
    });

    it('blocks loopback and RFC 1918 subnets when blockPrivate is true', () => {
      // Loopback
      expect(isIpAllowed('127.0.0.1', true)).toBe(false);
      expect(isIpAllowed('127.255.255.255', true)).toBe(false);
      expect(isIpAllowed('::1', true)).toBe(false);

      // RFC 1918
      expect(isIpAllowed('10.0.0.1', true)).toBe(false);
      expect(isIpAllowed('172.16.0.1', true)).toBe(false);
      expect(isIpAllowed('172.31.255.255', true)).toBe(false);
      expect(isIpAllowed('192.168.1.1', true)).toBe(false);
    });

    it('allows public IP addresses in both modes', () => {
      expect(isIpAllowed('8.8.8.8', false)).toBe(true);
      expect(isIpAllowed('8.8.8.8', true)).toBe(true);
      expect(isIpAllowed('1.1.1.1', false)).toBe(true);
      expect(isIpAllowed('1.1.1.1', true)).toBe(true);
      expect(isIpAllowed('2606:4700:4700::1111', false)).toBe(true);
      expect(isIpAllowed('2606:4700:4700::1111', true)).toBe(true);
    });

    it('rejects invalid IP strings', () => {
      expect(isIpAllowed('not-an-ip', false)).toBe(false);
      expect(isIpAllowed('', false)).toBe(false);
      expect(isIpAllowed('999.999.999.999', false)).toBe(false);
    });
  });

  describe('validateTargetUrl()', () => {
    it('validates public http and https URLs successfully', async () => {
      const res = await validateTargetUrl('http://1.1.1.1:8080/sse', false);
      expect(res.validatedUrl.hostname).toBe('1.1.1.1');
      expect(res.resolvedIps).toContain('1.1.1.1');
    });

    it('rejects non-HTTP protocols', async () => {
      await expect(
        validateTargetUrl('ftp://example.com/sse', false)
      ).rejects.toThrow(/Disallowed protocol/);

      await expect(
        validateTargetUrl('file:///etc/passwd', false)
      ).rejects.toThrow(/Disallowed protocol/);
    });

    it('rejects URLs pointing to cloud metadata IP', async () => {
      await expect(
        validateTargetUrl('http://169.254.169.254/latest/meta-data', false)
      ).rejects.toThrow(/disallowed by SSRF policy/);
    });

    it('allows localhost and private IPs by default', async () => {
      const res = await validateTargetUrl('http://127.0.0.1:3001/sse', false);
      expect(res.validatedUrl.port).toBe('3001');
    });

    it('blocks localhost when blockPrivate is true', async () => {
      await expect(
        validateTargetUrl('http://127.0.0.1:3001/sse', true)
      ).rejects.toThrow(/disallowed by SSRF policy/);
    });
  });
});
