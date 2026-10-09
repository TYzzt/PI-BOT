import { build as bundle } from 'esbuild';
import { build as viteBuild } from 'vite';
import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const sharedAgent = { name: 'shared-agent', setup(build) { build.onResolve({ filter: /^@t-agnet\/agent(?:\/plugins)?$/ }, args => ({ path: resolve('../packages/agent/src', args.path.endsWith('/plugins') ? 'plugins.ts' : 'index.ts') })); } };
mkdirSync('native/dist', { recursive: true });
const result = spawnSync('xcrun', ['swiftc', '-O', 'native/Keychain.swift', '-o', 'native/dist/keychain'], { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);
await Promise.all([
  bundle({ entryPoints: ['packages/service/src/coding/command-worker.ts'], outfile: 'packages/service/dist/command-worker.mjs', bundle: true, platform: 'node', format: 'esm', packages: 'external' }),
  bundle({ entryPoints: ['apps/desktop/src/main.ts'], outfile: 'apps/desktop/dist/main.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'], sourcemap: true }),
  bundle({ entryPoints: ['apps/desktop/src/preload.ts'], outfile: 'apps/desktop/dist/preload.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'] }),
  bundle({ entryPoints: ['packages/service/src/server.ts'], outfile: 'packages/service/dist/server.mjs', plugins: [sharedAgent], bundle: true, platform: 'node', format: 'esm', packages: 'external', sourcemap: true }),
]);
await viteBuild({ root: resolve('apps/desktop/ui'), base: './', build: { outDir: resolve('apps/desktop/ui-dist'), emptyOutDir: true }, configFile: false });
