// Organization switches whose turning OFF weakens a security boundary need an
// explicit confirmation on the admin Feature switches & limits page. Union
// Ground's one entry, restricted PIN sessions, is left out of Union Ground
// with the member PIN itself, so none is due today.
const SETTING_OFF_CONFIRMATIONS = Object.freeze({});

// The catalogue key to confirm with, or null when no confirmation is due:
// only a boolean listed above, moving from on to off.
function settingChangeConfirmationKey(item, nextValue) {
  if (item?.kind !== "boolean" || nextValue !== false) return null;
  if (!Object.hasOwn(SETTING_OFF_CONFIRMATIONS, item.key)) return null;
  const current = item.value ?? item.defaultValue;
  return current === false ? null : SETTING_OFF_CONFIRMATIONS[item.key];
}

// True when the change may go ahead.
export function confirmSettingChange(t, item, nextValue, confirmImpl = globalThis.confirm) {
  const key = settingChangeConfirmationKey(item, nextValue);
  if (!key) return true;
  return typeof confirmImpl === "function" && confirmImpl(t(key)) === true;
}
