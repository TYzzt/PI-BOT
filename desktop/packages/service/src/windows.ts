import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, join, win32 } from 'node:path';

/** Never fall back to plaintext credentials or untracked process trees. */
export function windowsHelper() {
  const file = process.env.PI_BOT_WINDOWS_HELPER || join(dirname(process.execPath), '..', 'pi-bot-windows.exe');
  if (!isAbsolute(file)) throw new Error('Windows helper 必须是绝对路径');
  return file;
}
export function nativeWindows(operation: 'protect-directory' | 'protect-file' | 'encrypt' | 'decrypt', input: Buffer | string) {
  return execFileSync(windowsHelper(), [operation], { input, timeout: 15000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
}
export function protectWindowsDirectory(path: string) {
  validateWindowsPath(path);
  if (!win32.isAbsolute(path) || path.startsWith('\\\\')) throw new Error('Windows 私有目录必须位于本地磁盘');
  nativeWindows('protect-directory', Buffer.from(path, 'utf8'));
}

/** Explicitly narrow MVP file-name policy: no UNC, device namespace, ADS or ambiguous Win32 names. */
export function validateWindowsPath(input: string) {
  if (input.startsWith('\\\\') || input.startsWith('//') || /^[a-z]:[^\\/]/i.test(input) || /^[a-z]:$/i.test(input) || /^[\\/](?![\\/])/.test(input)) throw new Error('不支持 UNC、设备路径或盘符相对路径');
  const withoutDrive = input.replace(/^[a-z]:[\\/]/i, '');
  if (withoutDrive.includes(':') || /[<>"|?*\x00-\x1f]/.test(withoutDrive)) throw new Error('Windows 路径包含不支持的字符或数据流');
  for (const segment of withoutDrive.split(/[\\/]/)) {
    if (!segment || segment === '.' || segment === '..') continue;
    if (/[. ]$/.test(segment) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(segment)) throw new Error('Windows 路径包含保留名或尾部点/空格');
  }
}
export function libraryFolder(slug: string, platform = process.platform) {
  return platform === 'win32' && /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(slug) ? `_bot_${slug}` : slug;
}
export function powerShellArgs(command: string) {
  const script = `$ErrorActionPreference = 'Stop'\n[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)\n$OutputEncoding = [Console]::OutputEncoding\n$global:LASTEXITCODE = 0\ntry {\n${command}\nif (-not $?) { if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; exit 1 }\nexit $LASTEXITCODE\n} catch { [Console]::Error.WriteLine($_.ToString()); exit 1 }`;
  if (Buffer.byteLength(script, 'utf16le') * 4 / 3 > 28000) throw new Error('Windows PowerShell 命令过长，请把脚本写入资料库文件后调用');
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}
