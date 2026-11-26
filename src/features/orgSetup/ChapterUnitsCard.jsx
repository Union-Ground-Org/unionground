import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Building2, Landmark } from "lucide-react";
import { WorkspaceSection } from "../../components/WorkspacePages.jsx";
import { useLang } from "../../lib/LanguageContext.jsx";
import { PLANE_CARD_CLASS } from "../../lib/staffPlaneStyles.js";
import { LOCAL_PROFILE_FIELDS, UNIT_KINDS } from "./unitsApi.js";
import { announceChapterSetupChanged } from "../../lib/onboardingGuide.js";
import { BusyButton } from "../../components/BusyControls.jsx";
import { runBusyWrite } from "../../lib/busyWrite.js";

// REQ-UG-CHAPTER-UNITS-WORKSITES-AND-LOCAL-PROFILE-20261030: units
// and worksites inside a chapter (never sibling chapters) with headcounts, and
// the local's own profile, on the admin Organization page. Each card hides
// itself when its API is absent (the fixture demo) and says so when the read
// fails, rather than showing an empty list.

const EMPTY_UNIT = { id: null, chapterId: "", name: "", kind: "unit", headcount: "", headcountBadInput: false };
const MAX_UNIT_NAME_LENGTH = 120;
const MAX_HEADCOUNT = 1_000_000;

function headcountValue(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const number = Number(text);
  return Number.isInteger(number) && number >= 0 && number <= MAX_HEADCOUNT ? number : undefined;
}

// #7663: the server refuses (23514) moving or removing a unit an open
// steward invitation still reserves.
const reservedUnit = (failure) => failure?.code === "23514" && /reserved by an open steward invitation/u.test(String(failure?.message));

