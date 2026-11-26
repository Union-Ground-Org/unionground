const { withEntitlementsPlist } = require('expo/config-plugins');

// Apple Declared Age Range requires this entitlement on the App ID; without it
// requestAgeRange fails and the reader reports an unavailable signal.
// REQ-UG-MOBILE-STORE-AGE-SIGNAL-20261016.
module.exports = (config) => withEntitlementsPlist(config, (result) => {
  result.modResults['com.apple.developer.declared-age-range'] = true;
  return result;
});
