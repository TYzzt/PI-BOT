import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync, cpSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { prepareRuntime, run } from './prepare-runtime.mjs';
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('请在 Windows x64 构建；不把未经验证的跨平台产物作为安装包');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(root, 'package.json'));
// Keep both Forge output and legacy NuGet scratch paths short. Do not change
// machine-wide long-path settings or require an elevated build environment.
const scratch = mkdtempSync(resolve(root, '../.t-'));
process.env.TEMP = scratch; process.env.TMP = scratch; process.env.SQUIRREL_TEMP = scratch;
process.on('exit', () => { try { rmSync(scratch, { recursive: true, force: true }); } catch {} });
// electron-winstaller 5.4.4 ships arch-suffixed 7-Zip binaries, while its
// bundled Squirrel still requests 7z.exe/7z.dll. Stage a complete vendor copy
// with aliases; use only binaries from the locked dependency, never the PATH.
const vendor = resolve(scratch, 'vendor');
cpSync(resolve(dirname(require.resolve('electron-winstaller/package.json')), 'vendor'), vendor, { recursive: true });
for (const extension of ['exe', 'dll']) {
  const legacy = resolve(vendor, `7z.${extension}`);
  if (!existsSync(legacy)) cpSync(resolve(vendor, `7z-x64.${extension}`), legacy);
}
process.env.PI_BOT_SQUIRREL_VENDOR = vendor;
run(process.execPath, ['scripts/build.mjs'], root);
// Tests are a packaging gate, not an optional post-release step.
run(process.execPath, ['--import', 'tsx', '--test', '--test-timeout=120000', 'tests/windows.test.ts'], root);
const runtime = resolve(root, 'apps/desktop/runtime');
prepareRuntime(root, runtime);
// Type declarations/source maps are not executable runtime inputs. Removing
// them also keeps deeply nested SDK type paths out of Squirrel's legacy
// extraction code on end-user machines, not just on the CI build host.
function pruneDevelopmentMetadata(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = resolve(dir, entry.name);
    if (entry.isDirectory()) pruneDevelopmentMetadata(file);
    else if (/\.d\.(?:ts|cts|mts)(?:\.map)?$|\.(?:js|cjs|mjs)\.map$/.test(entry.name)) rmSync(file);
  }
}
pruneDevelopmentMetadata(resolve(runtime, 'node_modules'));
run(process.execPath, ['scripts/smoke-windows-runtime.mjs'], root);
run(process.execPath, [require.resolve('@electron-forge/cli/dist/electron-forge.js'), 'make', '--platform=win32', '--arch=x64'], resolve(root, 'apps/desktop'));
const make = resolve(root, '../.w/make');
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(resolve(dir, entry.name)) : [resolve(dir, entry.name)]);
}
const artifacts = files(make).filter(file => /\.(exe|zip)$/i.test(file));
writeFileSync(resolve(make, 'SHA256SUMS.txt'), artifacts.map(file => `${createHash('sha256').update(readFileSync(file)).digest('hex')}  ${file.slice(make.length + 1).replaceAll('\\', '/')}`).join('\n') + '\n');
console.log('Windows UNSIGNED TEST artifacts:', artifacts);
