// REQ-UG-TIME-ZONES-PER-GROUP-20261122 (#9446), part 4a: the
// time_zone columns of member cases and step deadlines arrive with their
// migration, which may apply after this build is live. A database without the
// column yet answers 42703 or PGRST204 naming it; the read then runs once
// without it, and every deadline counts on New York's zone as before. The
// native app keeps the same rule in apps/mobile/src/lib/timeZoneColumn.ts.

export function missingTimeZoneColumn(error) {
  return ["42703", "PGRST204"].includes(error?.code)
    && /\btime_zone\b/.test([error.message, error.details, error.hint].join(" "));
}

export function withoutTimeZoneColumn(columns) {
  return columns.split(",").filter((column) => column !== "time_zone").join(",");
}
