import { build as bundle } from 'esbuild';
import { build as viteBuild } from 'vite';
import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const workspace = { name: 'pi-bot-workspace', setup(build) { build.onResolve({ filter: /^@pi-bot\/(agent|bot-face)$/ }, args => ({ path: resolve('../packages', args.path.split('/')[1], 'src/index.ts') })); } };
mkdirSync('native/dist', { recursive: true });
const result = spawnSync('xcrun', ['swiftc', '-O', 'native/Keychain.swift', '-o', 'native/dist/keychain'], { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);
await Promise.all([
  bundle({ entryPoints: ['apps/desktop/src/main.ts'], outfile: 'apps/desktop/dist/main.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'], sourcemap: true }),
  bundle({ entryPoints: ['apps/desktop/src/preload.ts'], outfile: 'apps/desktop/dist/preload.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'] }),
  bundle({ entryPoints: ['packages/service/src/server.ts'], outfile: 'packages/service/dist/server.mjs', plugins: [workspace], bundle: true, platform: 'node', format: 'esm', packages: 'external', sourcemap: true }),
]);
await viteBuild({ root: resolve('apps/desktop/ui'), base: './', build: { outDir: resolve('apps/desktop/ui-dist'), emptyOutDir: true }, configFile: false });
