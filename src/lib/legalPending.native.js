// Metro resolves this module in place of legalPending.js. Keep the entire
// pending directory in the graph, including newly added declaration files.
/* global require */
export function bundledPendingTexts(declarations = require.context("../../content/legal/pending", false, /\.json$/)) {
  return declarations.keys().sort().map((path) => JSON.stringify(declarations(path)));
}
