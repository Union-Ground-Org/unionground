import { useEffect, useState } from "react";
import { workspaceHref } from "../../components/WorkspacePages.jsx";
import { useLang } from "../../lib/LanguageContext.jsx";
import { AUTOMATION_ROUTING_EVENT_KINDS, AUTOMATION_ROUTING_TARGETS, ROUTING_RULE_NAME_LIMITS, routingRuleNameIssue, validRoutingRuleDraft } from "./controlPlane.js";
import { AUTOMATION_TRIGGER_METADATA } from "./capabilities.js";
import { BusyButton } from "../../components/BusyControls.jsx";

// Restored old-app alert routing (de7df4b57c^: lib/notifications/alert-routing.ts,
// supabase/migrations/0529_alert_routing_rules.sql) and default recipes
// (lib/crm/automation-recipes.ts). Approvers change rules; every automation
// author can see them. The server enforces both switches.
const PRIORITY_FILTERS = Object.freeze({ any: null, high: ["high"], mediumHigh: ["high", "medium"] });
const EMPTY_RULE = Object.freeze({ name: "", eventKind: "overdue_task", routeTo: "source_owner", priorityFilter: "any" });

function priorityFilterKey(priorities) {
  if (!priorities) return "any";
  const sorted = [...priorities].sort().join(",");
  return sorted === "high" ? "high" : sorted === "high,medium" ? "mediumHigh" : "custom";
}

export function AutomationDefaultRecipes({ control, open }) {
  const { t } = useLang();
  const defaults = control.defaultRecipes;
  const recipes = control.definitions.filter((definition) => definition.recipeKey);
  if (!defaults) return null;
  return <section className="automation-pages__body" aria-labelledby="automation-default-recipes-title">
    <h2 id="automation-default-recipes-title">{t("automation.defaults.title")}</h2>
    <p>{t("automation.defaults.intro")}</p>
    <dl className="automation-pages__facts">
      <dt>{t("automation.defaults.switch")}</dt>
      <dd>{t(defaults.enabled ? "admin.automation.enabled" : "admin.automation.disabled")}</dd>
      <dt>{t("automation.defaults.routingSwitch")}</dt>
      <dd>{t(defaults.alertRoutingEnabled ? "admin.automation.enabled" : "admin.automation.disabled")}</dd>
    </dl>
    <p>{t("automation.defaults.switchHelp")} <a href={workspaceHref("/m/admin/configuration")}>{t("automation.defaults.switchLink")}</a></p>
    {defaults.enabled && !control.settings.enabled && <p className="automation-pages__disabled-reason" role="status">{t("automation.defaults.waitingOnMaster")}</p>}
    {recipes.length === 0
      ? <p>{t(defaults.enabled ? "automation.defaults.pending" : "automation.defaults.off")}</p>
      : <ul className="automation-pages__list">{recipes.map((definition) => <li key={definition.id}>
        <h3>{definition.name}</h3>
        <p>{t(`admin.automation.status.${definition.status}`)} · {t(`automation.defaults.recipe.${definition.recipeKey}`)}</p>
        <div><button className="xus-btn" onClick={() => open("definition", { definition: definition.id })}>{t("automation.defaults.openRecipe")}: {definition.name}</button></div>
      </li>)}</ul>}
  </section>;
}

