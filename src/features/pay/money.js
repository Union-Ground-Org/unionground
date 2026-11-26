// Integer-cent money helpers for MI1 pay tools. Domain math stays
// deterministic and never reads the system clock.

export const MAX_CONVERTIBLE_DOLLARS = 1_000_000;

export function dollarsToCents(dollars) {
  if (typeof dollars !== "number" || !Number.isFinite(dollars)) return null;
  if (Math.abs(dollars) > MAX_CONVERTIBLE_DOLLARS) return null;
  return Math.round(dollars * 100);
}

export function centsToDollars(cents) {
  if (!Number.isInteger(cents)) return null;
  return cents / 100;
}

export function formatUsdFromCents(cents) {
  if (!Number.isInteger(cents)) return null;
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

export function multiplyCents(cents, factor) {
  if (!Number.isInteger(cents) || typeof factor !== "number" || !Number.isFinite(factor)) {
    return null;
  }
  if (factor < 0 || factor > 100) return null;
  return Math.round(cents * factor);
}

export function percentOfCents(cents, percent) {
  if (!Number.isInteger(cents) || typeof percent !== "number" || !Number.isFinite(percent)) {
    return null;
  }
  if (percent < 0 || percent > 100) return null;
  return Math.round((cents * percent) / 100);
}
