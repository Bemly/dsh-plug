// Validate the market index against the official format-1 validator.
import { readFileSync } from 'node:fs';
import { parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index';
const idx = JSON.parse(readFileSync(new URL('../index.json', import.meta.url), 'utf8'));
const out = parseMarketIndex(idx, 'https://dsh.bemly.moe/');
console.log('market index valid:', out.plugins.length, 'plugins');
