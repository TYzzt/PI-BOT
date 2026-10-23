import { createCanvas } from '@napi-rs/canvas';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { BotEngine, DEFAULT_AVATAR, drawBot } from '../../packages/bot-face/src/index.js';

// Render the same mascot as the login screen and main bot, at every native icon size.
const assets = resolve(import.meta.dirname, '../apps/desktop/assets');
mkdirSync(assets, { recursive: true });
const png = (size: number) => {
  const canvas = createCanvas(size, size);
  const context = canvas.getContext('2d');
  drawBot(context as unknown as CanvasRenderingContext2D, new BotEngine('idle', { seed: 1 }).frame(), DEFAULT_AVATAR, size, { effects: false });
  return canvas.toBuffer('image/png');
};
writeFileSync(join(assets, 'pi-bot.png'), png(1024));
if (process.platform === 'darwin') {
  const temp = mkdtempSync(join(tmpdir(), 'pi-bot-icon-'));
  const iconset = join(temp, 'pi-bot.iconset');
  mkdirSync(iconset);
  try {
    for (const size of [16, 32, 128, 256, 512]) {
      writeFileSync(join(iconset, `icon_${size}x${size}.png`), png(size));
      writeFileSync(join(iconset, `icon_${size}x${size}@2x.png`), png(size * 2));
    }
    const result = spawnSync('iconutil', ['-c', 'icns', iconset, '-o', join(assets, 'pi-bot.icns')], { stdio: 'inherit' });
    if (result.status !== 0) throw new Error('生成应用图标失败');
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

// Windows ICO can carry a PNG-compressed 256x256 frame (Vista and later).
const frame = png(256);
const header = Buffer.alloc(22);
header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12);
header.writeUInt32LE(frame.length, 14); header.writeUInt32LE(22, 18);
writeFileSync(join(assets, 'pi-bot.ico'), Buffer.concat([header, frame]));
