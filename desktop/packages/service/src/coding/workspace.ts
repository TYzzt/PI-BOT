import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, lstat, readFile, readlink } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname, join } from 'node:path';
import { createTwoFilesPatch } from 'diff';
import type { Changes } from '../../../protocol/src/index.js';
const exec = promisify(execFile);
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface FileImage { hash: string; mode: number; size: number; text?: string; kind: 'file' | 'symlink' | 'submodule'; }
export interface WorkspaceImage { head: string; index: string; files: Record<string, FileImage>; fingerprint: string; status: string; extras: string[]; }
export async function git(root: string, args: string[]) {
  try { const result = await exec('/usr/bin/git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.quotePath=false', '-c', 'diff.external=', ...args], {
    cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 20000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' },
  }); return result.stdout; } catch { throw new Error('Git 查询失败：请确认项目目录可用且 Git 索引未损坏'); }
}
export async function projectRoot(path: string) {
  const selected = await realpath(path).catch(() => { throw new Error('项目目录不存在或无法访问'); });
  if (!(await lstat(selected)).isDirectory()) throw new Error('请选择项目目录');
  const root = (await git(selected, ['rev-parse', '--show-toplevel'])).trim();
  if (!root) throw new Error('仅支持 Git 工作区');
  return realpath(root);
}
export async function projectStatus(root: string) {
  if (await projectRoot(root) !== root) throw new Error('项目 Git 根目录已变化，请重新登记');
  const branch = (await git(root, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => 'detached HEAD')).trim();
  const status = await git(root, ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=all']);
  return { branch, status: status.slice(0, 16000), available: true };
}
export async function entries(root: string) {
  const index = await git(root, ['ls-files', '--stage', '-z']);
  const submodules = index.split('\0').filter(x => x.startsWith('160000 ')).map(x => x.slice(x.indexOf('\t') + 1));
  const names = (await git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
  return { index, submodules, names: [...new Set(names)].sort() };
}
function inside(root: string, path: string) { const rel = relative(root, path); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../')); }
export async function safePath(root: string, input: string, writable = false) {
  if (isAbsolute(input) || input.split(/[\\/]/).some(p => p === '..' || p.toLowerCase() === '.git')) throw new Error('路径必须在项目内，不能访问 .. 或 .git');
  const path = resolve(root, input);
  if (!inside(root, path)) throw new Error('路径超出项目');
  const { submodules } = await entries(root);
  if (submodules.some(p => input === p || input.startsWith(p + '/'))) throw new Error('本阶段不展开子模块');
  let ancestor = path;
  for (;;) {
    try {
      const actual = await realpath(ancestor);
      if (relative(root, actual).split('/').some(p => p.toLowerCase() === '.git')) throw new Error('不能访问 .git 内部文件');
      if (submodules.some(p => relative(root, actual) === p || relative(root, actual).startsWith(p + '/'))) throw new Error('本阶段不展开子模块');
      if (!inside(root, actual)) throw new Error('符号链接指向项目外');
      // Do not modify through aliases, including a link to another file inside the project.
      if (writable && actual !== ancestor) throw new Error('不允许通过符号链接写入');
      return writable ? path : actual;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!writable || ancestor === root) throw new Error('文件不存在');
      ancestor = dirname(ancestor);
    }
  }
}
export async function fileImage(path: string, textBudget = 128 * 1024): Promise<FileImage | null> {
  const stat = await lstat(path).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  if (!stat) return null;
  if (stat.isSymbolicLink()) { const link = await readlink(path); return { hash: digest(link), mode: stat.mode, size: stat.size, kind: 'symlink', text: link }; }
  if (!stat.isFile()) throw new Error('工作区包含不支持的文件类型');
  const hash = createHash('sha256'); const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of createReadStream(path)) { const buffer = chunk as Buffer; hash.update(buffer); size += buffer.length; if (size <= textBudget) chunks.push(buffer); }
  const value: FileImage = { hash: hash.digest('hex'), mode: stat.mode, size, kind: 'file' };
  if (size <= textBudget) { const body = Buffer.concat(chunks); if (!body.includes(0)) value.text = body.toString('utf8'); }
  return value;
}
export async function capture(root: string, extras: string[] = []): Promise<WorkspaceImage> {
  await projectStatus(root);
  const { index, submodules, names } = await entries(root);
  const all = [...new Set([...names, ...extras])].sort();
  if (all.length > 20000) throw new Error('项目超过 20000 个文件，请缩小工作区后再试');
  const files: Record<string, FileImage> = Object.create(null); let budget = 8 * 1024 * 1024;
  for (const name of all) {
    if (submodules.includes(name)) { files[name] = { hash: digest(index.split('\0').find(x => x.endsWith('\t' + name))), mode: 0, size: 0, kind: 'submodule' }; continue; }
    const path = resolve(root, name);
    if (!inside(root, path) || name.split('/').some(p => p.toLowerCase() === '.git')) throw new Error('索引包含非法路径');
    // Never follow a directory symlink while snapshotting.
    const parent = await realpath(dirname(path)).catch(() => null);
    if (!parent) continue;
    if (!inside(root, parent)) throw new Error('文件父目录指向项目外');
    const image = await fileImage(path, Math.min(budget, 128 * 1024));
    if (image) { files[name] = image; budget -= Buffer.byteLength(image.text ?? ''); }
  }
  const head = (await git(root, ['rev-parse', '--verify', 'HEAD']).catch(() => 'unborn')).trim();
  const status = await git(root, ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=all']);
  const fingerprint = digest({ head, index, files: Object.entries(files).map(([name, f]) => [name, f.hash, f.mode, f.kind]) });
  return { head, index, files, fingerprint, status, extras: [...extras] };
}
export function changedPaths(a: WorkspaceImage, b: WorkspaceImage) {
  return [...new Set([...Object.keys(a.files), ...Object.keys(b.files)])].filter(p => a.files[p]?.hash !== b.files[p]?.hash || a.files[p]?.mode !== b.files[p]?.mode).sort();
}
export function baselineChanges(before: WorkspaceImage, after: WorkspaceImage, selected?: string): Changes {
  const files = changedPaths(before, after).map(path => ({ path, kind: !before.files[path] ? 'added' as const : !after.files[path] ? 'deleted' as const : 'modified' as const, preview: (!before.files[path] || before.files[path].text !== undefined) && (!after.files[path] || after.files[path].text !== undefined) }));
  let diff = ''; const item = files.find(f => f.path === selected);
  if (item) {
    if (!item.preview) diff = '二进制、过大文件或快照文本预算已用尽；未完整预览。';
    else diff = createTwoFilesPatch(`before/${item.path}`, `after/${item.path}`, before.files[item.path]?.text ?? '', after.files[item.path]?.text ?? '', '', '', { context: 3 }).slice(0, 250000);
  }
  return { files, diff, warning: '相对执行前基线的当前差异；可能包含执行期间的外部编辑，不能全部归因于智能体。大文件仅保留指纹，预览最多 250000 字符。' };
}
export async function workspaceChanges(root: string, selected?: string): Promise<Changes> {
  await projectStatus(root);
  const head = (await git(root, ['rev-parse', '--verify', 'HEAD']).catch(() => 'unborn')).trim();
  const tracked = head === 'unborn' ? (await entries(root)).names : (await git(root, ['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', head, '--'])).split('\0').filter(Boolean);
  const untracked = (await git(root, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
  const names = [...new Set([...tracked, ...untracked])].sort();
  const empty: WorkspaceImage = { head, index: '', files: Object.create(null), fingerprint: '', status: '', extras: [] };
  const base: WorkspaceImage = { ...empty, files: Object.create(null) }, current: WorkspaceImage = { ...empty, files: Object.create(null) };
  const tree = new Map<string, { mode: string; kind: string; oid: string }>();
  if (head !== 'unborn') for (const line of (await git(root, ['ls-tree', '-r', '-z', head])).split('\0').filter(Boolean)) { const tab = line.indexOf('\t'), [mode, kind, oid] = line.slice(0, tab).split(' '); tree.set(line.slice(tab + 1), { mode, kind, oid }); }
  let budget = 8 * 1024 * 1024;
  for (const name of names) {
    const entry = tree.get(name); if (entry?.kind === 'commit') continue;
    // safePath rejects directory aliases; fileImage represents symlinks without following them.
    const parent = await realpath(dirname(resolve(root, name))).catch(() => null);
    if (parent && inside(root, parent)) { const image = await fileImage(resolve(root, name), Math.min(budget, 128 * 1024)); if (image) { current.files[name] = image; budget -= Buffer.byteLength(image.text ?? ''); } }
    if (!entry) continue;
    const size = Number((await git(root, ['cat-file', '-s', entry.oid])).trim()); let text: string | undefined;
    if (size <= Math.min(budget, 128 * 1024)) { const body = await git(root, ['cat-file', 'blob', entry.oid]); if (!body.includes('\0')) { text = body; budget -= size; } }
    base.files[name] = { hash: text !== undefined ? createHash('sha256').update(text).digest('hex') : `git:${entry.oid}`, text, size, mode: parseInt(entry.mode, 8), kind: entry.mode === '120000' ? 'symlink' : 'file' };
  }
  const changes = baselineChanges(base, current, selected);
  changes.warning = '整个工作区相对 HEAD 的差异，包含你原有的修改；暂存区和未暂存状态见项目页。' + (head === 'unborn' ? '当前尚无首个 commit。' : '');
  return changes;
}
