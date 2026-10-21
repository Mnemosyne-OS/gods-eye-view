/**
 * The response headers of the Mnemosyne OS cartridge server (vite.mnemo.config.js).
 *
 * God's Eye View's own server refuses every frame (`X-Frame-Options: DENY`,
 * `frame-ancestors 'none'`), and its embed mode (`?embed=1`) both opens framing
 * and hides the HUD — a Mnemosyne window wants the whole console. So the
 * cartridge server, and only it, drops the two framing headers:
 *
 * - the window that frames it is Electron's renderer, served from `file://`
 *   once installed (origin « null »), which no frame-ancestors source can name;
 * - the server binds 127.0.0.1 only (`dev:cartridge`), so no other machine
 *   reaches it.
 *
 * It also admits `http:` images, media and connections: some webcam feeds the
 * cartridge shows are plain http. Every other directive stays upstream's.
 * build/vite.js is left exactly as upstream ships it.
 */

/** Directives that gain `http:` (after their `https:` source). */
const HTTP_DIRECTIVES = new Set(['img-src', 'media-src', 'connect-src']);

/** Upstream's CSP for a Mnemosyne window: no framing rule, plain-http media. */
export function hostCsp(csp) {
  return String(csp ?? '')
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .filter((d) => !/^frame-ancestors\b/i.test(d))
    .map((d) => {
      const [name, ...sources] = d.split(/\s+/);
      if (!HTTP_DIRECTIVES.has(name) || sources.includes('http:')) return d;
      return [name, ...sources, 'http:'].join(' ');
    })
    .join('; ');
}

/** Upstream's response headers for a Mnemosyne window. */
export function hostHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const key = name.toLowerCase();
    if (key === 'x-frame-options') continue;
    out[name] = key === 'content-security-policy' ? hostCsp(value) : value;
  }
  return out;
}

/** Whether a request is for the HTML document (the page a window frames). */
export function isDocumentRequest(url) {
  let path;
  try {
    path = new URL(url || '/', 'http://localhost').pathname;
  } catch (err) {
    console.warn('[gods-eye-view] unreadable request url:', err);
    return false;
  }
  return path === '/' || path.endsWith('.html');
}
