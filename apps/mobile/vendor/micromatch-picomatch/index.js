'use strict';
// metro-file-map only calls micromatch.some(); picomatch matches brace patterns itself.
const picomatch = require('picomatch');

const micromatch = (list, patterns, options) => {
  const isMatch = picomatch(patterns, options);
  return [].concat(list).filter(item => isMatch(item));
};
micromatch.some = (list, patterns, options) => {
  const isMatch = picomatch(patterns, options);
  return [].concat(list).some(item => isMatch(item));
};
micromatch.isMatch = (str, patterns, options) => picomatch(patterns, options)(str);
micromatch.any = micromatch.isMatch;
micromatch.matcher = (pattern, options) => picomatch(pattern, options);
micromatch.makeRe = (pattern, options) => picomatch.makeRe(pattern, options);
for (const name of ['braces', 'braceExpand', 'expand', 'parse']) {
  micromatch[name] = () => { throw new Error(`micromatch.${name} is not provided by micromatch-picomatch`); };
}
module.exports = micromatch;
