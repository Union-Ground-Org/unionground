export function csvCell(value) {
  const normalized = String(value ?? "").replace(/\r\n?/g, "\n");
  const spreadsheetSafe = /^[=+\-@\t\r\n]/.test(normalized) ? `'${normalized}` : normalized;
  return /[",\n]/.test(spreadsheetSafe) ? `"${spreadsheetSafe.replace(/"/g, '""')}"` : spreadsheetSafe;
}

export function buildDigitalActionParticipantCsv(payload = {}) {
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  const header = ["Action", "Participation", "Worker", "Email", "Campaign", "Joined at"];
  const body = rows.map((row) => [
    payload.actionTitle || "",
    row.participationKind || "",
    row.memberName || "",
    row.email || "",
    row.chapterName || "",
    row.joinedAt || "",
  ].map(csvCell).join(","));
  return `${header.map(csvCell).join(",")}\n${body.join("\n")}${body.length ? "\n" : ""}`;
}
