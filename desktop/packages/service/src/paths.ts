import { connect } from 'node:net';
import { homedir, userInfo } from 'node:os';
import { join, win32 } from 'node:path';
import { createHash } from 'node:crypto';
import { defaultDataDir } from './platform.js';
export const dataDir = defaultDataDir();
// Unix sockets on macOS have a short path limit. Keep the socket under a private user-specific /tmp directory.
export const socketDir = join('/tmp', `pi-bot-${process.getuid?.() ?? 0}-${createHash('sha256').update(dataDir).digest('hex').slice(0, 12)}`);
// Windows beta deliberately uses loopback TCP, not an inadequately secured named pipe.
// The port is only discovery; 256-bit per-install token authentication remains mandatory.
const windowsPort = 20000 + parseInt(createHash('sha256').update(`${userInfo().username}:${process.platform === 'win32' ? win32.normalize(dataDir).toLowerCase() : dataDir}`).digest('hex').slice(0, 8), 16) % 40000;
export const socketPath = process.platform === 'win32' ? `tcp:${windowsPort}` : join(socketDir, 'service.sock');
export const listenAddress = process.platform === 'win32' ? { port: windowsPort, host: '127.0.0.1', exclusive: true } : { path: socketPath };
export function connectLocal(endpoint = socketPath) {
  if (endpoint.startsWith('tcp:')) return connect({ port: Number(endpoint.slice(4)), host: '127.0.0.1' });
  return connect(endpoint);
}
export const tokenPath = join(dataDir, 'ipc-token');
/** Each bot's library lives in `<libraryRoot>/<slug>`. */
export const libraryRoot = process.env.PI_BOT_LIBRARY_ROOT || join(homedir(), 'pi-bot');
