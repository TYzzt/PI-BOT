import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { prepareRuntime, run } from './prepare-runtime.mjs';
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('请在 Windows x64 构建；不把未经验证的跨平台产物作为安装包');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(root, 'package.json'));
run(process.execPath, ['scripts/build.mjs'], root);
// Tests are a packaging gate, not an optional post-release step.
run(process.execPath, ['--import', 'tsx', '--test', '--test-timeout=120000', 'tests/windows.test.ts'], root);
prepareRuntime(root, resolve(root, 'apps/desktop/runtime'));
run(process.execPath, ['scripts/smoke-windows-runtime.mjs'], root);
run(process.execPath, [require.resolve('@electron-forge/cli/dist/electron-forge.js'), 'make', '--platform=win32', '--arch=x64'], resolve(root, 'apps/desktop'));
const make = resolve(root, 'apps/desktop/out/make');
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(resolve(dir, entry.name)) : [resolve(dir, entry.name)]);
}
const artifacts = files(make).filter(file => /\.(exe|zip|nupkg)$/i.test(file));
writeFileSync(resolve(make, 'SHA256SUMS.txt'), artifacts.map(file => `${createHash('sha256').update(readFileSync(file)).digest('hex')}  ${file.slice(make.length + 1).replaceAll('\\', '/')}`).join('\n') + '\n');
console.log('Windows UNSIGNED TEST artifacts:', artifacts);
