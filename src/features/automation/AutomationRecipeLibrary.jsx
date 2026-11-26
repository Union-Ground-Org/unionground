import { useState } from "react";
import { useLang } from "../../lib/LanguageContext.jsx";
import { searchAutomationRecipes, getAutomationRecipeAvailability } from "./recipes.js";

export function AutomationPager({ page, total, pageSize = 6, onChange }) {
  const { t } = useLang();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages < 2) return null;
  return <nav className="automation-pages__pager" aria-label={t("automation.pager.label")}>
    <button className="xus-btn" type="button" disabled={page <= 1} onClick={() => onChange(page - 1)}>{t("automation.pager.prev")}</button>
    <span role="status">{t("automation.pager.status", { page, pages })}</span>
    <button className="xus-btn" type="button" disabled={page >= pages} onClick={() => onChange(page + 1)}>{t("automation.pager.next")}</button>
  </nav>;
}

// appointmentSupervision is the workspace's answer to "can this session
// supervise appointments?". Only an explicit false disables the appointment
// recipes: an appointment automation activated with that authority would match
// no appointment on any tick.
export function AutomationRecipeLibrary({ capabilities, appointmentSupervision = null, connected = true, disabledReason = null, onChoose, initialGroup = "all" }) {
  const { lang, t } = useLang();
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState(initialGroup);
  const [page, setPage] = useState(1);
  const results = searchAutomationRecipes({ query, group, page, pageSize: 6 });
  const local = (value) => value?.[lang] || value?.en || "";
  return <section className="automation-pages__body" aria-labelledby="automation-library-title">
    <div><h2 id="automation-library-title">{t("automation.recipe.library")}</h2>
      <p>{t("automation.library.editableNote")}</p>
      <p>{t("automation.library.chooseDoesNotRun")}</p></div>
    <div className="automation-pages__toolbar">
      <label className="xus-field">{t("automation.search.recipes")}<input type="search" className="xus-input" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} /></label>
      <label className="xus-field">{t("automation.workflow")}<select className="xus-input" value={group} onChange={(event) => { setGroup(event.target.value); setPage(1); }}>
        <option value="all">{t("automation.all.workflows")}</option><option value="tasks">{t("automation.tasks")}</option><option value="casework">{t("automation.casework")}</option><option value="appointments">{t("automation.appointments")}</option><option value="events">{t("automation.events")}</option>
      </select></label>
    </div>
    <p role="status">{t("automation.library.matchCount", { count: results.total })}</p>
    {results.total === 0 && <div><p>{t("automation.library.noRecipesMatch")}</p><button type="button" className="xus-btn" onClick={() => { setQuery(""); setGroup("all"); setPage(1); }}>{t("automation.clear.filters")}</button></div>}
    <ul className="automation-pages__list automation-pages__recipes">{results.items.map((recipe) => {
      const availability = getAutomationRecipeAvailability(recipe, capabilities, {});
      const supervisionRequired = recipe.group === "appointments" && appointmentSupervision === false;
      const unavailable = !connected || availability.status === "not_installed" || supervisionRequired;
      return <li key={recipe.id}>
        <h3>{local(recipe.title)}</h3><p>{local(recipe.description)}</p>
        <details><summary>{t("automation.conditions.safety")}</summary><p>{local(recipe.outcome)}</p><p>{local(recipe.conditionSummary)}</p><p>{local(recipe.destination)}</p><p>{local(recipe.safety)}</p>
          {recipe.prerequisites?.length > 0 && <ul>{recipe.prerequisites.map((item) => <li key={item.key}>{local(item.label)}</li>)}</ul>}
        </details>
        <div className="automation-pages__recipe-actions"><p id={`automation-recipe-status-${recipe.id}`}>{!connected ? disabledReason || t("automation.connected.authoring.installed") : supervisionRequired ? t("automation.library.appointmentSupervisionRequired") : unavailable ? t("automation.installed.organization") : availability.status === "missing_setup" ? t("automation.library.choosePeopleInDraft") : t("automation.available.customize")}</p>
          <button className="xus-btn xus-btn--go" type="button" aria-label={`${t("automation.use.recipe")}: ${local(recipe.title)}`} aria-describedby={unavailable ? `automation-recipe-status-${recipe.id}` : undefined} disabled={unavailable} onClick={() => onChoose(recipe)}>{t("automation.use.recipe")}</button></div>
      </li>;
    })}</ul>
    <AutomationPager page={results.page} total={results.total} onChange={setPage} />
  </section>;
}
