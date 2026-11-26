// App-level R8 keep rules for the Android release build. Expo's Kotlin
// CodedException derives its code from the class's simple name
// (UnableToDeleteException -> ERR_UNABLE_TO_DELETE), and the app classifies
// native failures by those codes (src/services/lifecycleDiagnostics.ts). R8
// renames or merges the classes, so their codes would change. Keeping the
// names only, not the classes, still lets R8 drop the ones the app never uses.
// The rules are inert while minify is off.
const fs = require('node:fs');
const path = require('node:path');
const { withDangerousMod } = require('expo/config-plugins');

const MARKER = '# Union Ground: Expo error codes come from exception class names.';
const KEEP_RULES = `${MARKER}
-keepnames class * extends expo.modules.kotlin.exception.CodedException
`;

function addKeepRules(rules) {
  if (rules.includes(MARKER)) {
    if (!rules.includes(KEEP_RULES)) {
      throw new Error('Android keep rules: existing rules differ from the maintained block.');
    }
    return rules;
  }
  return `${rules.replace(/\n*$/, '\n')}\n${KEEP_RULES}`;
}

function withAndroidKeepRules(config) {
  return withDangerousMod(config, ['android', async (modConfig) => {
    const rulesFile = path.join(modConfig.modRequest.platformProjectRoot, 'app', 'proguard-rules.pro');
    const rules = fs.readFileSync(rulesFile, 'utf8');
    const kept = addKeepRules(rules);
    if (kept !== rules) fs.writeFileSync(rulesFile, kept);
    return modConfig;
  }]);
}

module.exports = withAndroidKeepRules;
module.exports.addKeepRules = addKeepRules;
module.exports.KEEP_RULES = KEEP_RULES;
