const path = require('path');

function requireSharp(extraSearchPaths = []) {
  const searchPaths = [
    __dirname,
    path.join(__dirname, '..'),
    path.join(__dirname, '..', '05_切分插件'),
    ...extraSearchPaths.filter(Boolean)
  ];

  return require(require.resolve('sharp', { paths: searchPaths }));
}

module.exports = {
  requireSharp
};
