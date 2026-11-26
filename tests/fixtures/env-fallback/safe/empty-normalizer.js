// Normalizing an absent value to the empty string still fails closed, because
// the caller rejects an empty salt.
export const ledgerSalt = String(process.env.SMS_LEDGER_HASH_SALT || "").trim();
