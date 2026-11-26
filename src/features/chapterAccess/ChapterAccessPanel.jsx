import { useEffect, useMemo, useRef, useState } from "react";
import { useLang } from "../../lib/LanguageContext.jsx";
import { withLoadDeadline } from "../../lib/loadDeadline.js";
import { accessScope, createChapterAccessApi } from "../../lib/chapterAccessApi.js";
import { createUnitSettingsApi } from "../../lib/unitSettings.js";
import { UnitSettingsPanel } from "./UnitSettingsPanel.jsx";
import { announceChapterSetupChanged } from "../../lib/onboardingGuide.js";
import { CaseRowTopicChapterControl } from "./CaseRowTopicControls.jsx";
import "./chapterAccess.css";
import { BusyButton, BusyInput, BusySelect } from "../../components/BusyControls.jsx";
import { runBusyWrite } from "../../lib/busyWrite.js";
import { easternDay } from "../../lib/easternTime.js";

function Pager({ page, more, label, change, busy, t }) {
  return <nav className="institutional-actions" aria-label={label}>
    <BusyButton type="button" pending={busy} disabled={page === 0} onClick={() => change(page - 1)}>{t("access.previous")}</BusyButton>
    <BusyButton type="button" pending={busy} disabled={!more} onClick={() => change(page + 1)}>{t("access.next")}</BusyButton>
  </nav>;
}

function ScopeOptions({ workspace, t, chapter = true, unitsOnly = false }) {
  return <>
    <option value="">{t(unitsOnly ? "access.chooseUnit" : chapter ? "access.chapter" : "access.chooseScope")}</option>
    {workspace.units.map((unit) => <option key={unit.id} value={`unit:${unit.id}`}>{t("access.unit")}: {unit.name}</option>)}
    {!unitsOnly && workspace.committees.map((committee) => <option key={committee.id} value={`committee:${committee.id}`}>{t("access.committee")}: {committee.name}</option>)}
  </>;
}

function StewardUnitChoice({ name, units, busy, save, t }) {
  const [unitId, setUnitId] = useState("");
  return <form className="institutional-form" aria-label={t("access.assignUnitFor", { name })} onSubmit={(event) => {
    event.preventDefault();
    if (units.some((unit) => unit.id === unitId)) save(unitId);
  }}>
    <p>{t("access.unitRequired")}</p>
    <label>{t("access.unit")}<BusySelect value={unitId} required pending={busy} onChange={(event) => setUnitId(event.target.value)}>
      <option value="">{t("access.chooseUnit")}</option>
      {units.map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}
    </BusySelect></label>
    <BusyButton pending={busy} disabled={!unitId}>{t("access.assignUnit")}</BusyButton>
  </form>;
}

function CommitteeEditor({ committee, busy, save, cancel, t }) {
  return <form className="institutional-form" onSubmit={(event) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    save({ id: committee.id, name: form.get("name"), purpose: form.get("purpose"), startsOn: form.get("starts"), endsOn: form.get("ends"), grievanceAccess: form.has("grievances") });
  }}>
    <h4>{t(committee.id ? "access.editCommittee" : "access.newCommittee")}</h4>
    <label>{t("access.name")}<input name="name" required maxLength={120} defaultValue={committee.name} /></label>
    <label>{t("access.purpose")}<textarea name="purpose" required maxLength={2000} defaultValue={committee.purpose} /></label>
    <label>{t("access.starts")}<input name="starts" type="date" required defaultValue={committee.starts_on} /></label>
    <label>{t("access.ends")}<input name="ends" type="date" defaultValue={committee.ends_on} /></label>
    <label className="institutional-check"><input name="grievances" type="checkbox" defaultChecked={committee.grievance_access} />{t("access.committeeGrievances")}</label>
    <div className="institutional-actions"><BusyButton pending={busy}>{t("access.save")}</BusyButton><BusyButton type="button" pending={busy} onClick={cancel}>{t("access.cancel")}</BusyButton></div>
  </form>;
}

