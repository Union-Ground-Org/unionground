// Release calendar for a stepped-up platform operator
// (REQ-UG-RELEASE-CALENDAR-SCREEN-WITH-RELEASE-AND-HOLD-BUTTONS-20261117, #9039).
//
// The screen reads every switch with a release time, the database clock and
// the newest release audit rows through
// public.get_platform_setting_release_calendar(), which refuses anyone who is
// not a stepped-up platform operator. Release and Hold never call a database
// from the browser: they go to the server route api/release-calendar.js,
// which changes Production and then SAMPLE together, as
// scripts/release-calendar.mjs does
// (REQ-UG-RELEASE-CALENDAR-SCREEN-RELEASE-AND-HOLD-CHANGE-BOTH-DATABASES-20261117,
// #9077; docs/contracts/staged-feature-releases.md). The screen sends only the
// switch, Release or Hold, and the reason: no site and no time.

export const RELEASE_CALENDAR_RPCS = Object.freeze({
  read: "get_platform_setting_release_calendar",
});

const RELEASE_CALENDAR_CHANGE_PATH = "/api/release-calendar";
const RELEASE_CALENDAR_ACTIONS = Object.freeze(["release", "hold"]);
export const RELEASE_REASON_MAX = 500;

// The reason as the route accepts it (api/release-calendar.js parseChange):
// one line with no control characters. A typed or pasted line break or tab
// becomes a space, so the box never holds a reason the route refuses.
export function oneLineReason(value) {
  return String(value ?? "").replace(/\p{Cc}+/gu, " ");
}

// The route's answer as one outcome the screen words:
//   saved       both sites read back the same
//   partial     both sites read back, and they differ: Production changed and
//               SAMPLE did not (press again, or sync)
//   unconfirmed a site could not be read back, so the screen cannot say
//               whether SAMPLE changed (press again, or check with the command)
//   differs     the sites already differed; nothing was changed
//   invalid     the route refused the request itself; nothing was changed
//   uncertain   no answer the screen can read (the request failed in transit,
//               a 5xx such as production-unavailable after the Production
//               write, or an unreadable 200): Production may have changed, so
//               the screen keeps the press-again button
//   sampleNeverHeld, refused, unavailable, error (a refusal before any write)
const readBack = (site) => typeof site?.after === "string";
const siteAnswer = (site) => site && typeof site === "object" && !Array.isArray(site)
  && (site.after === null || readBack(site));
function changeOutcome(status, body) {
  if (status === 200) {
    // Only the route's explicit comparison and both read-backs can confirm a
    // save. An unrelated JSON object or array is still an unreadable answer.
    if (!body || typeof body !== "object" || Array.isArray(body)
      || typeof body.differs !== "boolean" || !siteAnswer(body.production) || !siteAnswer(body.sample)) return "uncertain";
    if (!readBack(body.production) || !readBack(body.sample)) return body.differs ? "unconfirmed" : "uncertain";
    return body.differs ? "partial" : "saved";
  }
  const error = typeof body?.error === "string" ? body.error : "";
  if (status === 400) return "invalid";
  if (status === 409 && error === "sites-differ") return "differs";
  if (status === 409 && error === "sample-never-held") return "sampleNeverHeld";
  if (status === 401 || status === 403) return "refused";
  if (status === 404 || error === "sample-not-configured" || error === "not-configured") return "unavailable";
  if (status >= 500) return "uncertain";
  return "error";
}

// "held_no_date" | "dated" | "released" for one switch row.
export function releaseState(row) {
  if (row?.releaseAt === "infinity") return "held_no_date";
  return row?.held ? "dated" : "released";
}

function errorCode(error) {
  return String(error?.code ?? "");
}

function isMissing(error) {
  const code = errorCode(error);
  return code === "PGRST202" || code === "42883" || /could not find the function/iu.test(String(error?.message ?? ""));
}

function shapeSwitch(row) {
  if (!row || typeof row.key !== "string" || typeof row.releaseAt !== "string") return null;
  return {
    key: row.key,
    label: typeof row.label === "string" && row.label.trim() ? row.label : row.key,
    releaseAt: row.releaseAt,
    held: row.held === true,
  };
}

function shapeChange(row, index) {
  if (!row || typeof row.key !== "string") return null;
  return {
    id: row.id ?? `${row.at ?? ""}-${index}`,
    at: row.at ?? null,
    key: row.key,
    action: row.action === "shift" ? "shift" : "set",
    previousReleaseAt: row.previousReleaseAt ?? null,
    releaseAt: row.releaseAt ?? null,
    reason: typeof row.reason === "string" ? row.reason : "",
    byYou: row.byYou === true,
    actorName: typeof row.actorName === "string" ? row.actorName : null,
  };
}

export function createReleaseCalendarApi(client, { fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
  return {
    // Release or Hold one switch on Production and SAMPLE together.
    async change({ key, action, reason }) {
      if (!RELEASE_CALENDAR_ACTIONS.includes(action)) return { outcome: "error" };
      const token = await Promise.resolve()
        .then(() => client?.auth?.getSession?.())
        .then((session) => session?.data?.session?.access_token ?? "", () => ""); // swallow-ok: no session is answered as refused below
      if (!token) return { outcome: "refused" };
      let response;
      try {
        response = await fetchImpl(RELEASE_CALENDAR_CHANGE_PATH, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ key, action, reason: String(reason ?? "").trim() }),
        });
      } catch {
        // The request may have reached the route and committed on Production.
        return { outcome: "uncertain" };
      }
      const body = await response.json().catch(() => null); // swallow-ok: an unreadable answer is worded by its status
      return { outcome: changeOutcome(response.status, body), result: response.status === 200 ? body : null };
    },
    async read() {
      if (!client?.rpc) return { state: "unavailable" };
      const { data, error } = await client.rpc(RELEASE_CALENDAR_RPCS.read);
      if (error) {
        if (isMissing(error)) return { state: "unavailable" };
        if (errorCode(error) === "42501") return { state: "refused" };
        return { state: "error" };
      }
      if (!data || !Array.isArray(data.switches) || typeof data.now !== "string") return { state: "error" };
      const switches = data.switches.map(shapeSwitch).filter(Boolean);
      const changes = (Array.isArray(data.changes) ? data.changes : []).map(shapeChange).filter(Boolean);
      return { state: switches.length ? "ready" : "empty", now: data.now, switches, changes };
    },
  };
}
