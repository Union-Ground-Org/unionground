import { useMemo, useSyncExternalStore } from "react";
import NumberFlow, { useIsSupported } from "@number-flow/react";

const MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const NUMBER = /[+-]?[\p{Decimal_Number}]+(?:[.,\u066b\u066c'’\u00a0\u202f ]+[\p{Decimal_Number}]+)*/u;

function subscribeMotion(listener) {
  const media = globalThis.window?.matchMedia?.(MOTION_QUERY);
  if (!media) return () => {};
  if (media.addEventListener) {
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }
  media.addListener?.(listener);
  return () => media.removeListener?.(listener);
}

function reducedMotion() {
  return globalThis.window?.matchMedia?.(MOTION_QUERY).matches ?? true;
}

// Stat values are already formatted by their callers. Only animate a number
// when Intl can reproduce its exact spelling; punctuation, precision and units
// are content, and must never change as a side effect of adding motion.
export function splitFlowValue(value, locales = "en-US") {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value);
  if (/[\r\n]/.test(text)) return null;
  const match = NUMBER.exec(text);
  if (!match) return null;
  const raw = match[0];
  const prefix = text.slice(0, match.index);
  const suffix = text.slice(match.index + raw.length);
  if (/^[eE][+-]?\d/.test(suffix)) return null;

  try {
    const formatter = new Intl.NumberFormat(locales);
    const symbols = formatter.formatToParts(12345.6);
    const decimal = symbols.find(({ type }) => type === "decimal")?.value;
    const group = symbols.find(({ type }) => type === "group")?.value;
    let normalized = raw;
    for (let digit = 0; digit <= 9; digit += 1) {
      const localized = new Intl.NumberFormat(locales, { useGrouping: false }).format(digit);
      normalized = normalized.replaceAll(localized, String(digit));
    }
    if (group) normalized = normalized.replaceAll(group, "");
    if (decimal) normalized = normalized.replaceAll(decimal, ".");
    if (!/^[+-]?\d+(?:\.\d+)?$/.test(normalized)) return null;
    const number = Number(normalized);
    if (!Number.isFinite(number) || Math.abs(number) > Number.MAX_SAFE_INTEGER) return null;
    const decimals = normalized.split(".")[1]?.length ?? 0;
    if (decimals > 20) return null;
    const integerDigits = normalized.replace(/^[+-]/, "").split(".")[0];
    const format = {
      useGrouping: Boolean(group && raw.includes(group)),
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
      ...(integerDigits.startsWith("0") && integerDigits.length > 1
        ? { minimumIntegerDigits: integerDigits.length } : {}),
      ...(raw.startsWith("+") ? { signDisplay: "always" } : {}),
    };
    if (new Intl.NumberFormat(locales, format).format(number) !== raw) return null;
    return { prefix, number, suffix, format, locales };
  } catch {
    return null;
  }
}

export function FlowValue({ value, className, locales = "en-US" }) {
  const supported = useIsSupported();
  const motionDisabled = useSyncExternalStore(subscribeMotion, reducedMotion, () => true);
  const parts = useMemo(() => splitFlowValue(value, locales), [value, locales]);
  if (!parts || !supported) return <span className={className}>{value}</span>;
  return (
    <NumberFlow
      className={className}
      value={parts.number}
      locales={parts.locales}
      format={parts.format}
      prefix={parts.prefix}
      suffix={parts.suffix}
      animated={!motionDisabled}
      respectMotionPreference
    />
  );
}
