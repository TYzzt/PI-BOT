import { realpath, stat, readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

export function parseFileLink(href: string) {
  if (!href || href.length > 4096 || /[\u0000-\u001f]/.test(href)) throw new Error('文件链接无效');
  const match = href.match(/(?:#L(\d+)(?:-L?\d+)?|:(\d+)(?::\d+)?)$/);
  const line = match ? Number(match[1] ?? match[2]) : undefined;
  if (line !== undefined && (!Number.isSafeInteger(line) || line < 1)) throw new Error('文件行号无效');
  let path = match ? href.slice(0, match.index) : href;
  try { path = path.startsWith('file:') ? fileURLToPath(path) : decodeURIComponent(path); } catch { throw new Error('文件链接无效'); }
  if (!path || /[\u0000-\u001f]/.test(path) || /[?#]/.test(path) || /^[a-z][a-z\d+.-]*:/i.test(path)) throw new Error('不支持此文件链接');
  return { path, line };
}

export async function resolveProjectFile(root: string, href: string) {
  const link = parseFileLink(href), realRoot = await realpath(root);
  const inside = (path: string) => { const rel = relative(realRoot, path); return !!rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.split('/').some(p => p.toLowerCase() === '.git'); };
  const candidate = resolve(realRoot, link.path);
  if (!inside(candidate)) throw new Error('只能打开当前项目内的文件');
  const path = await realpath(candidate).catch(() => { throw new Error('文件不存在或无法访问'); });
  if (!inside(path)) throw new Error('文件指向当前项目之外');
  const info = await stat(path);
  if (!info.isFile()) throw new Error('链接目标不是文件');
  // Opening these file types in their default app may execute them instead of displaying source.
  if (['.command', '.scpt', '.workflow', '.webloc', '.url'].includes(extname(path).toLowerCase())) throw new Error('此文件类型不支持通过默认应用预览');
  if (info.size > 4 * 1024 * 1024) throw new Error('文件过大，请在编辑器中手动打开');
  const body = await readFile(path);
  if (body.includes(0)) throw new Error('仅支持打开文本文件');
  if (link.line && link.line > body.toString('utf8').split('\n').length) throw new Error('指定行号超出文件范围');
  return { path, line: link.line };
}
