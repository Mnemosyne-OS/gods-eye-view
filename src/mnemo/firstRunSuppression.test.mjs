import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  rememberFirstRunSessionDismissed,
  shouldShowFirstRun,
} from '../firstRunExperience.js';

const bridgeSource = fs.readFileSync(
  new URL('./mnemoBridge.js', import.meta.url),
  'utf8',
);

function memoryStorage() {
  const items = new Map();
  return {
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => items.set(key, String(value)),
    removeItem: (key) => items.delete(key),
  };
}

test('the bridge hides the welcome card through the writer God’s Eye View reads', () => {
  // A value written by hand ('1') was never the one the launcher reads, so the
  // welcome card covered the globe on every new session (2026-11-24).
  assert.match(
    bridgeSource,
    /rememberFirstRunSessionDismissed\(sessionStorage\)/,
  );
  assert.doesNotMatch(bridgeSource, /gev:first-run-mission-session:v1/);
});

test('a session marked by that writer opens on the globe, not the welcome card', () => {
  const session = memoryStorage();
  const local = memoryStorage();
  const location = { search: '' };
  assert.equal(
    shouldShowFirstRun({
      storage: local,
      sessionStorageRef: session,
      location,
    }),
    true,
  );
  rememberFirstRunSessionDismissed(session);
  assert.equal(
    shouldShowFirstRun({
      storage: local,
      sessionStorageRef: session,
      location,
    }),
    false,
  );
});
