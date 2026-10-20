import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const manifest = JSON.parse(
  readFileSync(new URL('../../mnemo-plugin.json', import.meta.url), 'utf8'),
);
const bridge = readFileSync(
  new URL('./mnemoBridge.js', import.meta.url),
  'utf8',
);

/** The handler names inside registerMnemoAgentDoor, read from the source. */
function handlerIds() {
  const start = bridge.indexOf('function registerMnemoAgentDoor()');
  const end = bridge.indexOf('\nfunction ', start + 1);
  assert.ok(start > 0 && end > start, 'registerMnemoAgentDoor not found');
  return [...bridge.slice(start, end).matchAll(/^ {2,8}(\w+): async \(/gm)]
    .map((m) => m[1])
    .sort();
}

test('every declared agent action has a handler, and every handler is declared', () => {
  const declared = manifest.agentActions.map((a) => a.id).sort();
  assert.deepEqual(handlerIds(), declared);
});

test("no action id carries a word another app owns on the orb's shelf", () => {
  // « scene » belongs to Vitrine Studio: controlScene put this globe next to it
  // for « affiche les scènes » in the host's journal bench (2026-10-20).
  for (const a of manifest.agentActions)
    assert.doesNotMatch(a.id, /scene/i, a.id);
});
