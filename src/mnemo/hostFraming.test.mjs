import assert from 'node:assert/strict';
import test from 'node:test';
import { BROWSER_HEADERS } from '../../build/vite.js';
import { hostCsp, hostHeaders } from './hostFraming.js';

test('a Mnemosyne window may frame the cartridge server, nothing else is loosened', () => {
  const headers = hostHeaders(BROWSER_HEADERS);
  assert.equal(headers['X-Frame-Options'], undefined);
  const csp = headers['Content-Security-Policy'];
  assert.doesNotMatch(csp, /frame-ancestors/);
  // Every other upstream directive and header is kept as is.
  assert.match(csp, /script-src 'self' 'unsafe-eval' blob:/);
  assert.match(csp, /object-src 'none'/);
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
});

test('plain-http media is admitted, once, and only where webcams need it', () => {
  const csp = hostCsp("img-src 'self' https:; media-src 'self' https: http:; script-src 'self'");
  assert.equal(csp, "img-src 'self' https: http:; media-src 'self' https: http:; script-src 'self'");
});

test('upstream still refuses every frame on its own server', () => {
  assert.equal(BROWSER_HEADERS['X-Frame-Options'], 'DENY');
  assert.match(BROWSER_HEADERS['Content-Security-Policy'], /frame-ancestors 'none'/);
});
