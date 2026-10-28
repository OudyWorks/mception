import dns from 'node:dns';
import net from 'node:net';

function ipv4ToInt(ip: string): number {
  return (
    ip
      .split('.')
      .reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0
  );
}

function inSubnet(ipInt: number, subnetInt: number, maskBits: number): boolean {
  const mask = maskBits === 0 ? 0 : (~0 << (32 - maskBits)) >>> 0;
  return (ipInt & mask) === (subnetInt & mask);
}

export function isIpAllowed(ip: string, blockPrivate: boolean = false): boolean {
  const family = net.isIP(ip);
  if (!family) {
    return false;
  }

  // IPv4 Checks
  if (family === 4) {
    const ipInt = ipv4ToInt(ip);

    // 0.0.0.0
    if (ipInt === 0) {
      return false;
    }

    // Link-local / Cloud metadata (169.254.0.0/16) - ALWAYS BLOCKED
    if (inSubnet(ipInt, ipv4ToInt('169.254.0.0'), 16)) {
      return false;
    }

    if (blockPrivate) {
      // Loopback (127.0.0.0/8)
      if (inSubnet(ipInt, ipv4ToInt('127.0.0.0'), 8)) {
        return false;
      }
      // 10.0.0.0/8
      if (inSubnet(ipInt, ipv4ToInt('10.0.0.0'), 8)) {
        return false;
      }
      // 172.16.0.0/12
      if (inSubnet(ipInt, ipv4ToInt('172.16.0.0'), 12)) {
        return false;
      }
      // 192.168.0.0/16
      if (inSubnet(ipInt, ipv4ToInt('192.168.0.0'), 16)) {
        return false;
      }
      // Broadcast
      if (ip === '255.255.255.255') {
        return false;
      }
    }

    return true;
  }

  // IPv6 Checks
  if (family === 6) {
    const normalized = ip.toLowerCase();

    // Link-local (fe80::/10) - ALWAYS BLOCKED
    if (normalized.startsWith('fe80:')) {
      return false;
    }

    if (blockPrivate) {
      // Loopback (::1)
      if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') {
        return false;
      }
      // Unique local (fc00::/7)
      if (normalized.startsWith('fc') || normalized.startsWith('fd')) {
        return false;
      }
    }

    return true;
  }

  return false;
}

export async function validateTargetUrl(
  urlStr: string,
  blockPrivate: boolean = false
): Promise<{ validatedUrl: URL; resolvedIps: string[] }> {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    throw new Error(`Invalid URL: ${urlStr}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(
      `Disallowed protocol: ${url.protocol}. Only http: and https: are supported.`
    );
  }

  const hostname = url.hostname;
  let resolvedIps: string[] = [];

  if (net.isIP(hostname)) {
    resolvedIps = [hostname];
  } else {
    try {
      const records = await dns.promises.lookup(hostname, { all: true });
      resolvedIps = records.map((r) => r.address);
    } catch (err) {
      throw new Error(
        `Failed to resolve upstream host "${hostname}": ${(err as Error).message}`
      );
    }
  }

  if (resolvedIps.length === 0) {
    throw new Error(`Host "${hostname}" did not resolve to any IP address.`);
  }

  for (const resolvedIp of resolvedIps) {
    if (!isIpAllowed(resolvedIp, blockPrivate)) {
      throw new Error(
        `Target address "${resolvedIp}" for host "${hostname}" is disallowed by SSRF policy.`
      );
    }
  }

  return { validatedUrl: url, resolvedIps };
}

export function createSafeFetch(blockPrivate: boolean = false) {
  return async function safeFetch(
    input: string | URL,
    init?: RequestInit
  ): Promise<Response> {
    const urlStr = typeof input === 'string' ? input : input.toString();
    await validateTargetUrl(urlStr, blockPrivate);

    // Disable automatic redirect following to prevent SSRF bypass
    const options: RequestInit = {
      ...init,
      redirect: 'manual',
    };

    return fetch(input, options);
  };
}
