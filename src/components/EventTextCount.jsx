export function EventTextCount({ t, count, max }) {
  const nearLimit = count >= Math.ceil(max * 0.8);
  return <span aria-live="polite">{nearLimit ? ` ${t("admin.eventTextCount", { count, max })}` : ""}</span>;
}
