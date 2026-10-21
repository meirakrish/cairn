import { describe, expect, it } from 'vitest';
import { isPublicAddress } from './address';

describe('isPublicAddress', () => {
  it('allows public IPv4 and IPv6', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '151.101.1.69', '2606:4700::1111', '2a00:1450::1']) {
      expect(isPublicAddress(ip), ip).toBe(true);
    }
  });

  it('refuses private, loopback, link-local and other special IPv4', () => {
    for (const ip of [
      '0.0.0.0',
      '10.1.2.3',
      '100.64.0.1',
      '127.0.0.1',
      '127.255.255.254',
      '169.254.169.254',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.49.2',
      '198.18.0.1',
      '224.0.0.1',
      '255.255.255.255',
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });

  it('refuses IPv6 outside global unicast and ranges that embed IPv4', () => {
    for (const ip of [
      '::',
      '::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::ffff:8.8.8.8',
      '64:ff9b::a00:1',
      'fd00::1',
      'fe80::1',
      'ff02::1',
      '2001::1',
      '2001:db8::1',
      '2002:a00:1::1',
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });

  it('refuses things that are not addresses', () => {
    expect(isPublicAddress('localhost')).toBe(false);
    expect(isPublicAddress('')).toBe(false);
  });
});
