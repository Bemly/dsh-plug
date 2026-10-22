#!/usr/bin/env node
import { install, status } from '../lib/install.mjs';

function flag(args, name, fallback) {
  const at = args.indexOf(name);
  if (at === -1) return fallback;
  return args[at + 1] ?? fallback;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'install') {
    const profile = flag(rest, '--profile', 'desktop');
    const dshHome = flag(rest, '--dsh-home', undefined);
    await install(dshHome === undefined ? { profile } : { dshHome, profile });
    return;
  }
  if (command === 'status') {
    const profile = flag(rest, '--profile', 'desktop');
    const dshHome = flag(rest, '--dsh-home', undefined);
    const report = status(dshHome === undefined ? { profile } : { dshHome, profile });
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log('zako-hub — encrypted payload installer');
  console.log('');
  console.log('  zako-hub install [--profile desktop] [--dsh-home ~/.dsh]');
  console.log('  zako-hub status  [--profile desktop] [--dsh-home ~/.dsh]');
  process.exitCode = command === undefined ? 0 : 1;
}

main().catch((error) => {
  console.error(`zako-hub: ${error?.message ?? error}`);
  process.exitCode = 1;
});
