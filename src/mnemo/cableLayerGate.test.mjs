import assert from 'node:assert/strict';
import test from 'node:test';
import { LayerLifecycle } from '../data/lifecycle.js';
import {
  CABLES_LAYER_ID,
  createCableLicenceGuard,
  installCableLicenceGuard,
} from './cableLayerGate.js';

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
function managerWith(guardState, ...layers) {
  class Lifecycle extends LayerLifecycle {}
  const refused = [];
  installCableLicenceGuard(
    Lifecycle,
    createCableLicenceGuard({
      isAccepted: () => guardState.accepted,
      onRefused: (change) => refused.push(change.origin),
      reason: () => 'licence window open',
    }),
  );
  const manager = new Lifecycle({});
  for (const layer of layers) manager.register(layer.module);
  manager.finalizeRegistrations(
    layers.map((l) => ({ id: l.module.id, disposition: 'enabled-only' })),
  );
  return { manager, refused };
}

test('the layer panel cannot turn the cables on before the licence is accepted', async () => {
  const cables = fakeLayer(CABLES_LAYER_ID);
  const { manager, refused } = managerWith({ accepted: false }, cables);
  await manager.setEnabled(CABLES_LAYER_ID, true, { origin: 'user' });
  assert.equal(manager.isEnabled(CABLES_LAYER_ID), false);
  assert.equal(cables.calls.enable, 0, 'the cable module never ran');
  assert.deepEqual(refused, ['user'], 'the licence window was asked for');
});

test('once accepted, the cables turn on from any origin', async () => {
  const cables = fakeLayer(CABLES_LAYER_ID);
  const { manager, refused } = managerWith({ accepted: true }, cables);
  await manager.setEnabled(CABLES_LAYER_ID, true, { origin: 'voice' });
  assert.equal(manager.isEnabled(CABLES_LAYER_ID), true);
  assert.equal(cables.calls.enable, 1);
  assert.deepEqual(refused, []);
});

test('other layers and turning the cables off are never refused', async () => {
  const cables = fakeLayer(CABLES_LAYER_ID);
  const dams = fakeLayer('local-dams');
  const state = { accepted: true };
  const { manager, refused } = managerWith(state, cables, dams);
  await manager.setEnabled(CABLES_LAYER_ID, true, { origin: 'user' });
  state.accepted = false; // revoked while on
  await manager.setEnabled(CABLES_LAYER_ID, false, { origin: 'user' });
  await manager.setEnabled('local-dams', true, { origin: 'user' });
  assert.equal(manager.isEnabled(CABLES_LAYER_ID), false);
  assert.equal(manager.isEnabled('local-dams'), true);
  assert.deepEqual(refused, []);
});

test('the shipped LayerLifecycle still has the seam the guard rides on', () => {
  assert.equal(
    typeof LayerLifecycle.prototype.finalizeRegistrations,
    'function',
  );
  assert.equal(typeof LayerLifecycle.prototype.addVisibilityGuard, 'function');
});
