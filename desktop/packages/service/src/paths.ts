import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
export const dataDir = process.env.T_AGNET_DATA_DIR || join(homedir(), 'Library', 'Application Support', 'T-AGNET');
// Unix sockets on macOS have a short path limit. Keep the socket under a private user-specific /tmp directory.
export const socketDir = join('/tmp', `t-agnet-${process.getuid?.() ?? 0}-${createHash('sha256').update(dataDir).digest('hex').slice(0, 12)}`);
export const socketPath = join(socketDir, 'service.sock');
export const tokenPath = join(dataDir, 'ipc-token');
