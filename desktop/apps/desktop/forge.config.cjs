module.exports = {
  packagerConfig: {
    name: 'Pi Bot',
    appBundleId: 'dev.pi-bot.desktop',
    icon: process.platform === 'darwin' ? './assets/pi-bot' : './assets/pi-bot.png',
    asar: true,
    extraResource: ['./runtime'],
    ignore: [/^\/runtime($|\/)/, /^\/src($|\/)/, /^\/ui($|\/)/],
  },
  makers: [],
  hooks: {},
};
