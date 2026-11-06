import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  STUB_SOURCES,
  createHubServer,
  createMiddlewareStack,
  createStaticHandler,
} from './hubServer.mjs';

/** Runs one request through a handler and gives back what it answered. */
function call(app, url, method = 'GET') {
  return new Promise((resolve) => {
    const headers = {};
    let body = '';
    const res = {
      statusCode: 200,
      headersSent: false,
      setHeader: (k, v) => (headers[k.toLowerCase()] = v),
      write: (chunk) => (body += chunk),
      end: (chunk) => {
        if (chunk) body += chunk;
        resolve({ status: res.statusCode, headers, body, fellThrough: false });
      },
      on() {},
      once() {},
      emit() {},
      removeListener() {},
    };
    const req = { url, method, headers: {} };
    // Streams pipe into res: give it the bits pipe() needs.
    res.writable = true;
    app(req, res, () =>
      resolve({ status: null, headers, body, fellThrough: true }),
    );
  });
}

test('a mounted handler sees the URL with its mount stripped', async () => {
  const app = createMiddlewareStack();
  const seen = [];
  app.use('/api/weather', (req, res) => {
    seen.push(req.url);
    res.end('w');
  });
  app.use((req, res) => res.end('rest'));
  assert.equal(
    (await call(app, '/api/weather/manifest?product=radar')).body,
    'w',
  );
  assert.deepEqual(seen, ['/manifest?product=radar']);
  // A longer word is another route, never a match on the prefix.
  assert.equal((await call(app, '/api/weatherx')).body, 'rest');
  assert.equal((await call(app, '/other')).body, 'rest');
});

test('next() gives the next handler the original URL back', async () => {
  const app = createMiddlewareStack();
  app.use('/api', (_req, _res, next) => next());
  app.use((req, res) => res.end(req.url));
  assert.equal((await call(app, '/api/flights')).body, '/api/flights');
});

test('an error skips plain handlers and reaches the error handler', async () => {
  const app = createMiddlewareStack();
  app.use(() => {
    throw new Error('boom');
  });
  app.use((_req, res) => res.end('skipped'));
  app.use((err, _req, res, _next) => res.end(`caught ${err.message}`));
  assert.equal((await call(app, '/')).body, 'caught boom');
});

function distFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-hub-dist-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<html>globe</html>');
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'assets', 'a.js'), 'x');
  fs.writeFileSync(path.join(os.tmpdir(), 'gev-hub-secret.txt'), 'secret');
  return dir;
}

test('dist files are served, page paths fall back to index.html', async () => {
  const dir = distFixture();
  const app = createMiddlewareStack();
  app.use(createStaticHandler(dir));
  const asset = await call(app, '/assets/a.js');
  assert.equal(asset.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal((await call(app, '/')).headers['content-length'], 18);
  assert.equal((await call(app, '/some/page')).headers['content-length'], 18);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the static handler never answers /api, a missing asset or a path outside dist', async () => {
  const dir = distFixture();
  const app = createMiddlewareStack();
  app.use(createStaticHandler(dir));
  assert.equal((await call(app, '/api/nope')).fellThrough, true);
  assert.equal((await call(app, '/assets/missing.js')).fellThrough, true);
  assert.equal((await call(app, '/../gev-hub-secret.txt')).fellThrough, true);
  assert.equal(
    (await call(app, '/%2e%2e/gev-hub-secret.txt')).fellThrough,
    true,
  );
  // URL parsing removes ../ and %2e%2e by itself; an encoded backslash
  // survives it and is a separator on Windows, so only the root check stops it.
  assert.equal((await call(app, '/..%5cgev-hub-secret.txt')).fellThrough, true);
  assert.equal((await call(app, '/x', 'POST')).fellThrough, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the vite stub's loadEnv reads the install folder's .env files", async () => {
  const { loadEnv, defineConfig } = await import(
    `data:text/javascript,${encodeURIComponent(STUB_SOURCES.vite)}`
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-hub-env-'));
  fs.writeFileSync(
    path.join(dir, '.env'),
    [
      '# a comment',
      'GOOGLE_MAPS_API_KEY="quoted value"',
      'export AISSTREAM_API_KEY=abc # trailing note',
      'EMPTY=',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(dir, '.env.production'), 'AISSTREAM_API_KEY=prod');
  const env = loadEnv('production', dir, '');
  assert.equal(env.GOOGLE_MAPS_API_KEY, 'quoted value');
  assert.equal(env.AISSTREAM_API_KEY, 'prod', 'the mode file wins, like Vite');
  assert.equal(env.EMPTY, '');
  assert.deepEqual(loadEnv('production', dir), {}, 'default prefix is VITE_');
  assert.deepEqual(defineConfig({ a: 1 }), { a: 1 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('plugins run pre, then normal, then post; post hooks come after dist', async () => {
  const dir = distFixture();
  const order = [];
  const plugin = (name, enforce, withPost = false) => ({
    name,
    enforce,
    configurePreviewServer(server) {
      order.push(name);
      server.middlewares.use(`/api/${name}`, (_req, res) => res.end(name));
      if (withPost)
        return () =>
          server.middlewares.use((_req, res) => res.end(`post-${name}`));
      return undefined;
    },
  });
  const config = {
    preview: { headers: { 'X-Frame-Test': 'kept' } },
    plugins: [
      plugin('normal', undefined, true),
      [plugin('post', 'post')],
      plugin('pre', 'pre'),
      { name: 'build-only' },
    ],
  };
  const { middlewares } = await createHubServer(config, { distDir: dir });
  assert.deepEqual(order, ['pre', 'normal', 'post']);
  assert.equal((await call(middlewares, '/api/pre')).body, 'pre');
  const page = await call(middlewares, '/');
  assert.equal(
    page.headers['x-frame-test'],
    'kept',
    'preview headers on every response',
  );
  assert.equal(
    page.headers['content-length'],
    18,
    'dist answers before the post hook',
  );
  assert.equal((await call(middlewares, '/api/unknown')).body, 'post-normal');
  fs.rmSync(dir, { recursive: true, force: true });
});
