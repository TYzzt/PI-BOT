module.exports = {
  packagerConfig: {
    name: 'Pi Bot',
    appBundleId: 'dev.pi-bot.desktop',
    asar: true,
    extraResource: ['./runtime'],
    ignore: [/^\/runtime($|\/)/, /^\/src($|\/)/, /^\/ui($|\/)/],
  },
  makers: [],
  hooks: {},
};
