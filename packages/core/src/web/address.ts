import { BlockList, isIP } from 'node:net';

// Addresses a fetch may not reach: everything that isn't the public internet, so a URL can't be used
// to talk to Postgres, Redis, Garage, Ollama, the cloud metadata service or anything else inside.
const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, incl. 169.254.169.254 (cloud metadata)
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, incl. 255.255.255.255
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}

// IPv6: only global unicast (2000::/3), minus the ranges in it that embed an IPv4 address or aren't
// public. This also excludes ::1, ::, IPv4-mapped (::ffff:0:0/96), fc00::/7, fe80::/10 and ff00::/8.
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [net, prefix] of [
  ['2001::', 23], // IETF protocol assignments, incl. Teredo (2001::/32)
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

/** True for an IP address on the public internet; false for private, internal and special ranges. */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !blocked.check(ip, 'ipv4');
  if (family === 6) return globalV6.check(ip, 'ipv6') && !blocked.check(ip, 'ipv6');
  return false;
}
