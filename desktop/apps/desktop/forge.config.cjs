module.exports = {
  packagerConfig: {
    name: 'T-AGNET',
    asar: true,
    extraResource: ['./runtime'],
    ignore: [/^\/runtime($|\/)/, /^\/src($|\/)/, /^\/ui($|\/)/],
  },
  makers: [],
  hooks: {},
};
