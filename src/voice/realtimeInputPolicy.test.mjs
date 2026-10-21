import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isVoiceTurnedOffByPage,
  shouldHandlePushToTalkKeyDown,
} from './realtimeInputPolicy.js';

function pageWith(gevVoice) {
  const documentElement = { dataset: gevVoice ? { gevVoice } : {} };
  const doc = { documentElement };
  const body = { ownerDocument: doc, closest: () => null, tagName: 'BODY' };
  return { doc, body };
}

const space = (target) => ({ code: 'Space', key: ' ', target });

test('a page that turned voice off makes holding Space do nothing', () => {
  const { body, doc } = pageWith('off');
  assert.equal(isVoiceTurnedOffByPage(body), true);
  assert.equal(isVoiceTurnedOffByPage(doc), true);
  assert.equal(shouldHandlePushToTalkKeyDown(space(body)), false);
});

test('without the switch, Space on the page still reaches voice', () => {
  const { body } = pageWith(null);
  assert.equal(isVoiceTurnedOffByPage(body), false);
  assert.equal(isVoiceTurnedOffByPage(null), false);
  assert.equal(shouldHandlePushToTalkKeyDown(space(body)), true);
});
