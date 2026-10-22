import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decompress } from 'fzstd';
import { t as tarList, x as tarExtract } from 'tar';

export async function extractTarZst(tarZstBytes, destDir) {
  const tarBytes = Buffer.from(decompress(new Uint8Array(tarZstBytes)));
  const scratch = mkdtempSync(join(tmpdir(), 'zako-'));
  const tmpTar = join(scratch, 'payload.tar');
  try {
    writeFileSync(tmpTar, tarBytes);
    const entries = [];
    await tarList({ file: tmpTar, onentry: (entry) => entries.push(entry.path) });
    await tarExtract({ file: tmpTar, cwd: destDir });
    if (entries.length === 0) throw new Error('archive is empty');
    return entries[0].split('/')[0];
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
