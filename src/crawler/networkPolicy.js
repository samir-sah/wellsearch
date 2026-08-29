import dns from 'node:dns/promises';
import net from 'node:net';

const BLOCKED_HOSTS = new Set([
  'localhost', 'localhost.localdomain', 'metadata', 'metadata.google.internal', 'instance-data',
]);

/** Resolve once and return only addresses that the request is allowed to use. */
export async function checkCrawlTarget(input, { allowPrivateNetwork = false, lookup = dns.lookup } = {}) {
  let url;
  try {
    url = new URL(input);
  } catch {
    return { allowed: false, reason: 'invalid-url' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { allowed: false, reason: 'invalid-protocol' };
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (BLOCKED_HOSTS.has(hostname) || hostname.endsWith('.localhost')) {
    return { allowed: false, reason: 'private-network', hostname, addresses: [] };
  }

  let answers;
  if (net.isIP(hostname)) {
    answers = [{ address: hostname, family: net.isIP(hostname) }];
  } else {
    try {
      answers = await lookup(hostname, { all: true, verbatim: true });
    } catch (error) {
      return { allowed: false, reason: 'dns', hostname, error };
    }
  }

  const addresses = answers
    .map(({ address, family }) => ({
      address: String(address).split('%')[0],
      family: Number(family) || net.isIP(String(address).split('%')[0]),
    }))
    .filter(({ address, family }) => address && (family === 4 || family === 6));

  if (addresses.length === 0) return { allowed: false, reason: 'dns', hostname, addresses: [] };
  if (!allowPrivateNetwork && addresses.some(({ address }) => isPrivateAddress(address))) {
    return { allowed: false, reason: 'private-network', hostname, addresses };
  }
  return { allowed: true, hostname, addresses };
}

/** Reject non-global IPv4/IPv6, including mapped IPv4 and metadata ranges. */
export function isPrivateAddress(address) {
  const value = String(address).toLowerCase().split('%')[0].replace(/^\[|\]$/g, '');
  const family = net.isIP(value);
  if (family === 4) {
    const n = ipv4Number(value);
    return inV4(n, '0.0.0.0', 8) || inV4(n, '10.0.0.0', 8) ||
      inV4(n, '100.64.0.0', 10) || inV4(n, '127.0.0.0', 8) ||
      inV4(n, '169.254.0.0', 16) || inV4(n, '172.16.0.0', 12) ||
      inV4(n, '192.0.0.0', 24) || inV4(n, '192.0.2.0', 24) ||
      inV4(n, '192.88.99.0', 24) || inV4(n, '192.168.0.0', 16) ||
      inV4(n, '198.18.0.0', 15) || inV4(n, '198.51.100.0', 24) ||
      inV4(n, '203.0.113.0', 24) || inV4(n, '224.0.0.0', 4);
  }
  if (family !== 6) return true;

  const n = ipv6Number(value);
  if ((n >> 32n) === 0xffffn) {
    const mapped = Number(n & 0xffffffffn);
    return isPrivateAddress(`${mapped >>> 24}.${(mapped >>> 16) & 255}.${(mapped >>> 8) & 255}.${mapped & 255}`);
  }

  return inV6(n, '::', 128) || inV6(n, '::1', 128) ||
    inV6(n, '64:ff9b:1::', 48) || inV6(n, '100::', 64) ||
    inV6(n, '2001::', 32) || inV6(n, '2001:2::', 48) ||
    inV6(n, '2001:10::', 28) || inV6(n, '2001:20::', 28) ||
    inV6(n, '2001:db8::', 32) || inV6(n, '2002::', 16) || inV6(n, '3fff::', 20) ||
    inV6(n, 'fc00::', 7) || inV6(n, 'fe80::', 10) || inV6(n, 'ff00::', 8);
}

function ipv4Number(value) {
  return value.split('.').reduce((number, part) => (number * 256) + Number(part), 0) >>> 0;
}

function inV4(value, base, bits) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (ipv4Number(base) & mask);
}

function ipv6Number(value) {
  let input = value;
  let ipv4 = null;
  if (input.includes('.')) {
    const separator = input.lastIndexOf(':');
    ipv4 = ipv4Number(input.slice(separator + 1));
    input = `${input.slice(0, separator)}:${(ipv4 >>> 16).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }
  const halves = input.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 2
    ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
    : left;
  return groups.reduce((number, group) => (number << 16n) | BigInt(`0x${group || '0'}`), 0n);
}

function inV6(value, base, bits) {
  const shift = 128n - BigInt(bits);
  return (value >> shift) === (ipv6Number(base) >> shift);
}
