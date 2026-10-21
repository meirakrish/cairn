import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import type { Readable } from 'node:stream';
import zlib from 'node:zlib';
import { PermanentIngestError } from '../ingest/errors';
import { isPublicAddress } from './address';

export const FETCH_LIMITS = {
  maxUrlLength: 2048,
  maxRedirects: 5,
  /** For the whole fetch: every redirect, the headers and the body. */
  timeoutMs: 20_000,
};

export const USER_AGENT = 'Cairn/0.1 (+https://github.com/meirakrish/cairn)';

export interface FetchPolicy {
  /** Decides each address connected to (default: public addresses only). */
  isAllowedAddress?: (ip: string) => boolean;
  /** Default 80 and 443; tests use 'any' for their local servers. */
  allowedPorts?: readonly number[] | 'any';
}

export interface FetchOptions extends FetchPolicy {
  /** Body size cap, after decompression. */
  maxBytes: number;
  timeoutMs?: number;
}

export interface FetchedPage {
  /** After redirects. */
  url: string;
  /** As sent, e.g. `text/html; charset=utf-8`; empty if the site sent none. */
  contentType: string;
  data: Uint8Array;
}

/**
 * Checks a URL a user wants fetched: http(s), not too long, no credentials, an allowed port, and not
 * an IP literal outside the allowed addresses. Host names are checked when connecting (fetchUrl).
 * Throws PermanentIngestError with a message for the user.
 */
export function checkWebUrl(raw: string, policy: FetchPolicy = {}): URL {
  if (raw.length > FETCH_LIMITS.maxUrlLength) {
    throw new PermanentIngestError(`URLs are limited to ${FETCH_LIMITS.maxUrlLength} characters`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PermanentIngestError('not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PermanentIngestError('only http and https URLs can be added');
  }
  if (url.username || url.password) {
    throw new PermanentIngestError('URLs with a user name or password are not supported');
  }
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  const ports = policy.allowedPorts ?? [80, 443];
  if (ports !== 'any' && !ports.includes(port)) {
    throw new PermanentIngestError('only the standard web ports (80 and 443) are supported');
  }
  // URL already normalises odd forms (0x7f.1, 2130706433) to dotted IPv4; IPv6 comes in brackets.
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  if (isIP(host) && !(policy.isAllowedAddress ?? isPublicAddress)(host)) throw blockedError();
  return url;
}

function blockedError() {
  return new PermanentIngestError('this address is on a private or internal network');
}

/**
 * Resolves like dns.lookup, but fails if any address of the host is not allowed. Used as the socket's
 * lookup, so the address checked is the one connected to (no gap for DNS rebinding).
 */
function guardedLookup(isAllowed: (ip: string) => boolean): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
      if (err) return callback(err, '', 0);
      if (addresses.length === 0 || addresses.some((a) => !isAllowed(a.address))) {
        return callback(blockedError(), '', 0);
      }
      if (options.all) return (callback as (e: null, a: LookupAddress[]) => void)(null, addresses);
      callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  };
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const TRANSIENT = new Set([408, 425, 429]);

/**
 * Fetches one public web page (GET, no cookies) with redirects, a size cap and a total timeout.
 * Problems with the URL or the site's answer throw PermanentIngestError; timeouts, 5xx and network
 * errors throw a plain Error so the job is retried.
 */
export async function fetchUrl(raw: string, opts: FetchOptions): Promise<FetchedPage> {
  const lookup = guardedLookup(opts.isAllowedAddress ?? isPublicAddress);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? FETCH_LIMITS.timeoutMs);
  try {
    let url = checkWebUrl(raw, opts);
    for (let hop = 0; ; hop++) {
      const res = await request(url, lookup, controller.signal);
      const status = res.statusCode ?? 0;
      if (REDIRECTS.has(status) && res.headers.location) {
        res.resume();
        if (hop >= FETCH_LIMITS.maxRedirects) throw new PermanentIngestError('too many redirects');
        url = checkWebUrl(new URL(res.headers.location, url).href, opts);
        continue;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        const message = `the site answered ${status}`;
        if (status >= 500 || TRANSIENT.has(status)) throw new Error(message);
        throw new PermanentIngestError(message);
      }
      const data = await readBody(res, opts.maxBytes);
      return { url: url.href, contentType: res.headers['content-type'] ?? '', data };
    }
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error('the site took too long to answer', { cause: err });
    }
    throw describeNetworkError(err);
  } finally {
    clearTimeout(timer);
  }
}

function request(
  url: URL,
  lookup: LookupFunction,
  signal: AbortSignal,
): Promise<http.IncomingMessage> {
  const get = url.protocol === 'https:' ? https.get : http.get;
  return new Promise((resolve, reject) => {
    const req = get(url, {
      lookup,
      signal,
      agent: false,
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
        'accept-encoding': 'gzip, deflate, br',
      },
    });
    req.on('response', resolve);
    req.on('error', reject);
  });
}

async function readBody(res: http.IncomingMessage, maxBytes: number): Promise<Uint8Array> {
  const tooLarge = () =>
    new PermanentIngestError(`the page is larger than ${Math.round(maxBytes / 1e6)} MB`);
  if (Number(res.headers['content-length']) > maxBytes) {
    res.destroy();
    throw tooLarge();
  }
  const encoding = (res.headers['content-encoding'] ?? '').trim().toLowerCase();
  let body: Readable = res;
  if (encoding === 'gzip' || encoding === 'x-gzip') body = res.pipe(zlib.createGunzip());
  else if (encoding === 'deflate') body = res.pipe(zlib.createInflate());
  else if (encoding === 'br') body = res.pipe(zlib.createBrotliDecompress());
  else if (encoding !== '' && encoding !== 'identity') {
    res.destroy();
    throw new PermanentIngestError(`the site sent an unsupported encoding (${encoding})`);
  }

  // The cap applies after decompression, so a small compressed bomb stops at maxBytes too.
  const parts: Buffer[] = [];
  let size = 0;
  try {
    for await (const part of body as AsyncIterable<Buffer>) {
      size += part.length;
      if (size > maxBytes) throw tooLarge();
      parts.push(part);
    }
  } catch (err) {
    if (err instanceof PermanentIngestError) throw err;
    if ((err as { code?: string }).code?.startsWith('Z_')) {
      throw new PermanentIngestError('the site sent a corrupt compressed page');
    }
    throw err;
  } finally {
    res.destroy();
  }
  return new Uint8Array(Buffer.concat(parts));
}

const CERT_ERRORS =
  /^(CERT_|ERR_TLS_CERT|UNABLE_TO_|DEPTH_ZERO_SELF_SIGNED|SELF_SIGNED_CERT|ERR_SSL_)/;

/** Turns socket and DNS errors into short messages for the user; keeps the retry split. */
function describeNetworkError(err: unknown): Error {
  if (err instanceof PermanentIngestError) return err;
  const code = (err as { code?: string }).code ?? '';
  if (code === 'ENOTFOUND') return new PermanentIngestError('no site found at this address');
  if (CERT_ERRORS.test(code)) {
    return new PermanentIngestError("the site's HTTPS certificate is not valid");
  }
  if (code.startsWith('HPE_')) {
    return new PermanentIngestError('the site sent a malformed answer');
  }
  return err instanceof Error ? err : new Error(String(err));
}
