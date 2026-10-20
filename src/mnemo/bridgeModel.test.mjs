import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PHRASES,
  UI_TEXT,
  uiText,
  cameraMoved,
  checkedResult,
  compactStatus,
  phrase,
} from './bridgeModel.js';

test("a refused God's Eye View answer is thrown, never passed on as done", () => {
  assert.throws(
    () =>
      checkedResult(
        { ok: false, error: 'needs a place' },
        'select_nearest_aircraft',
      ),
    /needs a place/,
  );
  assert.throws(
    () => checkedResult({ ok: false, say: "Couldn't get there." }, 'x'),
    /Couldn't get there/,
  );
  assert.throws(
    () => checkedResult({ ok: false }, 'fly_to_location'),
    /fly_to_location failed/,
  );
  const done = { ok: true, say: 'Flying to Tokyo.' };
  assert.equal(checkedResult(done, 'fly_to_location'), done);
  // No `ok` field is not a refusal: some tools answer a plain value.
  assert.equal(checkedResult({ style: 'thermal' }, 'x').style, 'thermal');
  assert.equal(checkedResult(null, 'x'), null);
});

test("every bridge sentence exists in the host's 7 languages, and an unknown language falls back to English", () => {
  for (const [key, table] of Object.entries(PHRASES)) {
    for (const lang of ['en', 'fr', 'es', 'de', 'pt', 'ru', 'zh'])
      assert.ok(table[lang], `${key}.${lang}`);
    assert.equal(phrase(key, 'fr-FR'), table.fr);
    assert.equal(phrase(key, 'ja'), table.en);
    assert.equal(phrase(key, undefined), table.en);
  }
});

test('the camera moved only past a metre, and an unknown reading never counts as moved', () => {
  assert.equal(
    cameraMoved({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0.5 }),
    false,
  );
  assert.equal(cameraMoved({ x: 0, y: 0, z: 0 }, { x: 0, y: 2, z: 0 }), true);
  assert.equal(cameraMoved(null, { x: 9, y: 9, z: 9 }), false);
  assert.equal(cameraMoved({ x: 9, y: 9, z: 9 }, null), false);
});

test('the short status keeps what a person asks about and says when the window is not seen', () => {
  const viewState = {
    say: 'Camera 600 m up.',
    camera: { latitude: 1, longitude: 2, heightM: 3 },
    style: 'normal',
    context: { mode: 'off' },
    cockpit: { active: false },
    tracked: [],
    scenePlayback: { running: false },
    layers: [
      {
        id: 'flights',
        enabled: true,
        count: 9015,
        feedState: 'nominal',
        source: 'OpenSky',
        lastUpdate: 1,
      },
      { id: 'satellites', enabled: false, count: 0 },
      {
        id: 'local-firms',
        enabled: true,
        count: 0,
        feedState: 'unavailable',
        error: 'needs a key',
      },
    ],
    feedProvenance: { huge: 'x'.repeat(5000) },
  };
  const s = compactStatus(
    viewState,
    { count: 12, selected: null },
    { submarineCablesCcByNcSa30: false },
    0,
  );
  assert.deepEqual(s.layersOn, [
    { id: 'flights', count: 9015, feedState: 'nominal' },
    {
      id: 'local-firms',
      count: 0,
      feedState: 'unavailable',
      error: 'needs a key',
    },
  ]);
  assert.deepEqual(s.layersOff, ['satellites']);
  assert.equal(s.onScreen, false);
  // Never `say`: the orb would read God's Eye View's English sentence aloud.
  assert.equal('say' in s, false);
  assert.equal(s.summary, 'Camera 600 m up.');
  assert.equal(s.framesPerSecond, 0);
  assert.ok(JSON.stringify(s).length < 1500, 'the short status stays short');
  // Not measured is not « off screen ».
  assert.equal(compactStatus(viewState, {}, {}, null).onScreen, null);
});

test('every screen text of the bridge exists in en, fr and es, and another language reads English', () => {
  for (const [key, row] of Object.entries(UI_TEXT)) {
    for (const lang of ['en', 'fr', 'es'])
      assert.ok(row[lang], `${key}.${lang}`);
    assert.equal(uiText(key, 'es-MX'), row.es);
    assert.equal(uiText(key, 'de'), row.en);
  }
  // An unknown key shows itself rather than an empty button.
  assert.equal(uiText('noSuchKey', 'fr'), 'noSuchKey');
});
