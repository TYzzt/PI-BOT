module.exports = {
  packagerConfig: {
    name: 'Pi Bot',
    appBundleId: 'dev.pi-bot.desktop',
    icon: './assets/pi-bot',
    asar: true,
    extraResource: ['./runtime'],
    ignore: [/^\/runtime($|\/)/, /^\/src($|\/)/, /^\/ui($|\/)/],
  },
  makers: [],
  hooks: {},
};
