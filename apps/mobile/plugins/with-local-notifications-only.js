const { withEntitlementsPlist } = require("expo/config-plugins");

// The public beta schedules reminders on device and does not register for
// remote push. Expo Notifications adds this entitlement by default, so remove
// it after Expo's plugin runs rather than requesting an unused Apple service.
module.exports = function withLocalNotificationsOnly(config) {
  return withEntitlementsPlist(config, (nativeConfig) => {
    delete nativeConfig.modResults["aps-environment"];
    return nativeConfig;
  });
};
