// The Mnemosyne OS cartridge server (`npm run dev:cartridge`): upstream's
// standalone config with the headers a Mnemosyne window needs (src/mnemo/hostFraming.js).
import { defineConfig } from 'vite';
import standalone from './server/standalone/vite.config.js';
import { hostHeaders, isDocumentRequest } from './src/mnemo/hostFraming.js';

/**
 * The page is always sent whole. Vite answers a known ETag with 304, and on a
 * 304 Chromium keeps the headers it CACHED: a window that once got upstream's
 * `X-Frame-Options: DENY` stayed blocked (ERR_BLOCKED_BY_RESPONSE) after the
 * server stopped sending it, because the page itself had not changed
 * (2026-10-21). Only the HTML document; scripts and assets keep their 304s.
 */
function freshDocumentHeaders() {
  const install = (server) => {
    server.middlewares.use((req, _res, next) => {
      if (isDocumentRequest(req.url)) {
        delete req.headers['if-none-match'];
        delete req.headers['if-modified-since'];
      }
      next();
    });
  };
  return { name: 'mnemo-fresh-document-headers', configureServer: install, configurePreviewServer: install };
}

export default defineConfig(async (env) => {
  const config = await (typeof standalone === 'function' ? standalone(env) : standalone);
  return {
    ...config,
    plugins: [freshDocumentHeaders(), ...(config.plugins ?? [])],
    server: { ...config.server, headers: hostHeaders(config.server?.headers) },
    preview: { ...config.preview, headers: hostHeaders(config.preview?.headers) },
  };
});
