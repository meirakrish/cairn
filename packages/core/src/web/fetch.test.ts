import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { PermanentIngestError } from '../ingest/errors';
import { checkWebUrl, fetchUrl, USER_AGENT, type FetchOptions } from './fetch';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

/** A local server; requests it got are recorded. */
async function serve(handler: RequestListener, host = '127.0.0.1') {
  const paths: string[] = [];
  const server = createServer((req, res) => {
    paths.push(req.url!);
    handler(req, res);
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, host, r));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://${host}:${port}`, paths };
}

// Test servers listen on 127.0.0.1 and random ports; everything else stays refused.
const local: FetchOptions = {
  maxBytes: 1000,
  allowedPorts: 'any',
  isAllowedAddress: (ip) => ip === '127.0.0.1',
};

describe('checkWebUrl', () => {
  it('accepts http and https on the standard ports', () => {
    expect(checkWebUrl('https://example.com/a?b=1').href).toBe('https://example.com/a?b=1');
    expect(checkWebUrl('http://example.com:80/').href).toBe('http://example.com/');
  });

  it.each([
    ['ftp://example.com/', /only http and https/],
    ['file:///etc/passwd', /only http and https/],
    ['javascript:alert(1)', /only http and https/],
    ['not a url', /not a valid URL/],
    ['https://user:pw@example.com/', /user name or password/],
    ['http://example.com:6379/', /standard web ports/],
    ['https://example.com/' + 'a'.repeat(2048), /limited to 2048/],
    ['http://127.0.0.1/', /private or internal/],
    ['http://0x7f.1/', /private or internal/],
    ['http://2130706433/', /private or internal/],
    ['http://[::1]/', /private or internal/],
    ['http://[::ffff:10.0.0.1]/', /private or internal/],
    ['http://169.254.169.254/latest/meta-data/', /private or internal/],
  ])('refuses %s', (url, message) => {
    expect(() => checkWebUrl(url)).toThrow(PermanentIngestError);
    expect(() => checkWebUrl(url)).toThrow(message);
  });
});

describe('fetchUrl', () => {
  it('fetches a page with its content type and final URL', async () => {
    let agent: string | undefined;
    const { origin } = await serve((req, res) => {
      agent = req.headers['user-agent'];
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<h1>Hi</h1>');
    });
    const page = await fetchUrl(`${origin}/a`, local);
    expect(page).toEqual({
      url: `${origin}/a`,
      contentType: 'text/html; charset=utf-8',
      data: new TextEncoder().encode('<h1>Hi</h1>'),
    });
    expect(agent).toBe(USER_AGENT);
  });

  it('refuses a host name that resolves to a refused address, before sending anything', async () => {
    const { origin, paths } = await serve((_, res) => res.end('secret'));
    const port = new URL(origin).port;
    // Default address policy: localhost resolves to loopback.
    const err = await fetchUrl(`http://localhost:${port}/`, {
      ...local,
      isAllowedAddress: undefined,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermanentIngestError);
    expect((err as Error).message).toMatch(/private or internal/);
    expect(paths).toEqual([]);
  });

  it('refuses the default ports policy for other ports', async () => {
    const { origin } = await serve((_, res) => res.end('x'));
    await expect(fetchUrl(origin, { ...local, allowedPorts: undefined })).rejects.toThrow(
      /standard web ports/,
    );
  });

  it('follows redirects, checking each one', async () => {
    const { origin } = await serve((req, res) => {
      if (req.url === '/old') res.writeHead(301, { location: '/new' }).end();
      else res.end('moved here');
    });
    const page = await fetchUrl(`${origin}/old`, local);
    expect(page.url).toBe(`${origin}/new`);
    expect(new TextDecoder().decode(page.data)).toBe('moved here');
  });

  it('refuses a redirect to an internal address', async () => {
    // 127.0.0.2 is loopback too, but not allowed by the test policy.
    const inner = await serve((_, res) => res.end('secret'), '127.0.0.2');
    const { origin } = await serve((_, res) =>
      res.writeHead(302, { location: `${inner.origin}/admin` }).end(),
    );
    await expect(fetchUrl(origin, local)).rejects.toThrow(/private or internal/);
    expect(inner.paths).toEqual([]);
  });

  it('refuses a redirect to another scheme', async () => {
    const { origin } = await serve((_, res) =>
      res.writeHead(302, { location: 'file:///etc/passwd' }).end(),
    );
    await expect(fetchUrl(origin, local)).rejects.toThrow(/only http and https/);
  });

  it('stops after 5 redirects', async () => {
    const { origin, paths } = await serve((req, res) =>
      res.writeHead(302, { location: `/r${paths.length}` }).end(),
    );
    await expect(fetchUrl(origin, local)).rejects.toThrow(/too many redirects/);
    expect(paths).toHaveLength(6);
  });

  it('fails 4xx permanently and retries 5xx and 429', async () => {
    const { origin } = await serve((req, res) => res.writeHead(Number(req.url!.slice(1))).end());
    const err404 = await fetchUrl(`${origin}/404`, local).catch((e: unknown) => e);
    expect(err404).toBeInstanceOf(PermanentIngestError);
    expect((err404 as Error).message).toBe('the site answered 404');
    for (const status of [429, 503]) {
      const err = await fetchUrl(`${origin}/${status}`, local).catch((e: unknown) => e);
      expect(err).not.toBeInstanceOf(PermanentIngestError);
      expect((err as Error).message).toBe(`the site answered ${status}`);
    }
  });

  it('caps the body by Content-Length and while streaming', async () => {
    const { origin } = await serve((req, res) => {
      if (req.url === '/declared') res.setHeader('content-length', '5000');
      res.end('x'.repeat(5000));
    });
    await expect(fetchUrl(`${origin}/declared`, local)).rejects.toThrow(/larger than/);
    await expect(fetchUrl(`${origin}/chunked`, local)).rejects.toThrow(PermanentIngestError);
  });

  it('decompresses gzip, and caps the decompressed size', async () => {
    const { origin } = await serve((req, res) => {
      res.setHeader('content-encoding', 'gzip');
      res.end(gzipSync(req.url === '/bomb' ? 'x'.repeat(1_000_000) : 'small page'));
    });
    const page = await fetchUrl(`${origin}/ok`, local);
    expect(new TextDecoder().decode(page.data)).toBe('small page');
    await expect(fetchUrl(`${origin}/bomb`, local)).rejects.toThrow(/larger than/);
  });

  it('times out a slow site, as a retryable error', async () => {
    const { origin } = await serve((_, res) => {
      res.write('start');
      // Never ends.
    });
    const err = await fetchUrl(origin, { ...local, timeoutMs: 200 }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(PermanentIngestError);
    expect((err as Error).message).toBe('the site took too long to answer');
  });

  it('reports an unknown host permanently', async () => {
    await expect(fetchUrl('http://cairn-test.invalid/', local)).rejects.toThrow(/no site found/);
  });
});