export function ChapterUnitsCard({ api, chapters = [], onNotice = () => {}, onUnitsChange = null }) {
  const { t, lang } = useLang();
  const formId = useId();
  const [units, setUnits] = useState(null);
  const [failed, setFailed] = useState(false);
  const [form, setForm] = useState(EMPTY_UNIT);
  const [busy, setBusy] = useState("");
  // Record 8435: a unit's save or removal is locked by that unit synchronously.
  const busyWriteRef = useRef(new Set());
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(null);
  const chapterList = useMemo(() => (Array.isArray(chapters) ? chapters : []).filter((chapter) => chapter?.id && chapter?.name), [chapters]);
  const enabled = Boolean(api?.listChapterUnits && api?.saveChapterUnit && api?.deleteChapterUnit);

  // The latest listener, read at call time, so a new callback each render
  // never re-runs the list read over a newer write.
  const unitsListener = useRef(onUnitsChange);
  useEffect(() => { unitsListener.current = onUnitsChange; }, [onUnitsChange]);
  const apply = useCallback((rows) => {
    setUnits(rows);
    unitsListener.current?.(rows);
  }, []);

  // A save or remove that answered first wins over a slower first read.
  const writes = useRef(0);
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    const before = writes.current;
    api.listChapterUnits().then((rows) => { if (live && writes.current === before) { setFailed(false); apply(rows); } })
      .catch(() => { if (live && writes.current === before) setFailed(true); });
    return () => { live = false; };
  }, [api, enabled, apply]);

  if (!enabled) return null;
  const requestedChapterId = form.chapterId || chapterList[0]?.id;
  const chapterId = chapterList.find((chapter) => chapter.id === requestedChapterId)?.id ?? "";
  const headcount = form.headcountBadInput ? undefined : headcountValue(form.headcount);
  const nameLength = form.name.trim().length;
  const maxHeadcountLabel = MAX_HEADCOUNT.toLocaleString(lang);
  const blockedReason = !chapterId ? t("units.chooseChapterFirst")
    : headcount === undefined ? t("units.headcountRule", { max: maxHeadcountLabel })
    : nameLength === 0 || nameLength > MAX_UNIT_NAME_LENGTH ? t("units.nameRule", { max: MAX_UNIT_NAME_LENGTH }) : null;

  function save(event) {
    event.preventDefault();
    if (busy) return undefined;
    if (blockedReason) return event.currentTarget.querySelector('button[type="submit"]')?.click();
    return runBusyWrite(busyWriteRef, `unit:${form.id || "new"}`, () => saveNow());
  }

  async function saveNow() {
    setBusy("save"); setError("");
    try {
      const rows = await api.saveChapterUnit({ id: form.id, chapterId, name: form.name, kind: form.kind, headcount });
      writes.current += 1;
      apply(rows);
      announceChapterSetupChanged();
      setForm({ ...EMPTY_UNIT, chapterId });
      onNotice(t("units.saved"));
    } catch (failure) {
      setError(failure?.code === "23505" ? "units.duplicate" : reservedUnit(failure) ? "units.reserved" : "units.failed");
    } finally {
      setBusy("");
    }
  }

  function remove(unit) {
    if (busy) return undefined;
    return runBusyWrite(busyWriteRef, `unit:${unit.id}`, () => removeNow(unit));
  }

  async function removeNow(unit) {
    setBusy(`remove:${unit.id}`); setError("");
    try {
      const rows = await api.deleteChapterUnit(unit.id);
      writes.current += 1;
      apply(rows);
      announceChapterSetupChanged();
      setConfirming(null);
      if (form.id === unit.id) setForm({ ...EMPTY_UNIT, chapterId: unit.chapterId });
      onNotice(t("units.removed"));
    } catch (failure) {
      setError(reservedUnit(failure) ? "units.reserved" : "units.failed");
    } finally {
      setBusy("");
    }
  }

  const total = (units ?? []).reduce((sum, unit) => sum + (unit.headcount ?? 0), 0);
  return <WorkspaceSection name="admin-organization"><article id="admin-units" className={`${PLANE_CARD_CLASS} xus-card role-section-target`} tabIndex="-1">
    <header className="xus-cardhead">
      <span className="xus-glyph" aria-hidden="true"><Building2 size={18} /></span>
      <div className="xus-cardhead__copy"><h2 className="xus-cardttl">{t("units.title")}</h2><p className="xus-cardsub">{t("units.sub")}</p></div>
    </header>
    <div className="xus-cardbody xus-form">
      {failed && <p className="xus-note xus-note--error" role="alert">{t("units.unavailable")}</p>}
      {units && units.length === 0 && <p className="xus-note">{t("units.empty")}</p>}
      {units && units.length > 0 && <>
        {chapterList.filter((chapter) => units.some((unit) => unit.chapterId === chapter.id)).map((chapter) => <section key={chapter.id} aria-label={chapter.name}>
          <h3 className="xus-etitle">{chapter.name}</h3>
          {units.filter((unit) => unit.chapterId === chapter.id).map((unit) => <div className="xus-row" key={unit.id}>
            <div className="xus-rowmain">
              <strong className="xus-name">{unit.name}</strong>
              <span className="xus-chiprow">
                <span className="xus-chip xus-chip--note">{t(`units.kind.${unit.kind}`)}</span>
                <span className="xus-chip xus-chip--note">{unit.headcount === null ? t("units.headcountUnknown") : t("units.headcountValue", { count: unit.headcount })}</span>
              </span>
            </div>
            <span className="xus-rowact">
              <BusyButton type="button" className="xus-btn" pending={Boolean(busy)} aria-label={t("units.edit", { name: unit.name })}
                onClick={() => setForm({ ...EMPTY_UNIT, id: unit.id, chapterId: unit.chapterId, name: unit.name, kind: unit.kind, headcount: unit.headcount ?? "" })}>{t("units.editShort")}</BusyButton>
              <BusyButton type="button" className="xus-btn" pending={Boolean(busy)} aria-label={t("units.remove", { name: unit.name })} onClick={() => setConfirming(unit.id)}>{t("units.removeShort")}</BusyButton>
            </span>
            {confirming === unit.id && <div role="group" aria-label={t("units.removeConfirm", { name: unit.name })} className="xus-confirm">
              <p className="xus-note">{t("units.removeConfirm", { name: unit.name })}</p>
              <div className="xus-btnrow">
                <BusyButton type="button" className="xus-btn xus-btn--danger" pending={Boolean(busy)} onClick={() => remove(unit)}>{t("units.removeYes")}</BusyButton>
                <BusyButton type="button" className="xus-btn" pending={Boolean(busy)} onClick={() => setConfirming(null)}>{t("units.cancel")}</BusyButton>
              </div>
            </div>}
          </div>)}
        </section>)}
        <p className="xus-meta">{t("units.total", { count: total })}</p>
      </>}
      {chapterList.length > 0 && <form className="xus-form" aria-labelledby={`${formId}-title`} onSubmit={save}>
        <h3 className="xus-etitle" id={`${formId}-title`}>{form.id ? t("units.editTitle") : t("units.add")}</h3>
        <label className="xus-field"><span>{t("units.chapter")}</span>
          <select className="xus-input" value={chapterId} onChange={(event) => setForm((current) => ({ ...current, chapterId: event.target.value }))}>
            {!chapterId && <option value="" disabled>{t("units.chooseChapterFirst")}</option>}
            {chapterList.map((chapter) => <option key={chapter.id} value={chapter.id}>{chapter.name}</option>)}
          </select>
        </label>
        <label className="xus-field"><span>{t("units.name")}</span>
          <input className="xus-input" required maxLength={MAX_UNIT_NAME_LENGTH} value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} />
        </label>
        <label className="xus-field"><span>{t("units.kind")}</span>
          <select className="xus-input" value={form.kind} onChange={(event) => setForm((current) => ({ ...current, kind: event.target.value }))}>
            {UNIT_KINDS.map((kind) => <option key={kind} value={kind}>{t(`units.kind.${kind}`)}</option>)}
          </select>
        </label>
        <label className="xus-field"><span>{t("units.headcount")}</span>
          <input className="xus-input" type="number" inputMode="numeric" min="0" max={MAX_HEADCOUNT} step="1" value={form.headcount}
            aria-invalid={headcount === undefined || undefined} aria-describedby={`${formId}-headcount`}
            onInput={(event) => {
              const { value, validity } = event.currentTarget;
              const headcountBadInput = validity.badInput;
              setForm((current) => ({ ...current, headcount: value, headcountBadInput }));
            }} />
        </label>
        <small className="xus-note" id={`${formId}-headcount`}>{t("units.headcountHelp")} {t("units.headcountRule", { max: maxHeadcountLabel })}</small>
        {error && <p className="xus-note xus-note--error" role="alert">{t(error)}</p>}
        <div className="xus-btnrow">
          <BusyButton type="submit" className="xus-btn xus-btn--go" pending={Boolean(busy)} disabled={Boolean(blockedReason)} disabledReason={blockedReason}>{busy === "save" ? t("auth.working") : t("units.save")}</BusyButton>
          {form.id && <BusyButton type="button" className="xus-btn" pending={Boolean(busy)} onClick={() => setForm({ ...EMPTY_UNIT, chapterId })}>{t("units.cancel")}</BusyButton>}
        </div>
      </form>}
    </div>
  </article></WorkspaceSection>;
}

