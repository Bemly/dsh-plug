import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decryptFile } from './decrypt.mjs';
import { extractTarZst } from './extract.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const packageRoot = resolve(here, '..');
export const payloadFile = join(packageRoot, 'payload', 'dsh-zako-hub.tar.zstd');

export function defaultHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh');
}

export function resolveProfileDir(dshHome, profile) {
  const dir = resolve(dshHome, 'profiles', profile);
  if (!existsSync(join(dir, 'package.json'))) {
    throw new Error(`profile not found: ${dir} (expected a DSH profile directory with package.json)`);
  }
  return dir;
}

export function readInnerIdentity(innerDir) {
  const manifest = JSON.parse(readFileSync(join(innerDir, 'package.json'), 'utf8'));
  if (!manifest.name || !manifest.version) throw new Error('extracted payload has no name/version');
  return { name: manifest.name, version: manifest.version };
}

export function findDsh() {
  const probe = spawnSync('dsh', ['--version'], { encoding: 'utf8' });
  return probe.error === undefined && probe.status === 0;
}

export async function install({ dshHome = defaultHome(), profile = 'desktop' } = {}) {
  if (!existsSync(payloadFile)) throw new Error(`payload missing: ${payloadFile}`);
  const profileDir = resolveProfileDir(dshHome, profile);
  const vendorDir = join(packageRoot, 'vendor', 'extracted');
  mkdirSync(vendorDir, { recursive: true });
  const tarZst = decryptFile(payloadFile);
  const topDir = await extractTarZst(tarZst, vendorDir);
  const innerDir = join(vendorDir, topDir);
  const { name, version } = readInnerIdentity(innerDir);
  console.log(`payload ready: ${name}@${version} -> ${innerDir}`);
  if (!findDsh()) {
    console.log('dsh CLI not found on PATH; finish the install manually:');
    console.log(`  dsh plugin --profile ${profile} add ${innerDir}`);
    return { name, version, dir: innerDir, registered: false };
  }
  const run = spawnSync('dsh', ['plugin', '--profile', profile, 'add', innerDir], { stdio: 'inherit' });
  if (run.status !== 0) throw new Error(`dsh plugin add failed with exit code ${run.status}`);
  console.log(`installed ${name}@${version} into profile '${profile}' (restart the host to activate)`);
  return { name, version, dir: innerDir, registered: true };
}

export function status({ dshHome = defaultHome(), profile = 'desktop' } = {}) {
  const report = { payload: existsSync(payloadFile), vendor: null, profile: null };
  const vendorDir = join(packageRoot, 'vendor', 'extracted');
  if (existsSync(vendorDir)) {
    for (const entry of readdirSync(vendorDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const id = readInnerIdentity(join(vendorDir, entry.name));
        report.vendor = { dir: join(vendorDir, entry.name), ...id };
      } catch {}
    }
  }
  try {
    const profileDir = resolveProfileDir(dshHome, profile);
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
    const deps = { ...(manifest.dependencies || {}), ...(manifest.devDependencies || {}) };
    const match = report.vendor
      ? Object.keys(deps).find((spec) => spec === report.vendor.name)
      : undefined;
    report.profile = { dir: profileDir, dependency: match ?? null };
  } catch (error) {
    report.profile = { error: String(error?.message ?? error) };
  }
  return report;
}
