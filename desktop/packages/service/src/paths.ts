import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
export const dataDir = process.env.PI_BOT_DATA_DIR || join(homedir(), 'Library', 'Application Support', 'Pi Bot');
// Unix sockets on macOS have a short path limit. Keep the socket under a private user-specific /tmp directory.
export const socketDir = join('/tmp', `pi-bot-${process.getuid?.() ?? 0}-${createHash('sha256').update(dataDir).digest('hex').slice(0, 12)}`);
export const socketPath = join(socketDir, 'service.sock');
export const tokenPath = join(dataDir, 'ipc-token');
/** Each bot's library lives in `<libraryRoot>/<slug>`. */
export const libraryRoot = process.env.PI_BOT_LIBRARY_ROOT || join(homedir(), 'pi-bot');
