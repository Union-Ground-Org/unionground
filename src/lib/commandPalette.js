export function normalizeCommandText(value) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase();
}

export function commandMatches(command, query) {
  const needle = normalizeCommandText(query).trim();
  if (!needle) return true;
  return [command.label, ...(command.keywords ?? [])]
    .some((value) => normalizeCommandText(value).includes(needle));
}

export function isEditableShortcutTarget(target) {
  if (!target) return false;
  if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable) return true;
  return Boolean(target.closest?.("[contenteditable='true']"));
}

export function railShortcutIndex(event) {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return -1;
  if (event.key === "0") return 9;
  const number = Number(event.key);
  return Number.isInteger(number) && number >= 1 && number <= 9 ? number - 1 : -1;
}

// The palette's click entry points (the desktop rail and the alternate
// shell) open it through this event, so it is reachable with Keyboard
// shortcuts off (REQ-UG-KEYBOARD-SHORTCUTS-OFF-BY-DEFAULT-20261103).
export const OPEN_COMMAND_PALETTE_EVENT = "sg:open-command-palette";

export function openCommandPalette() {
  globalThis.dispatchEvent?.(new Event(OPEN_COMMAND_PALETTE_EVENT));
}

export function shortcutModifierLabel(platform = globalThis.navigator?.platform ?? "") {
  return /Mac|iPhone|iPad|iPod/i.test(platform) ? "⌘" : "Ctrl";
}
