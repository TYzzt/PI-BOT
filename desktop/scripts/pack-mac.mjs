import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const node = resolve(root, 'node_modules/node/bin/node');
const runtime = resolve(root, 'apps/desktop/runtime');
const require = createRequire(resolve(root, 'package.json'));
const pkg = require(resolve(root, 'package.json'));
const runtimeDeps = ['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent', 'diff', 'playwright-core', 'typebox', 'ws', 'zod'];

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(node, ['scripts/build.mjs'], root);

rmSync(runtime, { recursive: true, force: true });
mkdirSync(resolve(runtime, 'bin'), { recursive: true });
cpSync(resolve(root, 'node_modules/node/bin/node'), resolve(runtime, 'bin/node'));
cpSync(resolve(root, 'packages/service/dist/server.mjs'), resolve(runtime, 'server.mjs'));
cpSync(resolve(root, 'packages/service/dist/command-worker.mjs'), resolve(runtime, 'command-worker.mjs'));
cpSync(resolve(root, 'native/dist/keychain'), resolve(runtime, 'keychain'));
writeFileSync(resolve(runtime, 'package.json'), JSON.stringify({
  name: 't-agnet-runtime',
  private: true,
  type: 'module',
  dependencies: Object.fromEntries(runtimeDeps.map(name => [name, pkg.dependencies[name]])),
}, null, 2));
run('npm', ['install', '--omit=dev', '--no-package-lock', '--ignore-scripts'], runtime);
run(resolve(root, 'node_modules/.bin/electron-forge'), ['package', '--platform', 'darwin'], resolve(root, 'apps/desktop'));

const app = resolve(root, 'apps/desktop/out/T-AGNET-darwin-arm64/T-AGNET.app');
const stage = resolve(root, 'apps/desktop/out/dmg-stage');
const dmg = resolve(root, 'apps/desktop/out/make/T-AGNET-arm64.dmg');
rmSync(stage, { recursive: true, force: true });
mkdirSync(resolve(root, 'apps/desktop/out/make'), { recursive: true });
mkdirSync(stage);
cpSync(app, resolve(stage, 'T-AGNET.app'), { recursive: true });
run('ln', ['-s', '/Applications', resolve(stage, 'Applications')], root);
rmSync(dmg, { force: true });
run('hdiutil', ['create', '-volname', 'T-AGNET', '-srcfolder', stage, '-ov', '-format', 'ULFO', dmg], root);
rmSync(stage, { recursive: true, force: true });
console.log(dmg);
