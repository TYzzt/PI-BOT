const { resolve } = require('node:path');
module.exports = {
  // NuGet/Squirrel still enforce MAX_PATH even when Node supports long paths.
  ...(process.platform === 'win32' ? { outDir: resolve(__dirname, '../../../.w') } : {}),
  packagerConfig: {
    name: 'Pi Bot',
    appBundleId: 'dev.pi-bot.desktop',
    icon: process.platform === 'darwin' ? './assets/pi-bot' : process.platform === 'win32' ? './assets/pi-bot.ico' : './assets/pi-bot.png',
    asar: true,
    extraResource: ['./runtime'],
    ignore: [/^\/runtime($|\/)/, /^\/src($|\/)/, /^\/ui($|\/)/],
  },
  makers: [
    { name: '@electron-forge/maker-squirrel', platforms: ['win32'], config: { ...(process.env.PI_BOT_SQUIRREL_VENDOR ? { vendorDirectory: process.env.PI_BOT_SQUIRREL_VENDOR } : {}), name: 'PiBot', setupExe: 'Pi-Bot-Windows-x64-Setup.exe', setupIcon: './assets/pi-bot.ico', noMsi: true } },
    { name: '@electron-forge/maker-zip', platforms: ['win32'] },
  ],
  hooks: {},
};
