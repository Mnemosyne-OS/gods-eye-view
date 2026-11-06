import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { CATALOG_SOURCE_CONTRACTS } from '../app/sourceComposition.js';
import { LayerLifecycle } from '../data/lifecycle.js';
import { LAYER_STATE_REGISTRY } from '../data/layerState.js';
import { PHRASES, phrase } from './bridgeModel.js';
import {
  HUB_API_LAYER_IDS,
  createHubApiLayerGuard,
  hubApiAvailability,
  installHubApiLayerGate,
} from './hubApiLayerGate.js';

/** A layer module with the lifecycle God's Eye View calls, counting enables. */
function fakeLayer(id) {
  const calls = { enable: 0 };
  return {
    calls,
    module: {
      id,
      name: id,
      init: async () => true,
      enable: async () => {
        calls.enable += 1;
        return true;
      },
      update: async () => true,
      disable: async () => true,
      destroy: async () => true,
      getStats: () => ({}),
    },
  };
}

/** A real LayerLifecycle subclass, so each test installs on a fresh prototype. */
function managerWith(state, ...layers) {
  class Lifecycle extends LayerLifecycle {}
  const installed = installHubApiLayerGate(Lifecycle, {
    isHub: () => state.hub,
    reason: () => phrase('hubNoServer', state.lang || 'en'),
  });
  const manager = new Lifecycle({});
  for (const layer of layers) manager.register(layer.module);
  manager.finalizeRegistrations(
    layers.map((l) => ({ id: l.module.id, disposition: 'enabled-only' })),
  );
  const blocked = [];
  manager.subscribe?.((change) => {
    if (change?.type === 'visibility-blocked') blocked.push(change.reason);
  });
  return { manager, blocked, installed };
}

const rowStats = (manager, id) =>
  manager.getAll().find((row) => row.id === id)?.stats;

test('in a Hub install the weather radar is greyed with the sentence and its turn-on refused', async () => {
  const radar = fakeLayer('weather-radar');
  const { manager, blocked, installed } = managerWith(
    { hub: true, lang: 'fr' },
    radar,
  );
  assert.deepEqual(installed, { availability: true, guard: true });
  const stats = rowStats(manager, 'weather-radar');
  assert.equal(stats.sourceUnavailable, true, 'the row reads unavailable');
  assert.equal(stats.error, PHRASES.hubNoServer.fr);
  await manager.setEnabled('weather-radar', true, { origin: 'user' });
  assert.equal(manager.isEnabled('weather-radar'), false);
  assert.equal(radar.calls.enable, 0, 'the layer never fetched /api');
  assert.deepEqual(blocked, [PHRASES.hubNoServer.fr]);
});

test('outside a Hub install the same layer turns on as before', async () => {
  const radar = fakeLayer('weather-radar');
  const { manager, blocked } = managerWith({ hub: false }, radar);
  assert.notEqual(rowStats(manager, 'weather-radar').sourceUnavailable, true);
  await manager.setEnabled('weather-radar', true, { origin: 'user' });
  assert.equal(manager.isEnabled('weather-radar'), true);
  assert.equal(radar.calls.enable, 1);
  assert.deepEqual(blocked, []);
});

test('in a Hub install a layer that needs no server turns on', async () => {
  const quakes = fakeLayer('earthquakes');
  const { manager, blocked } = managerWith({ hub: true }, quakes);
  assert.notEqual(rowStats(manager, 'earthquakes').sourceUnavailable, true);
  await manager.setEnabled('earthquakes', true, { origin: 'user' });
  assert.equal(manager.isEnabled('earthquakes'), true);
  assert.deepEqual(blocked, []);
});

test('the guard alone refuses every listed layer in a Hub install, never a turn-off', () => {
  for (const lang of ['en', 'fr', 'es']) {
    const guard = createHubApiLayerGuard({
      isHub: () => true,
      reason: () => phrase('hubNoServer', lang),
    });
    for (const layerId of HUB_API_LAYER_IDS) {
      assert.equal(
        guard({ layerId, enabled: true }),
        PHRASES.hubNoServer[lang],
        `${layerId} ${lang}`,
      );
      assert.equal(guard({ layerId, enabled: false }), null, layerId);
    }
    assert.equal(guard({ layerId: 'earthquakes', enabled: true }), null);
  }
  const offHub = createHubApiLayerGuard({
    isHub: () => false,
    reason: () => 'x',
  });
  assert.equal(offHub({ layerId: 'flights', enabled: true }), null);
  assert.equal(
    hubApiAvailability('flights', { isHub: () => false, reason: () => 'x' }),
    null,
  );
});

test('every listed id is a real catalog layer, so a typo cannot exempt one', () => {
  const known = new Set([
    ...LAYER_STATE_REGISTRY.map((entry) => entry.id),
    ...Object.values(CATALOG_SOURCE_CONTRACTS).flatMap((c) => c.layers),
  ]);
  const catalogSource = readFileSync(
    new URL('../app/constructCatalog.js', import.meta.url),
    'utf8',
  );
  for (const id of HUB_API_LAYER_IDS) {
    assert.ok(
      known.has(id) || catalogSource.includes(`id: '${id}'`),
      `${id} is not a God's Eye View layer`,
    );
  }
  assert.equal(new Set(HUB_API_LAYER_IDS).size, HUB_API_LAYER_IDS.length);
});

test('the shipped LayerLifecycle still has the seams the gate rides on', () => {
  const proto = LayerLifecycle.prototype;
  assert.equal(typeof proto._sourceAvailability, 'function');
  assert.equal(typeof proto.addVisibilityGuard, 'function');
  assert.equal(typeof proto.finalizeRegistrations, 'function');
});
