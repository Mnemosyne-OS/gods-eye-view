#!/usr/bin/env node
/**
 * Packs God's Eye View for the Mnemosyne OS Hub: `cartridge.tgz`, the release
 * asset the host installs.
 *
 *   node scripts/mnemo-pack-hub.mjs [outDir] [--smoke]
 *
 * 1. Exports HEAD with `git archive` (tracked files only: no .env, no
 *    node_modules, no local .git pointer). dist/ must be committed and fresh.
 * 2. Drops what the install never runs: docs, CI, tests.
 * 3. Installs only the npm packages the /api server imports, at the
 *    versions package-lock.json pins. The list is measured with esbuild on
 *    server/mnemo/hubServer.mjs, so a provider upstream adds tomorrow brings
 *    its package along; vite and its two plugins are stubbed at run time.
 * 4. Rewrites the manifest for an install: renderer `index.html` (the host's
 *    mnemo-plugin:// protocol), `entrypoints.server` (run by the host with
 *    its own Electron binary once the person grants `server:run`).
 * 5. Writes cartridge-server.tgz (with the server) and cartridge.tgz (the
 *    light page an older Mnemosyne OS installs), each with its sha256.
 * --keep-stage leaves the staged folder in place (to compare it with another).
 * --smoke starts the staged server on a free port and checks the page and a
 * weather manifest answer before packing.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SERVER_ENTRY = 'server/mnemo/hubServer.mjs';
const STUBBED = new Set(['vite', 'vite-plugin-cesium', '@vitejs/plugin-vue']);
// Windows' own bsdtar reads C:\ paths; Git Bash's tar takes "C:" for a host.
const TAR =
  process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
const DROP_DIRS = [
  'docs',
  '.github',
  'pinokio',
  'tools',
  'changelog.d',
  '.agents',
];

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32' && /^(npm|npx)$/.test(cmd),
    ...opts,
  });
  if (res.status !== 0)
    throw new Error(`${cmd} ${args.join(' ')} exited with ${res.status}`);
  return res;
}

function output(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (res.status !== 0)
    throw new Error(`${cmd} ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout;
}

/** Bare package names the server imports, measured with esbuild. */
export function serverPackages(metafile) {
  const names = new Set();
  for (const input of Object.values(metafile.inputs))
    for (const imp of input.imports)
      if (imp.external && !imp.path.startsWith('node:')) {
        const parts = imp.path.split('/');
        const name = imp.path.startsWith('@')
          ? parts.slice(0, 2).join('/')
          : parts[0];
        if (!STUBBED.has(name)) names.add(name);
      }
  return [...names].sort();
}

/** Folders of runtime code the release keeps only the server's part of. */
export const PRUNED_DIRS = Object.freeze(['src', 'scripts', 'build']);

/**
 * What the server actually loads from the checkout, measured: every module
 * esbuild followed from the entry, every file a kept module names with
 * `new URL('…', import.meta.url)`, and every `local_data/<set>` folder a
 * kept module names. The page needs none of it: dist/ already carries its
 * own copy of what it imports.
 * @param {{ inputs: Record<string, unknown> }} metafile esbuild metafile, paths relative to `root`.
 * @param {(rel: string) => string} readSource reads a kept module's text.
 * @returns {{ files: Set<string>, dirs: Set<string> }} posix paths relative to root.
 */