function profileDraft(profile) {
  return Object.fromEntries(LOCAL_PROFILE_FIELDS.map((key) => [key, profile?.[key] ?? ""]));
}

const PROFILE_INPUTS = {
  officeAddress: { multiline: true, maxLength: 300 },
  phone: { type: "tel", maxLength: 40 },
  officeHours: { maxLength: 200 },
  employer: { maxLength: 200 },
  contractStartsOn: { type: "date" },
  contractEndsOn: { type: "date" },
  boardSchedule: { multiline: true, maxLength: 300 },
  timeZone: { maxLength: 64, list: true },
};

function timeZoneNames() {
  try { return typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : []; } catch { return []; }
}

// `units`, when given, is the Units card's latest list, so both cards on the
// page show the same headcounts after an edit.
export function LocalProfileCard({ api, units: currentUnits = null, onNotice = () => {} }) {
  const { t } = useLang();
  const zonesId = useId();
  const [profile, setProfile] = useState(null);
  const [failed, setFailed] = useState(false);
  const [draft, setDraft] = useState(() => profileDraft(null));
  const [busy, setBusy] = useState(false);
  // Record 8435: the profile save is locked synchronously, before busy commits.
  const busyWriteRef = useRef(new Set());
  const [error, setError] = useState(false);
  const zones = useMemo(timeZoneNames, []);
  const enabled = Boolean(api?.loadLocalProfile);

  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    api.loadLocalProfile().then((next) => {
      if (!live) return;
      setFailed(!next);
      setProfile(next);
      setDraft(profileDraft(next));
    }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [api, enabled]);

  if (!enabled) return null;
  const contractOrderInvalid = Boolean(draft.contractStartsOn && draft.contractEndsOn && draft.contractEndsOn < draft.contractStartsOn);

  function save(event) {
    event.preventDefault();
    if (busy || contractOrderInvalid || !api.saveLocalProfile) return undefined;
    return runBusyWrite(busyWriteRef, "local-profile", () => saveNow());
  }

  async function saveNow() {
    setBusy(true); setError(false);
    try {
      const next = await api.saveLocalProfile(draft);
      setProfile(next);
      setDraft(profileDraft(next));
      onNotice(t("localProfile.saved"));
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  const units = Array.isArray(currentUnits) ? currentUnits : profile?.units ?? [];
  return <WorkspaceSection name="admin-organization"><article id="admin-local-profile" className={`${PLANE_CARD_CLASS} xus-card role-section-target`} tabIndex="-1">
    <header className="xus-cardhead">
      <span className="xus-glyph" aria-hidden="true"><Landmark size={18} /></span>
      <div className="xus-cardhead__copy"><h2 className="xus-cardttl">{t("localProfile.title")}</h2><p className="xus-cardsub">{t("localProfile.sub")}</p></div>
    </header>
    <div className="xus-cardbody xus-form">
      {failed && <p className="xus-note xus-note--error" role="alert">{t("localProfile.unavailable")}</p>}
      {profile && (profile.canEdit && api.saveLocalProfile ? <form className="xus-form" onSubmit={save}>
        {LOCAL_PROFILE_FIELDS.map((key) => {
          const spec = PROFILE_INPUTS[key];
          const common = {
            className: "xus-input",
            value: draft[key],
            maxLength: spec.maxLength,
            onChange: (event) => setDraft((current) => ({ ...current, [key]: event.target.value })),
          };
          return <label className="xus-field" key={key}><span>{t(`localProfile.${key}`)}</span>
            {spec.multiline ? <textarea {...common} rows={2} />
              : <input {...common} type={spec.type ?? "text"} list={spec.list && zones.length ? zonesId : undefined}
                aria-invalid={key === "contractEndsOn" && contractOrderInvalid ? true : undefined} />}
          </label>;
        })}
        {zones.length > 0 && <datalist id={zonesId}>{zones.map((zone) => <option key={zone} value={zone} />)}</datalist>}
        {contractOrderInvalid && <p className="xus-note xus-note--error" role="alert">{t("localProfile.contractOrder")}</p>}
        {error && <p className="xus-note xus-note--error" role="alert">{t("localProfile.failed")}</p>}
        <BusyButton type="submit" className="xus-btn xus-btn--go" pending={busy} disabled={contractOrderInvalid}>{busy ? t("auth.working") : t("localProfile.save")}</BusyButton>
      </form> : <dl className="xus-form">
        {LOCAL_PROFILE_FIELDS.map((key) => <div key={key}><dt>{t(`localProfile.${key}`)}</dt><dd>{profile[key] ?? t("localProfile.notSet")}</dd></div>)}
      </dl>)}
      {profile && <section aria-label={t("localProfile.unitHeadcounts")}>
        <h3 className="xus-etitle">{t("localProfile.unitHeadcounts")}</h3>
        {units.length === 0 ? <p className="xus-note">{t("units.empty")}</p> : <ul className="xus-list">
          {units.map((unit) => <li key={unit.id}>{unit.name} · {unit.chapterName} · {unit.headcount === null ? t("units.headcountUnknown") : t("units.headcountValue", { count: unit.headcount })}</li>)}
        </ul>}
      </section>}
    </div>
  </article></WorkspaceSection>;
}
