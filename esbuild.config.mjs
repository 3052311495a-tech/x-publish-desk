import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
await build({ entryPoints: ['main.ts'], bundle: true, outfile: 'main.js', format: 'cjs', platform: 'node', target: 'es2020', external: ['obsidian', 'electron'], logLevel: 'info', banner: { js: '/* X 发布台 — third-party licenses: THIRD_PARTY_NOTICES.md */' } });
const design = await readFile('设计稿/styles.css', 'utf8');
const layout = await readFile('src/layout.css', 'utf8');
await writeFile('styles.css', design + '\n' + layout);
