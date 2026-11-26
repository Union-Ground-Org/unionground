// `??` hides the same misconfiguration as `||`.
export const ledgerSalt = process.env.SMS_LEDGER_HASH_SALT ?? "placeholder-salt-value";
