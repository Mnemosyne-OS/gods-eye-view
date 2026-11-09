import assert from 'node:assert/strict';
import test from 'node:test';
import {
  installManifest,
  keptByServer,
  serverFileSet,
  serverPackages,
  staticManifest,
} from '../../scripts/mnemo-pack-hub.mjs';

const SOURCES = {
  'server/mnemo/hubServer.mjs': "await import('../../vite.mnemo.config.js');",
  'server/providers/cctv/catalog.js':
    "const dir = new URL('../../../src/data/local_data/cctv_ground_heights/', import.meta.url);",
  'src/data/heights.js':
    "fetchLocal('local_data/natural_earth/countries.json');",
  'src/tools/table.js':
    "const rows = new URL('./rows.json', import.meta.url); const bad = new URL(`${x}.json`, import.meta.url);",
};

const metafile = {
  inputs: {
    ...Object.fromEntries(
      Object.keys(SOURCES).map((k) => [k, { imports: [] }]),
    ),
    'node_modules/pbf/index.js': { imports: [] },
  },
};

test('the server keeps its modules and the data they name, nothing from node_modules', () => {
  const keep = serverFileSet(metafile, (rel) => SOURCES[rel]);
  assert.deepEqual([...keep.files].sort(), Object.keys(SOURCES).sort());
  assert.ok(keep.dirs.has('src/data/local_data/cctv_ground_heights'));
  assert.ok(keep.dirs.has('src/data/local_data/natural_earth'));
  assert.ok(
    keep.dirs.has('src/tools/rows.json'),
    'a sibling file named with new URL',
  );
  assert.ok(
    ![...keep.dirs].some((d) => d.includes('${')),
    'a computed URL is not guessed',
  );
});

test('a file is kept when listed or inside a kept folder, never by a shared prefix', () => {
  const keep = {
    files: new Set(['src/a.js']),
    dirs: new Set(['src/data/local_data/sky']),
  };
  assert.equal(keptByServer('src/a.js', keep), true);
  assert.equal(keptByServer('src/data/local_data/sky/stars.json', keep), true);
  assert.equal(keptByServer('src/data/local_data/skyline/x.json', keep), false);
  assert.equal(keptByServer('src/b.js', keep), false);
});

test('an unreadable module is still kept, its data search is skipped', () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const keep = serverFileSet(
      { inputs: { 'src/x.js': { imports: [] } } },
      () => {
        throw new Error('gone');
      },
    );
    assert.ok(keep.files.has('src/x.js'));
  } finally {
    console.warn = warn;
  }
});

test('the install manifest serves index.html, declares the server, its port and server:run', () => {
  const out = installManifest({
    entrypoints: { renderer: 'http://localhost:5239/index.html' },
    permissions: ['vault:read'],
  });
  assert.deepEqual(out.entrypoints, {
    renderer: 'index.html',
    server: 'server/mnemo/hubServer.mjs',
    serverPort: 5239,
  });
  assert.deepEqual(out.permissions, ['vault:read', 'server:run']);
});

test('server packages skip node builtins and the three stubbed build packages', () => {
  const names = serverPackages({
    inputs: {
      a: {
        imports: [
          { path: 'node:fs', external: true },
          { path: 'vite', external: true },
          { path: '@vitejs/plugin-vue', external: true },
          { path: '@mapbox/vector-tile/lib/x.js', external: true },
          { path: 'pbf', external: true },
          { path: './local.js', external: false },
        ],
      },
    },
  });
  // ws is loaded with createRequire, out of esbuild's sight: always listed.
  assert.deepEqual(names, ['@mapbox/vector-tile', 'pbf', 'ws']);
});

test('the light package for an older host declares no server and no server:run', () => {
  const full = installManifest({
    version: '0.4.0',
    entrypoints: { renderer: 'http://localhost:5239/index.html' },
    permissions: ['vault:read'],
  });
  const light = staticManifest(full);
  assert.deepEqual(light.entrypoints, { renderer: 'index.html' });
  assert.deepEqual(light.permissions, ['vault:read']);
  assert.equal(light.version, '0.4.0');
});
