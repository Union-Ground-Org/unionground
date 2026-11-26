// The runtime version's fingerprint (apps/mobile/AGENTS.md "Over-the-air update
// contract"; REQ-UG-PHONE-APPS-OVER-THE-AIR-UPDATES-20261113).
//
// The Firebase Android client file comes from the EAS secret file variable
// GOOGLE_SERVICES_JSON, which exists only on the EAS worker. The local EAS CLI
// fingerprints the project without it and the worker with it, and EAS refuses a
// build whose two runtime versions differ. So the file the variable names is
// left out of the fingerprint wherever it is. The JavaScript an update carries
// never reads that file: the native push setup does, from the copy compiled
// into the build. Every other native input stays in the fingerprint.
const path = require('node:path');

function escapeGlob(value) {
  return value.replace(/[\\*?[\]{}()!+@]/g, '\\$&');
}

// The file as the fingerprint names it: relative to this project, POSIX slashes.
function firebaseClientIgnorePaths(environment) {
  const file = environment.GOOGLE_SERVICES_JSON?.trim();
  if (!file) return [];
  const relative = path.relative(__dirname, path.resolve(__dirname, file)).split(path.sep).join('/');
  return [escapeGlob(relative)];
}

module.exports = {
  // Read on every fingerprint, so it follows the environment of that run.
  get ignorePaths() {
    return firebaseClientIgnorePaths(process.env);
  },
};
module.exports.firebaseClientIgnorePaths = firebaseClientIgnorePaths;
