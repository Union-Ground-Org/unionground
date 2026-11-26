const PULSE_OPENING_PREFIX = "ug.pulse.opening.";
const DEFAULT = Object.freeze({ opening: "week", setupComplete: false });

export function pulseOpeningKey(userID) {
  if (typeof userID !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userID)) {
    throw new Error("Open your signed-in account first.");
  }
  return `${PULSE_OPENING_PREFIX}${userID.toLowerCase()}`;
}

export function normalizePulseOpening(value) {
  if (value === null) return DEFAULT;
  try {
    const row = JSON.parse(value);
    return row?.version === 1 && ["week", "charts"].includes(row.opening) && row.setupComplete === true
      ? { opening: row.opening, setupComplete: true } : DEFAULT;
  } catch { return DEFAULT; }
}

// The native adapter supplies SecureStore. Only this account's preference is
// stored: no chart data, activity or authorization state.
export function createPulseOpeningStore(storage) {
  return {
    async load(userID) {
      return normalizePulseOpening(await storage.getItem(pulseOpeningKey(userID)));
    },
    async save(userID, opening) {
      if (!["week", "charts"].includes(opening)) throw new Error("Choose how Pulse should open.");
      const key = pulseOpeningKey(userID);
      const value = JSON.stringify({ version: 1, opening, setupComplete: true });
      await storage.setItem(key, value);
      if (await storage.getItem(key) !== value) throw new Error("Your Pulse choice could not be saved.");
      return normalizePulseOpening(value);
    },
  };
}