export function ChapterAccessPanel({ client, chapterId }) {
  const { t } = useLang();
  const api = useMemo(() => createChapterAccessApi(client), [client]);
  const settingsApi = useMemo(() => createUnitSettingsApi(client), [client]);
  const [pages, setPages] = useState({ members: 0, units: 0, committees: 0 });
  const [query, setQuery] = useState("");
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState({ phase: "loading", workspace: null });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [committee, setCommittee] = useState(null);
  const [role, setRole] = useState("secretary");
  const generation = useRef(0);
  // Synchronous write lock (#8435): refuses a second activation before React
  // commits `busy`. A new chapter or page starts with its own lock set, as it
  // starts not busy.
  const busyWriteRef = useRef(new Set());
  useEffect(() => {
    const current = ++generation.current;
    busyWriteRef.current = new Set();
    setBusy(false); setCommittee(null);
    if (!api || !chapterId) return undefined;
    setState({ phase: "loading", workspace: null });
  // #9781: a first read that never answers ends in the panel's own
  // could-not-load line with its Try again after the shared deadline,
  // instead of "Loading access…" for as long as the page stays open.
    withLoadDeadline(() => api.load(chapterId, pages, query)).then((workspace) => {
      if (current === generation.current) setState({ phase: "ready", workspace });
    }).catch(() => { if (current === generation.current) setState({ phase: "error", workspace: null }); });
    return () => { generation.current += 1; };
  }, [api, chapterId, pages, query, revision]);

  function run(operation) {
    return runBusyWrite(busyWriteRef, "access", async () => {
      const current = generation.current;
      setBusy(true); setNotice("");
      try {
        await operation();
        // The staff guide's units step counts stewards placed in units.
        announceChapterSetupChanged();
        if (current === generation.current) { setNotice("access.saved"); setRevision((value) => value + 1); }
      } catch { if (current === generation.current) setNotice("access.saveError"); }
      finally { if (current === generation.current) setBusy(false); }
    });
  }
  if (!api || !chapterId) return null;
  const workspace = state.workspace;
  const memberNames = (scope) => workspace.members.filter((member) => scope.members?.includes(member.id)).map((member) => member.name).join(", ") || t("access.empty");
  const page = (group, value) => setPages((current) => ({ ...current, [group]: value }));
  return <section className="institutional-section chapter-access" aria-label={t("access.title")}>
    <h3>{t("access.title")}</h3>
    {notice && <p role={["access.saveError", "access.unitRequired"].includes(notice) ? "alert" : "status"}>{t(notice)}</p>}
    {state.phase === "loading" && <p role="status">{t("access.loading")}</p>}
    {state.phase === "error" && <div role="alert"><p>{t("access.error")}</p><button type="button" onClick={() => setRevision((value) => value + 1)}>{t("access.retry")}</button></div>}
    {workspace && <>
      <form className="institutional-form" onSubmit={(event) => {
        event.preventDefault(); const form = new FormData(event.currentTarget);
        void run(() => api.setPolicy(chapterId, form.has("grievances"), form.get("breadth")));
      }}>
        <h4>{t("access.policy")}</h4>
        <label className="institutional-check"><input type="checkbox" name="grievances" defaultChecked={workspace.policy.steward_grievances} />{t("access.stewardGrievances")}</label>
        <p>{t("access.assignedHelp")}</p>
        <label>{t("access.breadth")}<select name="breadth" defaultValue={workspace.policy.steward_breadth}><option value="chapter">{t("access.chapterBreadth")}</option><option value="local">{t("access.local")}</option></select></label>
        <BusyButton pending={busy}>{t("access.save")}</BusyButton>
      </form>
      <CaseRowTopicChapterControl api={api} chapterId={chapterId} />
      <UnitSettingsPanel api={settingsApi} chapterId={chapterId} />
      <h4>{t("access.capabilities")}</h4>
      {workspace.roles.map((item) => {
        const enabled = workspace.settings.find((setting) => setting.role === item.role && setting.capability === item.capability)?.enabled ?? true;
        return <label className="institutional-check" key={`${item.role}:${item.capability}`}><BusyInput type="checkbox" checked={enabled} pending={busy} onChange={(event) => void run(() => api.setCapability(chapterId, item.role, item.capability, event.target.checked))} />{t(`access.role.${item.role}`)} · {t(`access.cap.${item.capability}`)}</label>;
      })}
      <h4>{t("access.members")}</h4>
      <form className="institutional-form" onSubmit={(event) => { event.preventDefault(); setQuery(new FormData(event.currentTarget).get("query")); page("members", 0); }}>
        <label>{t("access.search")}<input name="query" maxLength={120} defaultValue={query} /></label><BusyButton pending={busy}>{t("access.search")}</BusyButton>
      </form>
      {!workspace.members.length && <p>{t("access.empty")}</p>}
      <form className="institutional-form" onSubmit={(event) => {
        event.preventDefault(); const form = new FormData(event.currentTarget);
        if (role === "steward" && !accessScope(form.get("scope")).unitId) { setNotice("access.unitRequired"); return; }
        void run(() => api.setRole(chapterId, form.get("member"), role, accessScope(form.get("scope")), true));
      }}>
        <label>{t("access.member")}<select name="member" required>{workspace.members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
        <label>{t("access.role")}<select name="role" value={role} onChange={(event) => setRole(event.target.value)}>{workspace.grantableRoles.map((value) => <option key={value} value={value}>{t(`access.role.${value}`)}</option>)}</select></label>
        <label>{t("access.scope")}<select key={role} name="scope" required={role === "steward"} disabled={role === "admin" || role === "vp" || role === "treasurer"}><ScopeOptions workspace={workspace} t={t} unitsOnly={role === "steward"} /></select></label>
        <BusyButton pending={busy} disabled={!workspace.members.length}>{t("access.grant")}</BusyButton>
      </form>
      <ul>{workspace.grants.map((grant) => <li key={`${grant.userId}:${grant.role}`}>
        {grant.name || workspace.members.find((member) => member.id === grant.userId)?.name || t("access.member")} · {t(`access.role.${grant.role}`)} · {grant.legacyChapterCoverage ? t("access.legacyCoverage") : <>{t(grant.unitId ? "access.unit" : grant.committeeId ? "access.committee" : "access.chapter")}{grant.scopeName && `: ${grant.scopeName}`}</>}
        {!grant.organizationGrantBacked && workspace.grantableRoles.includes(grant.role) && <BusyButton type="button" pending={busy} onClick={() => void run(() => api.setRole(chapterId, grant.userId, grant.role, {}, false))}>{t("access.revoke")}</BusyButton>}
        {grant.role === "steward" && <StewardUnitChoice
          key={`${grant.unitId}:${grant.legacyChapterCoverage === true}`}
          name={grant.name || workspace.members.find((member) => member.id === grant.userId)?.name || t("access.member")}
          units={workspace.units} busy={busy} t={t}
          save={(unitId) => void run(() => api.setRole(chapterId, grant.userId, "steward", { unitId }, true))}
        />}
      </li>)}</ul>
      <Pager label={t("access.members")} page={pages.members} more={workspace.hasMoreMembers} change={(value) => page("members", value)} busy={busy} t={t} />
      <h4>{t("access.membership")}</h4>
      <form className="institutional-form" onSubmit={(event) => {
        event.preventDefault(); const form = new FormData(event.currentTarget); const selected = form.get("scope");
        void run(() => api.setMember(chapterId, form.get("member"), accessScope(selected), form.get("action") === "add"));
      }}>
        <label>{t("access.member")}<select name="member" required>{workspace.members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
        <label>{t("access.scope")}<select name="scope" required><ScopeOptions workspace={workspace} t={t} chapter={false} /></select></label>
        <label>{t("access.membership")}<select name="action"><option value="add">{t("access.addMember")}</option><option value="remove">{t("access.removeMember")}</option></select></label>
        <BusyButton pending={busy} disabled={!workspace.members.length}>{t("access.save")}</BusyButton>
      </form>
      <h4>{t("access.units")}</h4><ul>{workspace.units.map((unit) => <li key={unit.id}>{unit.name}<span>{t("access.membersThisPage")}: {memberNames(unit)}</span></li>)}</ul>
      <Pager label={t("access.units")} page={pages.units} more={workspace.hasMoreUnits} change={(value) => page("units", value)} busy={busy} t={t} />
      <h4>{t("access.committees")}</h4>
      <BusyButton type="button" pending={busy} onClick={() => setCommittee({ name: "", purpose: "", starts_on: easternDay(new Date()), ends_on: "", grievance_access: false })}>{t("access.newCommittee")}</BusyButton>
      <ul>{workspace.committees.map((item) => <li key={item.id}>{item.name} · {item.purpose}<span>{t("access.membersThisPage")}: {memberNames(item)}</span><BusyButton type="button" pending={busy} onClick={() => setCommittee(item)}>{t("access.editCommittee")}</BusyButton></li>)}</ul>
      <Pager label={t("access.committees")} page={pages.committees} more={workspace.hasMoreCommittees} change={(value) => page("committees", value)} busy={busy} t={t} />
      {committee && <CommitteeEditor key={committee.id || "new"} committee={committee} busy={busy} t={t} cancel={() => setCommittee(null)} save={(fields) => void run(() => api.saveCommittee(chapterId, fields))} />}
    </>}
  </section>;
}
