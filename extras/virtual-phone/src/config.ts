import { lstatSync, readFileSync } from 'node:fs';
import { z } from 'zod';

// Explicit, owner-only node configuration. Never discover arbitrary ADB devices.
const configSchema = z.object({ enabled: z.literal(true), adbPath: z.string().startsWith('/'), lockPath: z.string().startsWith('/'), serial: z.string().min(1).max(256).regex(/^[A-Za-z0-9._:\[\]-]+$/), adbPort: z.number().int().min(1).max(65535), ffmpegPath: z.string().startsWith('/') }).strict();
export type Config = z.infer<typeof configSchema>;

export function readPhoneConfig(configPath: string): Config {
  try {
    const st = lstatSync(configPath);
    if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o077)) throw Error();
    return configSchema.parse(JSON.parse(readFileSync(configPath, 'utf8')));
  } catch { throw new Error('此节点未显式启用手机控制'); }
}
