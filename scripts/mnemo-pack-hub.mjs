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
 * 5. Writes cartridge.tgz and prints its sha256.
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
    for (const route of ['/', '/api/weather/manifest?product=radar']) {
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
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    metafile: true,
    write: false,
    logLevel: 'error',
  });
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
  const out = path.join(outDir, 'cartridge.tgz');
  run(TAR, ['-czf', out, '-C', stage, '.']);
  const sha256 = createHash('sha256')
    .update(fs.readFileSync(out))
    .digest('hex');
  fs.rmSync(stage, { recursive: true, force: true });
  console.log(
    `[pack-hub] version ${manifest.version}, HEAD ${head.slice(0, 8)}`,
  );
  console.log(`[pack-hub] file    ${out} (${fs.statSync(out).size} bytes)`);
  console.log(`[pack-hub] sha256  ${sha256}`);
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
