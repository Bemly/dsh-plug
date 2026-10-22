// Daily npm -> index.json version sync for the dsh-plug market source.
// Usage: node scripts/sync-versions.mjs [--check]
//   --check: dry run, exits 1 when changes would be made.
// Policy: only add STABLE exact-SemVer versions NEWER than the newest
// version already listed (skips 0.0.0-stage placeholders and prereleases);
// never removes versions.
import { readFileSync, writeFileSync } from 'node:fs';

const INDEX = new URL('../index.json', import.meta.url);
const CHECK = process.argv.includes('--check');
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/u;

function parts(ver) {
  const m = SEMVER.exec(ver);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function greater(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

const idx = JSON.parse(readFileSync(INDEX, 'utf8'));
const added = [];
for (const p of idx.plugins) {
  const src = p.versions?.[0]?.source;
  if (!src || src.type !== 'npm' || src.registry) continue;
  const url = `https://registry.npmjs.org/${p.name.replace('/', '%2f')}`;
  const pack = await (await fetch(url)).json();
  if (!pack.versions || !pack.time) throw new Error(`${p.name}: bad packument`);
  const have = new Set(p.versions.map((v) => v.version));
  let max = [0, 0, 0];
  for (const v of have) {
    const q = parts(v);
    if (q && greater(q, max)) max = q;
  }
  for (const [ver, iso] of Object.entries(pack.time)) {
    if (ver === 'created' || ver === 'modified' || have.has(ver)) continue;
    const m = SEMVER.exec(ver);
    if (!m || m[4] !== undefined || ver.includes('stage')) continue;
    const q = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!greater(q, max)) continue;
    const ts = Math.floor(new Date(iso).getTime() / 1000);
    if (!Number.isInteger(ts) || ts < 0) continue;
    p.versions.push({ version: ver, publishTimestamp: ts, source: { ...src }, engines: {} });
    added.push(`${p.name}@${ver}`);
    have.add(ver);
    max = q;
  }
  p.versions.sort((a, b) => b.publishTimestamp - a.publishTimestamp);
}
if (added.length === 0) {
  console.log('up to date');
} else {
  if (!CHECK) writeFileSync(INDEX, JSON.stringify(idx));
  console.log((CHECK ? 'would add: ' : 'added: ') + added.join(', '));
}
process.exitCode = CHECK && added.length > 0 ? 1 : 0;
