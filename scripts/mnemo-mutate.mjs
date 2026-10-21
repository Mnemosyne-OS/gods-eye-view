// Mnemosyne OS layer: replays mutation files (docs/verifications/159_orb-summon.gev.mutations.json in
// the monorepo) one mutation at a time on this clone (node:test suites). Applies `from` -> `to`
// (exactly one occurrence), runs `node --test <tests>`, prints KILLED / SURVIVED, restores the file
// byte for byte. Run from the clone root: node scripts/mnemo-mutate.mjs <file.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const specs = JSON.parse(readFileSync(process.argv[2], 'utf8'));
let killed = 0, survived = 0, notApplied = 0;
for (const spec of specs) {
  const path = resolve(process.cwd(), spec.file);
  const original = readFileSync(path, 'utf8');
  const n = original.split(spec.from).length - 1;
  if (n !== 1) { console.log(`  NOT APPLIED  ${spec.name} ("from" found ${n} times)`); notApplied++; continue; }
  writeFileSync(path, original.replace(spec.from, spec.to));
  try {
    const run = spawnSync(process.execPath, ['--test', ...spec.tests], { cwd: process.cwd(), encoding: 'utf8' });
    const out = (run.stdout ?? '') + (run.stderr ?? '');
    const failing = out.split('\n').filter((l) => /^\s*not ok\s/.test(l));
    const summary = out.split('\n').filter((l) => /^# (pass|fail) /.test(l)).join(' ');
    const loadError = !/^# pass /m.test(out);
    if (failing.length || run.status !== 0) {
      killed++;
      console.log(`  KILLED${loadError ? ' (by a load error)' : ''}  ${spec.name}  [${summary}]`);
      for (const f of failing) console.log(`      ${f.trim()}`);
    } else {
      survived++;
      console.log(`  SURVIVED     ${spec.name}  [${summary}]`);
    }
  } finally {
    writeFileSync(path, original);
  }
}
console.log(`[verif-gev-mutate] ${specs.length} mutant(s): ${killed} killed, ${survived} survived, ${notApplied} not applied`);