export function AutomationRoutingRules({ api, session, act, busy, revision }) {
  const { t, lang } = useLang();
  const [state, setState] = useState({ status: "loading", data: null });
  const [draft, setDraft] = useState(EMPTY_RULE);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let current = true;
    if (!api.getRoutingRules) { setState({ status: "unavailable", data: null }); return undefined; }
    setState((previous) => ({ status: previous.data ? "ready" : "loading", data: previous.data }));
    Promise.resolve(api.getRoutingRules(session)).then((result) => {
      if (current) setState(result?.ok ? { status: "ready", data: result.data } : { status: "unavailable", data: null });
    }).catch(() => { if (current) setState({ status: "unavailable", data: null }); });
    return () => { current = false; };
  }, [api, session, revision, reload]);
  const eventLabel = (kind) => AUTOMATION_TRIGGER_METADATA.find((item) => item.id === kind)?.label[lang] || kind;
  async function write(work, notice) {
    const result = await act(work, notice);
    setReload((value) => value + 1);
    return result;
  }
  const nextRule = { name: draft.name, eventKind: draft.eventKind, routeTo: draft.routeTo, enabled: true, priorities: PRIORITY_FILTERS[draft.priorityFilter] ?? null };
  const canSaveRule = validRoutingRuleDraft(nextRule);
  const nameIssue = routingRuleNameIssue(nextRule.name.trim());
  const nameReason = nameIssue === "length"
    ? t("automation.routing.nameLength", ROUTING_RULE_NAME_LIMITS)
    : nameIssue === "characters" ? t("automation.routing.nameCharacters") : null;
  const data = state.data;
  return <section className="automation-pages__body" aria-labelledby="automation-routing-title">
    <h2 id="automation-routing-title">{t("automation.routing.title")}</h2>
    <p>{t("automation.routing.intro")}</p>
    {state.status === "loading" && <p className="automation-pages__loading" role="status">{t("automation.pages.loadingRecords")}</p>}
    {state.status === "unavailable" && <p role="status">{t("automation.pages.recordUnavailable")}</p>}
    {data && <>
      {!data.enabled && <p className="automation-pages__disabled-reason" role="status">{t("automation.routing.switchedOff")}</p>}
      {data.rules.length === 0 ? <p>{t("automation.routing.empty")}</p> : <ul className="automation-pages__list">{data.rules.map((rule) => {
        const filter = priorityFilterKey(rule.priorities);
        return <li key={rule.id}>
          <h3>{rule.name}</h3>
          <p>{eventLabel(rule.eventKind)} · {t(`automation.routing.target.${rule.routeTo}`)} · {t(`automation.routing.priority.${filter}`)}{rule.chapterId ? ` · ${t("automation.routing.oneChapter")}` : ""}</p>
          <p>{t(rule.enabled ? "admin.automation.enabled" : "admin.automation.disabled")}{rule.isDefault ? ` · ${t("automation.routing.defaultRule")}` : ""}</p>
          {data.canManage && <div className="xus-btnrow">
            <BusyButton className="xus-btn" pending={busy} onClick={() => void write(() => api.saveRoutingRule(session, { id: rule.id, name: rule.name, eventKind: rule.eventKind, routeTo: rule.routeTo, enabled: !rule.enabled, priorities: rule.priorities, chapterId: rule.chapterId, sortOrder: rule.sortOrder }), t(rule.enabled ? "automation.routing.disabledNotice" : "automation.routing.enabledNotice"))}>{t(rule.enabled ? "automation.routing.disable" : "automation.routing.enable")}: {rule.name}</BusyButton>
            <BusyButton className="xus-btn xus-btn--danger" pending={busy} onClick={() => { if (window.confirm(t("automation.routing.deleteConfirm", { name: rule.name }))) void write(() => api.deleteRoutingRule(session, rule.id), t("automation.routing.deletedNotice")); }}>{t("automation.routing.delete")}: {rule.name}</BusyButton>
          </div>}
        </li>;
      })}</ul>}
      {data.canManage ? <form onSubmit={(event) => { event.preventDefault(); if (!canSaveRule) return; void write(() => api.saveRoutingRule(session, nextRule), t("automation.routing.savedNotice")).then((saved) => { if (saved) setDraft(EMPTY_RULE); }); }}>
        <h3>{t("automation.routing.add")}</h3>
        <label className="xus-field">{t("automation.routing.name")}<input className="xus-input" value={draft.name} maxLength={ROUTING_RULE_NAME_LIMITS.max} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
        <label className="xus-field">{t("automation.routing.event")}<select className="xus-input" value={draft.eventKind} onChange={(event) => setDraft({ ...draft, eventKind: event.target.value })}>{AUTOMATION_ROUTING_EVENT_KINDS.map((kind) => <option key={kind} value={kind}>{eventLabel(kind)}</option>)}</select></label>
        <label className="xus-field">{t("automation.routing.notify")}<select className="xus-input" value={draft.routeTo} onChange={(event) => setDraft({ ...draft, routeTo: event.target.value })}>{AUTOMATION_ROUTING_TARGETS.map((target) => <option key={target} value={target}>{t(`automation.routing.target.${target}`)}</option>)}</select></label>
        <label className="xus-field">{t("automation.routing.priorityFilter")}<select className="xus-input" value={draft.priorityFilter} onChange={(event) => setDraft({ ...draft, priorityFilter: event.target.value })}>{Object.keys(PRIORITY_FILTERS).map((key) => <option key={key} value={key}>{t(`automation.routing.priority.${key}`)}</option>)}</select></label>
        <p>{t("automation.routing.visibilityNote")}</p>
        <BusyButton type="submit" className="xus-btn xus-btn--go" pending={busy} disabled={!canSaveRule} disabledReason={nameReason}>{t("automation.routing.save")}</BusyButton>
      </form> : <p role="status">{t("automation.routing.readOnly")}</p>}
    </>}
  </section>;
}
