import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const required = [
    'entry.js',
    'dist/index.js',
    'dist/index.d.ts',
    'dist/types.d.ts',
    'dist/session/types.d.ts',
    'dist/model/types.d.ts',
    'client/qqbot-settings.js',
    'settings-host.js',
    'cordis.patch.yml',
];

for (const rel of required) {
    if (!existsSync(join(root, rel)))
        throw new Error(`missing required package file: ${rel}`);
}

function walk(dir) {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory())
            out.push(...walk(path));
        else if (entry.isFile() && entry.name.endsWith('.d.ts'))
            out.push(path);
    }
    return out;
}

for (const file of walk(join(root, 'dist'))) {
    const source = readFileSync(file, 'utf8');
    const pattern = /['"](\.{1,2}\/[^'"]+)['"]/g;
    for (const match of source.matchAll(pattern)) {
        const spec = match[1];
        const target = resolve(dirname(file), spec.replace(/\.js$/, '.d.ts'));
        if (!existsSync(target))
            throw new Error(`missing type target: ${relative(root, target)} referenced by ${relative(root, file)}`);
    }
}

console.log('package check OK');