export function serverFileSet(metafile, readSource) {
  const files = new Set();
  const dirs = new Set();
  for (const rel of Object.keys(metafile.inputs)) {
    if (rel.includes('node_modules/') || rel.startsWith('<')) continue;
    files.add(rel);
    let text;
    try {
      text = readSource(rel);
    } catch (err) {
      console.warn(`[pack-hub] cannot read ${rel} to look for its data:`, err);
      continue;
    }
    for (const m of text.matchAll(/local_data\/([A-Za-z0-9_-]+)/g))
      dirs.add(`src/data/local_data/${m[1]}`);
    for (const m of text.matchAll(
      /new URL\(\s*['"`]([^'"`$]+)['"`]\s*,\s*import\.meta\.url\s*\)/g,
    )) {
      const target = path.posix.normalize(
        path.posix.join(path.posix.dirname(rel), m[1]),
      );
      if (!target.startsWith('..')) dirs.add(target.replace(/\/$/, ''));
    }
  }
  return { files, dirs };
}

/** True when a posix path is a kept file, or sits inside a kept folder. */
export function keptByServer(rel, { files, dirs }) {
  if (files.has(rel)) return true;
  for (const dir of dirs)
    if (rel === dir || rel.startsWith(`${dir}/`)) return true;
  return false;
}

/**
 * The two release assets. A Mnemosyne OS that can run an app's server
 * (doc 201) takes `cartridge-server.tgz`; an older one only knows
 * `cartridge.tgz` and gets the light page, whose /api layers are greyed.
 */
export const SERVER_ASSET = 'cartridge-server.tgz';
export const LIGHT_ASSET = 'cartridge.tgz';
const LIGHT_FILES = Object.freeze([
  'dist',
  'icon.svg',
  'LICENSE',
  'README.md',
  'THIRD_PARTY_NOTICES.md',
  'DATA_SOURCES.md',
]);

/** The light package's manifest: static renderer, no server, no server:run. */
export function staticManifest(manifest) {
  const {
    server: _server,
    serverPort: _port,
    ...entrypoints
  } = manifest.entrypoints ?? {};
  return {
    ...manifest,
    entrypoints: { ...entrypoints, renderer: 'index.html' },
    permissions: (manifest.permissions ?? []).filter((p) => p !== 'server:run'),
  };
}

/** The manifest an install needs: static renderer, declared server. */
export function installManifest(manifest) {
  const permissions = new Set(manifest.permissions ?? []);
  permissions.add('server:run');
  return {
    ...manifest,
    entrypoints: {
      ...(manifest.entrypoints ?? {}),
      renderer: 'index.html',
      server: SERVER_ENTRY,
      // The dev server's port: same origin, same localStorage as a linked copy.
      serverPort: 5239,
    },
    permissions: [...permissions],
  };
}

function walk(dir, visit) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walk(full, visit);
    } else visit(full);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Routes that answer 200 with no key: the page, weather, flights, wind status. */
const SMOKE_ROUTES = Object.freeze([
  '/',
  '/api/weather/manifest?product=radar',
  '/api/flights',
  '/api/wind/status',
]);

async function smoke(stage) {
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [SERVER_ENTRY, '--port', String(port)],
    {
      cwd: stage,
      stdio: ['pipe', 'pipe', 'inherit'],
    },
  );
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('no ready line in 60 s')),
        60_000,
      );
      child.stdout.on('data', (chunk) => {
        process.stdout.write(chunk);
        if (String(chunk).includes('[gev-hub-server] ready on')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once('exit', (code) => reject(new Error(`server exited ${code}`)));
    });
    for (const route of SMOKE_ROUTES) {
      const res = await fetch(`http://127.0.0.1:${port}${route}`, {
        signal: AbortSignal.timeout(30_000),
      });
      console.log(`[pack-hub] smoke ${route} -> ${res.status}`);
      if (!res.ok) throw new Error(`smoke ${route} answered ${res.status}`);
    }
  } finally {
    child.kill();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const outDir = path.resolve(
    args.find((a) => !a.startsWith('--')) ??
      path.join(os.tmpdir(), 'gev-hub-release'),
  );
  const dirty = output('git', ['status', '--porcelain'], { cwd: ROOT }).trim();
  if (dirty) throw new Error(`the checkout has uncommitted changes:\n${dirty}`);
  const head = output('git', ['rev-parse', 'HEAD'], { cwd: ROOT }).trim();

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-hub-stage-'));
  const tarball = path.join(stage, '..', `${path.basename(stage)}.tar`);
  console.log(`[pack-hub] HEAD ${head} -> ${stage}`);
  run('git', ['archive', '--format=tar', '-o', tarball, 'HEAD'], { cwd: ROOT });
  run(TAR, ['-xf', tarball, '-C', stage]);
  fs.rmSync(tarball, { force: true });
  if (!fs.existsSync(path.join(stage, 'dist', 'index.html')))
    throw new Error(
      'dist/index.html is not committed: build and commit dist first',
    );

  for (const dir of DROP_DIRS)
    fs.rmSync(path.join(stage, dir), { recursive: true, force: true });
  walk(stage, (file) => {
    if (/\.test\.(mjs|js)$/.test(file)) fs.rmSync(file);
  });

  const esbuild =
    (await import('esbuild')).default ?? (await import('esbuild'));
  const result = await esbuild.build({
    entryPoints: [path.join(ROOT, SERVER_ENTRY)],
    absWorkingDir: ROOT,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    metafile: true,
    write: false,
    logLevel: 'error',
  });

  // Only what the server loads stays in src/, scripts/ and build/; public/
  // is already copied into dist/ by the build.
  const keep = serverFileSet(result.metafile, (rel) =>
    fs.readFileSync(path.join(ROOT, rel), 'utf8'),
  );
  let pruned = 0;
  for (const top of PRUNED_DIRS) {
    const dir = path.join(stage, top);
    if (!fs.existsSync(dir)) continue;
    walk(dir, (file) => {
      const rel = path.relative(stage, file).split(path.sep).join('/');
      if (!keptByServer(rel, keep)) {
        fs.rmSync(file);
        pruned += 1;
      }
    });
  }
  fs.rmSync(path.join(stage, 'public'), { recursive: true, force: true });
  console.log(
    `[pack-hub] kept ${keep.files.size} server modules and ${keep.dirs.size} data folders, dropped ${pruned} other files`,
  );
  const lock = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'),
  );
  const specs = serverPackages(result.metafile).map((name) => {
    const version = lock.packages?.[`node_modules/${name}`]?.version;
    if (!version)
      throw new Error(
        `${name} is imported by the server but not in package-lock.json`,
      );
    return `${name}@${version}`;
  });
  console.log(`[pack-hub] server packages: ${specs.join(' ')}`);
  const deps = path.join(stage, '.server-deps');
  fs.mkdirSync(deps);
  fs.writeFileSync(path.join(deps, 'package.json'), '{"private":true}\n');
  run(
    'npm',
    [
      'install',
      '--omit=dev',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
      ...specs,
    ],
    { cwd: deps },
  );
  fs.renameSync(
    path.join(deps, 'node_modules'),
    path.join(stage, 'node_modules'),
  );
  fs.rmSync(deps, { recursive: true, force: true });

  const manifestPath = path.join(stage, 'mnemo-plugin.json');
  const manifest = installManifest(
    JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
  );
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  if (args.includes('--smoke')) await smoke(stage);

  fs.mkdirSync(outDir, { recursive: true });
  // The light package an older Mnemosyne OS installs: the page alone, no
  // server declared. Same release, so the same version on both.
  const light = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-hub-light-'));
  for (const name of LIGHT_FILES)
    if (fs.existsSync(path.join(stage, name)))
      fs.cpSync(path.join(stage, name), path.join(light, name), {
        recursive: true,
      });
  fs.writeFileSync(
    path.join(light, 'mnemo-plugin.json'),
    `${JSON.stringify(staticManifest(manifest), null, 2)}
`,
  );
  const packs = [
    [SERVER_ASSET, stage],
    [LIGHT_ASSET, light],
  ];
  console.log(
    `[pack-hub] version ${manifest.version}, HEAD ${head.slice(0, 8)}`,
  );
  for (const [name, dir] of packs) {
    const out = path.join(outDir, name);
    run(TAR, ['-czf', out, '-C', dir, '.']);
    const sha256 = createHash('sha256')
      .update(fs.readFileSync(out))
      .digest('hex');
    console.log(`[pack-hub] file    ${out} (${fs.statSync(out).size} bytes)`);
    console.log(`[pack-hub] sha256  ${sha256}`);
  }
  fs.rmSync(light, { recursive: true, force: true });
  if (args.includes('--keep-stage'))
    console.log(`[pack-hub] stage kept: ${stage}`);
  else fs.rmSync(stage, { recursive: true, force: true });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((err) => {
    console.error('[pack-hub] failed:', err.message);
    process.exit(1);
  });
}
