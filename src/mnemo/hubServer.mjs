/**
 * God's Eye View's own `/api` server for a Mnemosyne OS Hub install.
 *
 * Upstream serves its whole API from Vite plugins (`configureServer` and
 * `configurePreviewServer`). A Hub install has no Vite and no dev
 * dependencies, so this file runs upstream's exact plugin list the way
 * `vite preview` does: each plugin's `configurePreviewServer` gets a
 * connect-style `middlewares` stack and the real `httpServer`, then the built
 * `dist/` is served, then the plugins' post hooks. New upstream routes come
 * along with each merge, nothing is listed here.
 *
 * The three build-time packages the config imports (`vite`,
 * `vite-plugin-cesium`, `@vitejs/plugin-vue`) are answered by stubs through
 * Node's `module.registerHooks`: the server never builds anything. The stub
 * `loadEnv` reads `<root>/.env*` like Vite, so a person's own keys in the
 * install folder's `.env` reach the providers.
 *
 * Run: `node src/mnemo/hubServer.mjs --port 5239` (the host runs it with its
 * own Electron binary and ELECTRON_RUN_AS_NODE=1). Binds 127.0.0.1 only and
 * prints one ready line the host waits for.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

export const READY_PREFIX = '[gev-hub-server] ready on ';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DIST = path.join(ROOT, 'dist');

/** The stub module source for each build-time package the config imports. */
export const STUB_SOURCES = Object.freeze({
  vite: [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    'export const defineConfig = (config) => config;',
    'export function loadEnv(mode, root, prefix = "VITE_") {',
    '  const out = {};',
    '  const prefixes = Array.isArray(prefix) ? prefix : [prefix];',
    '  for (const name of [".env", ".env.local", `.env.${mode}`, `.env.${mode}.local`]) {',
    '    let text;',
    '    try { text = fs.readFileSync(path.join(root, name), "utf8"); } catch { continue; }',
    '    for (const line of text.split(/\\r?\\n/)) {',
    '      const m = /^\\s*(?:export\\s+)?([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*(.*)?\\s*$/.exec(line);',
    '      if (!m) continue;',
    '      let value = (m[2] ?? "").trim();',
    '      if (/^(["\'`])[\\s\\S]*\\1$/.test(value)) value = value.slice(1, -1);',
    '      else value = value.replace(/\\s+#.*$/, "");',
    '      if (prefixes.some((p) => m[1].startsWith(p))) out[m[1]] = value;',
    '    }',
    '  }',
    '  return out;',
    '}',
  ].join('\n'),
  'vite-plugin-cesium': 'export default () => ({ name: "cesium-stub" });',
  '@vitejs/plugin-vue': 'export default () => ({ name: "vue-stub" });',
});

/** Answers the build-time packages with their stubs; everything else resolves as usual. */
export function installBuildStubs() {
  return registerHooks({
    resolve(specifier, context, nextResolve) {
      const source = STUB_SOURCES[specifier];
      if (source === undefined) return nextResolve(specifier, context);
      return {
        url: `data:text/javascript,${encodeURIComponent(source)}`,
        shortCircuit: true,
      };
    },
  });
}

/**
 * A connect-compatible stack: `use(fn)` or `use('/mount', fn)`. A mounted
 * handler sees `req.url` with the mount stripped (upstream's weather route
 * reads `url.pathname === '/manifest'` under `/api/weather`).
 */
export function createMiddlewareStack() {
  const stack = [];
  function app(req, res, done) {
    const originalUrl = req.url;
    if (req.originalUrl === undefined) req.originalUrl = originalUrl;
    let index = 0;
    function next(err) {
      req.url = originalUrl;
      const layer = stack[index++];
      if (!layer) return done(err);
      const pathname = originalUrl.split('?')[0].toLowerCase();
      if (layer.route) {
        const boundary = pathname[layer.route.length];
        if (
          !pathname.startsWith(layer.route) ||
          (boundary !== undefined && boundary !== '/' && boundary !== '.')
        )
          return next(err);
        const rest = originalUrl.slice(layer.route.length);
        req.url = rest.startsWith('/') ? rest : `/${rest}`;
      }
      try {
        if (err) {
          if (layer.fn.length === 4) return layer.fn(err, req, res, next);
          return next(err);
        }
        if (layer.fn.length < 4) return layer.fn(req, res, next);
        return next();
      } catch (caught) {
        return next(caught);
      }
    }
    next();
  }
  app.use = (route, fn) => {
    if (typeof route === 'function') {
      fn = route;
      route = '';
    }
    let mount = String(route || '').toLowerCase();
    if (mount === '/') mount = '';
    if (mount.endsWith('/')) mount = mount.slice(0, -1);
    stack.push({ route: mount, fn });
    return app;
  };
  return app;
}

const CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.pbf': 'application/x-protobuf',
});

/**
 * Serves `dist/` the way `vite preview` does for a single-page app: the file
 * when it exists, `index.html` for an extensionless page path, the next
 * handler otherwise (so `/api/*` 404s stay upstream's JSON).
 */
export function createStaticHandler(distDir) {
  const root = path.resolve(distDir);
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      return next();
    }
    if (pathname.startsWith('/api/') || pathname === '/api') return next();
    let file = path.resolve(root, `.${pathname}`);
    if (file !== root && !file.startsWith(root + path.sep)) return next();
    let stat = statOrNull(file);
    if (stat?.isDirectory()) {
      file = path.join(file, 'index.html');
      stat = statOrNull(file);
    }
    if (!stat && !path.extname(pathname)) {
      file = path.join(root, 'index.html');
      stat = statOrNull(file);
    }
    if (!stat?.isFile()) return next();
    res.statusCode = 200;
    res.setHeader(
      'Content-Type',
      CONTENT_TYPES[path.extname(file).toLowerCase()] ||
        'application/octet-stream',
    );
    res.setHeader('Content-Length', stat.size);
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(file);
    stream.on('error', (err) => {
      console.error('[gev-hub-server] read failed:', file, err);
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    });
    stream.pipe(res);
  };
}

function statOrNull(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

/** Every response carries the preview headers (framing, CSP), like `vite preview`. */
function headersHandler(headers) {
  return (_req, res, next) => {
    for (const [name, value] of Object.entries(headers || {}))
      if (value !== undefined) res.setHeader(name, value);
    next();
  };
}

/**
 * Builds the server from a resolved config: headers, every plugin's
 * `configurePreviewServer`, `dist/`, then the post hooks, then a 404.
 */
export async function createHubServer(config, { distDir = DIST } = {}) {
  const middlewares = createMiddlewareStack();
  const httpServer = http.createServer((req, res) =>
    middlewares(req, res, (err) => {
      if (err) {
        console.error('[gev-hub-server] request failed:', req.url, err);
        res.statusCode = 500;
      } else {
        res.statusCode = 404;
      }
      res.end();
    }),
  );
  const server = { middlewares, httpServer, config };
  middlewares.use(headersHandler(config.preview?.headers));
  const plugins = (config.plugins || []).flat(Infinity).filter(Boolean);
  const ordered = [
    ...plugins.filter((p) => p.enforce === 'pre'),
    ...plugins.filter((p) => p.enforce !== 'pre' && p.enforce !== 'post'),
    ...plugins.filter((p) => p.enforce === 'post'),
  ];
  const postHooks = [];
  for (const plugin of ordered) {
    const hook = plugin.configurePreviewServer;
    const fn = typeof hook === 'function' ? hook : hook?.handler;
    if (typeof fn !== 'function') continue;
    const post = await fn.call(plugin, server);
    if (typeof post === 'function') postHooks.push(post);
  }
  middlewares.use(createStaticHandler(distDir));
  for (const post of postHooks) await post();
  return server;
}

function portFromArgv(argv) {
  const at = argv.indexOf('--port');
  const port = Number.parseInt(at >= 0 ? argv[at + 1] : '', 10);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : 5239;
}

async function main() {
  process.env.NODE_ENV ??= 'production';
  installBuildStubs();
  const port = portFromArgv(process.argv);
  const { default: mnemoConfig } = await import(
    new URL('../../vite.mnemo.config.js', import.meta.url).href
  );
  const env = { command: 'serve', mode: 'production', isPreview: true };
  const config =
    typeof mnemoConfig === 'function' ? await mnemoConfig(env) : mnemoConfig;
  const { httpServer } = await createHubServer(config);
  httpServer.on('error', (err) => {
    console.error('[gev-hub-server] cannot listen:', err);
    process.exit(1);
  });
  httpServer.listen(port, '127.0.0.1', () => {
    console.log(`${READY_PREFIX}http://127.0.0.1:${port}`);
  });
  const stop = () => httpServer.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  // The host keeps a pipe on stdin; when the host goes away, so does this server.
  if (!process.stdin.isTTY) {
    process.stdin.on('end', stop);
    process.stdin.resume();
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((err) => {
    console.error('[gev-hub-server] failed to start:', err);
    process.exit(1);
  });
}
