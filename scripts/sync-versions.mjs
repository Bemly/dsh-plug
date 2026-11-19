// Daily npm -> index.json version sync for the dsh-plug market source.
// Usage: node scripts/sync-versions.mjs [--check]
//   --check: dry run, exits 1 when changes would be made, npm or git.
// Policy: only add STABLE exact-SemVer versions NEWER than the newest stable
// version already listed (skips 0.0.0-stage placeholders and prereleases);
// never removes versions; keeps every version list in descending SemVer
// precedence. git-sourced plugins get their pinned SHA advanced to the branch
// head. A package that cannot be read is skipped with a warning so one bad
// package cannot block the rest of the market.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

const INDEX = new URL('../index.json', import.meta.url);
const CHECK = process.argv.includes('--check');
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/u;

function greater(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

// Full SemVer 2.0 precedence, prereleases included. The index format requires
// versions in descending SemVer precedence, which is *not* publish order: a
// patched 1.1.9 backported after 1.2.0 still sorts below 1.2.0.
function compareVersions(a, b) {
  const pa = SEMVER.exec(a);
  const pb = SEMVER.exec(b);
  if (!pa || !pb) return 0;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d;
  }
  if (pa[4] === undefined || pb[4] === undefined) {
    // A release outranks any prerelease of the same core version.
    return (pa[4] === undefined ? 1 : 0) - (pb[4] === undefined ? 1 : 0);
  }
  const ia = pa[4].split('.');
  const ib = pb[4].split('.');
  for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
    if (ia[i] === undefined) return -1;
    if (ib[i] === undefined) return 1;
    const na = /^\d+$/u.test(ia[i]);
    const nb = /^\d+$/u.test(ib[i]);
    if (na && nb) {
      const d = Number(ia[i]) - Number(ib[i]);
      if (d !== 0) return d;
    } else if (na !== nb) {
      return na ? -1 : 1; // numeric identifiers sort below alphanumeric ones
    } else if (ia[i] !== ib[i]) {
      return ia[i] < ib[i] ? -1 : 1;
    }
  }
  return 0;
}

const idx = JSON.parse(readFileSync(INDEX, 'utf8'));
const added = [];
for (const p of idx.plugins) {
  const src = p.versions?.[0]?.source;
  if (!src || src.type !== 'npm' || src.registry) continue;
  const url = `https://registry.npmjs.org/${p.name.replace('/', '%2f')}`;
  let pack;
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    pack = await res.json();
  } catch (error) {
    // One unpublished, renamed, or rate-limited package must not abort the
    // whole market sync; the other plugins still need their updates pushed.
    console.error(`skip ${p.name}: registry fetch failed (${error.message})`);
    continue;
  }
  if (!pack.versions || !pack.time) {
    console.error(`skip ${p.name}: bad packument`);
    continue;
  }
  const have = new Set(p.versions.map((v) => v.version));
  let max = [0, 0, 0];
  for (const v of have) {
    // A listed prerelease must not raise the floor: with 1.0.0-rc.1 present,
    // parts() would say [1,0,0] and hide the 1.0.0 release that supersedes it.
    const m = SEMVER.exec(v);
    if (!m || m[4] !== undefined) continue;
    const q = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (greater(q, max)) max = q;
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
  p.versions.sort(
    (a, b) => compareVersions(b.version, a.version) || b.publishTimestamp - a.publishTimestamp,
  );
}

// Sync git sources: update commit SHA to latest main/master branch
const git_changed = [];
for (const p of idx.plugins) {
  const src = p.versions?.[0]?.source;
  if (!src || src.type !== 'git' || !src.url) continue;
  const repo = src.url.replace(/\.git$/, '');
  let out;
  try {
    out = (await exec('git', ['ls-remote', repo, 'HEAD'])).stdout.trim();
  } catch {
    console.error(`skip ${p.name}: git ls-remote failed for ${repo}`);
    continue;
  }
  const sha = out.split(/\s/)[0];
  if (!sha || sha.length !== 40) {
    console.error(`skip ${p.name}: bad SHA from ${repo}`);
    continue;
  }
  // Every listed version of a git plugin follows the branch head: the pinned
  // SHA is what clients install, so a stale older entry would install an
  // outdated tree. Only the newest entry gets a refreshed timestamp, since a
  // pin move is not a republication of every older version.
  const newest = p.versions[0];
  let moved = false;
  for (const v of p.versions) {
    if (v.source.type !== 'git' || v.source.commit === sha) continue;
    const old = v.source.commit;
    v.source.commit = sha;
    if (v === newest) v.publishTimestamp = Math.floor(Date.now() / 1000);
    if (!moved) {
      moved = true;
      git_changed.push(`${p.name}: ${old?.slice(0, 7)} → ${sha.slice(0, 7)}`);
    }
  }
}

if (added.length === 0 && git_changed.length === 0) {
  console.log('up to date');
} else {
  if (!CHECK) writeFileSync(INDEX, JSON.stringify(idx, null, 2) + '\n');
  if (added.length > 0) console.log((CHECK ? 'would add: ' : 'added: ') + added.join(', '));
  if (git_changed.length > 0) console.log((CHECK ? 'would update git: ' : 'git updated: ') + git_changed.join(', '));
}
process.exitCode = CHECK && added.length + git_changed.length > 0 ? 1 : 0;
