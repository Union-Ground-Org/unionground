import { useRoutedTab, RoutedTabLink } from "../components/WorkspacePages.jsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PLANE_CARD_CLASS } from "../lib/staffPlaneStyles.js";
import { useLang } from "../lib/LanguageContext.jsx";
import { formatGroupMoment } from "../lib/i18n/zonedDates.js";
import { runBusyWrite } from "../lib/busyWrite.js";
import { BusyButton, BusyRegion } from "./BusyControls.jsx";
import { FileSearch } from "lucide-react";

const COPY = {
  en: {
    title: "Evidence operations", sub: "Gather Field Notes evidence into packets, and apply actions to evidence, packets, cases, tasks and members. Actions applied here are logged.",
    notes: "Field Notes", actions: "Action Lab", loading: "Loading evidence operations…",
    unavailable: "Evidence operations are unavailable. Try again without assuming the workspace is empty.", retry: "Try again",
    sourceTitle: "Source title", annotation: "Explanation (optional)",
    addNote: "Add Field Notes evidence", sourceType: "Source type", provenance: "Source provenance", issue: "Issue key", body: "Evidence text", emptyNotes: "No Field Notes evidence yet.", include: "Include", exclude: "Exclude",
    packetTitle: "Packet title", packetContents: "Packet contents", draftPacket: "Draft packet", emptyPackets: "No evidence packets yet.", reviewReady: "Mark review ready",
    packetNeedsEvidence: "Include evidence for an issue before drafting a packet.", packetNeedsIssue: "Choose an issue for the packet.", packetNeedsTitle: "Enter a title for the packet.",
    action: "Action", target: "Applies to", note: "Note (optional)", execute: "Apply action", history: "Action history", emptyHistory: "No actions have been recorded yet.", actor: "Done by", executed: "Recorded",
    chooseAction: "Choose an action to apply.", noActionTargets: "Nothing is eligible for this action right now.", chooseActionTarget: "Choose a target for this action.",
    working: "Operation in progress…", saved: "Saved.", savedRefreshFailed: "Saved, but the refreshed view is unavailable. Reload before repeating the action.", failed: "The operation failed. Nothing was reported as saved.", before: "Before", after: "After", previous: "Previous", next: "Next", page: "Page {page}",
    actionLabels: { include: "Include evidence in packet", exclude: "Exclude evidence from packet", mark_review_ready: "Mark packet review ready", case_record_review: "Record issue review", task_record_review: "Record task review", member_record_review: "Record worker review" },
  },
  es: {
    title: "Operaciones de evidencia", sub: "Reúna evidencia de Notas de campo en paquetes y aplique acciones a evidencia, paquetes, casos, tareas y miembros. Las acciones aplicadas aquí quedan registradas.",
    notes: "Notas de campo", actions: "Laboratorio de acciones", loading: "Cargando operaciones de evidencia…",
    unavailable: "Las operaciones de evidencia no están disponibles. Inténtalo de nuevo sin asumir que el espacio está vacío.", retry: "Intentar de nuevo",
    sourceTitle: "Título de la fuente", annotation: "Explicación (opcional)",
    addNote: "Agregar evidencia de Notas de campo", sourceType: "Tipo de fuente", provenance: "Procedencia de la fuente", issue: "Clave del asunto", body: "Texto de evidencia", emptyNotes: "Aún no hay evidencia de Notas de campo.", include: "Incluir", exclude: "Excluir",
    packetTitle: "Título del paquete", packetContents: "Contenido del paquete", draftPacket: "Crear borrador", emptyPackets: "Aún no hay paquetes de evidencia.", reviewReady: "Marcar listo para revisión",
    packetNeedsEvidence: "Incluya evidencia de un asunto antes de crear un borrador.", packetNeedsIssue: "Elija un asunto para el paquete.", packetNeedsTitle: "Escriba un título para el paquete.",
    action: "Acción", target: "Se aplica a", note: "Nota (opcional)", execute: "Aplicar acción", history: "Historial de acciones", emptyHistory: "Aún no se han registrado acciones.", actor: "Hecho por", executed: "Registrado",
    chooseAction: "Elija una acción para aplicar.", noActionTargets: "No hay elementos disponibles para esta acción en este momento.", chooseActionTarget: "Elija un elemento para esta acción.",
    working: "Operación en curso…", saved: "Guardado.", savedRefreshFailed: "Se guardó, pero la vista actualizada no está disponible. Recarga antes de repetir la acción.", failed: "La operación falló. No se informó que se guardó nada.", before: "Antes", after: "Después", previous: "Anterior", next: "Siguiente", page: "Página {page}",
    actionLabels: { include: "Incluir evidencia en el paquete", exclude: "Excluir evidencia del paquete", mark_review_ready: "Marcar paquete listo para revisión", case_record_review: "Registrar revisión del asunto", task_record_review: "Registrar revisión de la tarea", member_record_review: "Registrar revisión del trabajador/a" },
  },
};

const SOURCE_TYPES = {
  en: { interview: "Interview", document: "Document", observation: "Observation", recording: "Recording", other: "Other" },
  es: { interview: "Entrevista", document: "Documento", observation: "Observación", recording: "Grabación", other: "Otro" },
};

const STATE_LABELS = {
  en: { draft: "Draft", included: "Included", excluded: "Excluded", review_ready: "Review ready", active: "Active" },
  es: { draft: "Borrador", included: "Incluido", excluded: "Excluido", review_ready: "Listo para revisión", active: "Activo" },
};

const EMPTY = { fieldNoteBlocks: [], packets: [], actions: [], actionTargets: [], history: [] };

function targetOptions(desk, targetKind, actionKey) {
  if (targetKind === "field_note_block") return desk.fieldNoteBlocks.filter((row) => row.packetState !== (actionKey === "include" ? "included" : "excluded")).map((row) => ({ id: row.id, label: `${row.issueKey} · ${row.sourceTitle}` }));
  if (targetKind === "field_note_packet") return desk.packets.filter((row) => row.status === "draft").map((row) => ({ id: row.id, label: row.title }));
  return desk.actionTargets.filter((row) => row.targetKind === targetKind).map((row) => ({ id: row.id, label: row.label }));
}

const TARGET_KIND_LABELS = {
  en: { field_note_block: "Field Notes evidence", field_note_packet: "Evidence packet", member_case: "Worker issue", chapter_task: "Campaign task", member_profile: "Worker profile" },
  es: { field_note_block: "Evidencia de Notas de campo", field_note_packet: "Paquete de evidencia", member_case: "Asunto de trabajador/a", chapter_task: "Tarea de la campaña", member_profile: "Perfil de trabajador/a" },
};

const STATE_FIELD_LABELS = {
  en: { status: "Status", packetState: "Packet state", blocked: "Blocked", membershipStatus: "Membership", reviewRecorded: "Review recorded", yes: "Yes", no: "No", none: "None" },
  es: { status: "Estado", packetState: "Estado del paquete", blocked: "Bloqueado", membershipStatus: "Membresía", reviewRecorded: "Revisión registrada", yes: "Sí", no: "No", none: "Ninguno" },
};

function targetKindLabel(lang, kind) {
  return (TARGET_KIND_LABELS[lang] ?? TARGET_KIND_LABELS.en)[kind] ?? kind;
}

// Audit states are small flat objects written by the evidence RPCs; read them as
// "Field: value" pairs in the reader's language instead of JSON.
function stateObjectLabel(value, labels, lang) {
  const fields = STATE_FIELD_LABELS[lang] ?? STATE_FIELD_LABELS.en;
  const parts = Object.entries(value ?? {}).map(([key, item]) => {
    let shown = item;
    if (item === null || item === undefined) shown = fields.none;
    else if (typeof item === "boolean") shown = item ? fields.yes : fields.no;
    else if (typeof item === "string") shown = labels[item] ?? item;
    else if (typeof item === "object") shown = stateObjectLabel(item, labels, lang);
    return `${fields[key] ?? key}: ${shown}`;
  });
  return parts.length ? parts.join(" · ") : fields.none;
}

// A missing stamp prints nothing (Main printed the 1970 epoch for null); an
// unreadable one keeps Main's fallback, the stored text.
function formatStamp(lang, value) {
  if (value === null || value === undefined || value === "") return "";
  return formatGroupMoment(value, lang) || String(value);
}

export function AdministrativeEvidencePanel({ api, scopeKey = api }) {
  // The host supplies the authorization scope separately from adapters that
  // can be rebuilt for a language change. Only a new scope retires drafts.
  const [scope, setScope] = useState({ key: scopeKey, version: 0 });
  if (scope.key !== scopeKey) setScope({ key: scopeKey, version: scope.version + 1 });
  return <AdministrativeEvidenceWorkspace key={scope.version} api={api} />;
}

function AdministrativeEvidenceWorkspace({ api }) {
  const { lang } = useLang();
  const c = COPY[lang] ?? COPY.en;
  const sourceTypes = SOURCE_TYPES[lang] ?? SOURCE_TYPES.en;
  const stateLabels = STATE_LABELS[lang] ?? STATE_LABELS.en;
  const [tab, setTab] = useRoutedTab("evidence", "notes");
  const [desk, setDesk] = useState(null);
  const [reloading, setReloading] = useState(false);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [page, setPage] = useState(0);
  const [fieldNote, setFieldNote] = useState({ sourceTitle: "", sourceType: "document", provenance: "", issueKey: "", body: "", annotation: "" });
  const [packet, setPacket] = useState({ issueKey: "", title: "" });
  const [action, setAction] = useState({ actionKey: "", targetKind: "", targetId: "", note: "" });
  const latestLoad = useRef(0);
  const active = useRef(true);
  const pendingFocusRef = useRef(null);
  const busyWriteRef = useRef(new Set());
  const pageRef = useRef(page);
  pageRef.current = page;

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; latestLoad.current += 1; };
  }, []);

  const load = useCallback(async (nextPage) => {
    if (!active.current) return false;
    const requestId = ++latestLoad.current;
    setReloading(true); setError(false);
    try {
      const value = { ...EMPTY, ...(await api.loadAdministrativeEvidence(nextPage) ?? {}) };
      if (requestId === latestLoad.current) setDesk(value);
      return true;
    } catch {
      if (requestId === latestLoad.current) {
        setDesk(null);
        setError(true);
        return false;
      }
      return true;
    } finally {
      if (requestId === latestLoad.current) setReloading(false);
    }
  }, [api]);

  useEffect(() => {
    const timer = window.setTimeout(() => { load(page); }, 200);
    return () => { window.clearTimeout(timer); latestLoad.current += 1; };
  }, [load, page]);

  // Every evidence write shares one busy state, so they share one lock. Each
  // write awaits its refresh before busy clears, so none settles in the turn
  // it starts.
  function run(work, reset) {
    return runBusyWrite(busyWriteRef, "evidence", () => runNow(work, reset));
  }

  async function runNow(work, reset) {
    if (busy || !active.current) return;
    pendingFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setBusy(true); setNotice(c.working);
    try {
      await work();
      if (!active.current) return;
      reset?.();
      const refreshed = await load(pageRef.current);
      if (!active.current) return;
      setNotice(refreshed ? c.saved : c.savedRefreshFailed);
    }
    catch {
      if (!active.current) return;
      await load(pageRef.current);
      if (!active.current) return;
      setNotice(c.failed);
    }
    finally { if (active.current) setBusy(false); }
  }

  // The workspace is a pending region and its controls are pending, so focus
  // stays where it was while a write runs (record 8435). A control that ends
  // unavailable after the write (a cleared form, an included row) may still
  // lose focus then; restore it unless the user moved it.
  useEffect(() => {
    if (busy) return;
    const target = pendingFocusRef.current;
    pendingFocusRef.current = null;
    if (target && target.isConnected && document.activeElement === document.body) {
      target.focus({ preventScroll: true });
    }
  }, [busy]);

  const selectedAction = useMemo(() => (desk?.actions ?? []).find((row) => row.actionKey === action.actionKey), [action.actionKey, desk]);
  const targets = useMemo(() => targetOptions(desk ?? EMPTY, selectedAction?.targetKind, selectedAction?.actionKey), [desk, selectedAction]);
  const packetIssueKeys = useMemo(() => [...new Set((desk?.fieldNoteBlocks ?? []).filter((row) => row.packetState === "included").map((row) => row.issueKey))].sort((a, b) => a.localeCompare(b)), [desk]);
  const packetIssueKey = packetIssueKeys.includes(packet.issueKey) ? packet.issueKey : "";
  const packetBlock = packetIssueKeys.length === 0 ? c.packetNeedsEvidence
    : !packetIssueKey ? c.packetNeedsIssue : !packet.title.trim() ? c.packetNeedsTitle : null;
  const actionBlock = !selectedAction ? c.chooseAction
    : targets.length === 0 ? c.noActionTargets : !targets.some((target) => target.id === action.targetId) ? c.chooseActionTarget : null;
  useEffect(() => {
    if (!selectedAction) return;
    const nextTargets = targetOptions(desk ?? EMPTY, selectedAction.targetKind, selectedAction.actionKey);
    setAction((current) => ({ ...current, targetKind: selectedAction.targetKind, targetId: current.targetKind === selectedAction.targetKind && nextTargets.some((row) => row.id === current.targetId) ? current.targetId : "" }));
  }, [desk, selectedAction]);

  return (
    <article id="admin-evidence-operations" className={`${PLANE_CARD_CLASS} xus-card xus-admin-evidence role-section-target`} tabIndex="-1">
      <header className="xus-cardhead">
        <span className="xus-glyph" aria-hidden="true"><FileSearch size={18} /></span>
        <div className="xus-cardhead__copy"><h2 className="xus-cardttl">{c.title}</h2><p className="xus-cardsub">{c.sub}</p></div>
      </header>
      <div className="xus-cardbody">
        <div className="xus-btnrow" role="group" aria-label={c.title}>
          {[["notes", c.notes], ["actions", c.actions]].map(([key, label]) => (
            <RoutedTabLink group="evidence" value={key} key={key} type="button" aria-pressed={tab === key} className={`xus-btn ${tab === key ? "xus-btn--go" : ""}`} onClick={() => { setTab(key); setPage(0); }}>{label}</RoutedTabLink>
          ))}
        </div>
        {notice && <p className="xus-note" role={notice === c.failed ? "alert" : "status"}>{notice}</p>}
      </div>
      <BusyRegion className="xus-admin-evidence__workspace" pending={busy} aria-busy={busy || reloading}>
      {desk === null && !error && <div className="xus-cardbody xus-cardbody--divided" role="status"><p className="xus-note">{c.loading}</p></div>}
      {error && <div className="xus-cardbody xus-cardbody--divided"><p className="xus-note" role="alert">{c.unavailable}</p><button type="button" className="xus-btn" onClick={() => load(page)}>{c.retry}</button></div>}
      {desk && tab === "notes" && (
        <><div className="xus-cardbody xus-cardbody--divided"><form className="xus-form" onSubmit={(event) => { event.preventDefault(); run(() => api.addFieldNoteEvidence(fieldNote), () => setFieldNote({ sourceTitle: "", sourceType: "document", provenance: "", issueKey: "", body: "", annotation: "" })); }}><h3 className="xus-eyebrow">{c.addNote}</h3><div className="xus-formgrid"><label className="xus-field">{c.sourceTitle}<input className="xus-input" required maxLength="200" value={fieldNote.sourceTitle} onChange={(e) => setFieldNote({ ...fieldNote, sourceTitle: e.target.value })} /></label><label className="xus-field">{c.sourceType}<select className="xus-input" value={fieldNote.sourceType} onChange={(e) => setFieldNote({ ...fieldNote, sourceType: e.target.value })}>{Object.keys(sourceTypes).map((value) => <option key={value} value={value}>{sourceTypes[value]}</option>)}</select></label><label className="xus-field">{c.provenance}<input className="xus-input" required maxLength="2000" value={fieldNote.provenance} onChange={(e) => setFieldNote({ ...fieldNote, provenance: e.target.value })} /></label><label className="xus-field">{c.issue}<input className="xus-input" required maxLength="120" value={fieldNote.issueKey} onChange={(e) => setFieldNote({ ...fieldNote, issueKey: e.target.value })} /></label></div><label className="xus-field">{c.body}<textarea className="xus-input" required maxLength="12000" value={fieldNote.body} onChange={(e) => setFieldNote({ ...fieldNote, body: e.target.value })} /></label><label className="xus-field">{c.annotation}<textarea className="xus-input" maxLength="4000" value={fieldNote.annotation} onChange={(e) => setFieldNote({ ...fieldNote, annotation: e.target.value })} /></label><BusyButton className="xus-btn xus-btn--go" pending={busy} disabled={!fieldNote.sourceTitle.trim() || !fieldNote.provenance.trim() || !fieldNote.issueKey.trim() || !fieldNote.body.trim()}>{c.addNote}</BusyButton></form></div>
          {desk.fieldNoteBlocks.length === 0 && <div className="xus-cardbody"><p className="xus-note">{c.emptyNotes}</p></div>}
          {desk.fieldNoteBlocks.map((row) => <div className="xus-row" key={row.id}><div className="xus-rowmain"><strong className="xus-name">{row.issueKey} · {row.sourceTitle}</strong><small className="xus-meta">{sourceTypes[row.sourceType] ?? row.sourceType} · {stateLabels[row.packetState] ?? row.packetState}</small><small className="xus-meta">{c.provenance}: {row.provenance}</small><small className="xus-meta">{row.body}</small>{row.annotation && <small className="xus-meta">{c.annotation}: {row.annotation}</small>}</div><span className="xus-rowact"><BusyButton className="xus-btn" pending={busy} disabled={row.packetState === "included"} onClick={() => run(() => api.executeAdministrativeObjectAction({ targetKind: "field_note_block", targetId: row.id, actionKey: "include" }))}>{c.include}</BusyButton><BusyButton className="xus-btn" pending={busy} disabled={row.packetState === "excluded"} onClick={() => run(() => api.executeAdministrativeObjectAction({ targetKind: "field_note_block", targetId: row.id, actionKey: "exclude" }))}>{c.exclude}</BusyButton></span></div>)}
          <div className="xus-cardbody xus-cardbody--divided"><form className="xus-form" onSubmit={(event) => { event.preventDefault(); if (packetBlock) return; run(() => api.draftFieldNotePacket(packetIssueKey, packet.title), () => setPacket({ issueKey: "", title: "" })); }}><h3 className="xus-eyebrow">{c.draftPacket}</h3><div className="xus-formgrid"><label className="xus-field">{c.issue}<select className="xus-input" required value={packetIssueKey} onChange={(e) => setPacket({ ...packet, issueKey: e.target.value })}><option value="" disabled>{c.issue}</option>{packetIssueKeys.map((issueKey) => <option key={issueKey} value={issueKey}>{issueKey}</option>)}</select></label><label className="xus-field">{c.packetTitle}<input className="xus-input" required maxLength="200" value={packet.title} onChange={(e) => setPacket({ ...packet, title: e.target.value })} /></label></div><BusyButton className="xus-btn xus-btn--go" pending={busy} disabled={Boolean(packetBlock)} disabledReason={packetBlock}>{c.draftPacket}</BusyButton></form></div>
          {desk.packets.length === 0 && <div className="xus-cardbody"><p className="xus-note">{c.emptyPackets}</p></div>}{desk.packets.map((row) => <div className="xus-row" key={row.id}><div className="xus-rowmain"><strong className="xus-name">{row.title}</strong><small className="xus-meta">{row.issueKey} · {stateLabels[row.status] ?? row.status}</small><details><summary className="xus-meta">{c.packetContents}</summary><p className="xus-note">{row.body}</p></details></div><BusyButton className="xus-btn" pending={busy} disabled={row.status === "review_ready"} onClick={() => run(() => api.executeAdministrativeObjectAction({ targetKind: "field_note_packet", targetId: row.id, actionKey: "mark_review_ready" }))}>{c.reviewReady}</BusyButton></div>)}</>
      )}
      {desk && tab === "actions" && (
        <><div className="xus-cardbody xus-cardbody--divided"><form className="xus-form" onSubmit={(event) => { event.preventDefault(); if (actionBlock) return; run(() => api.executeAdministrativeObjectAction(action), () => setAction({ actionKey: "", targetKind: "", targetId: "", note: "" })); }}><div className="xus-formgrid"><label className="xus-field">{c.action}<select className="xus-input" required value={action.actionKey} onChange={(e) => setAction({ ...action, actionKey: e.target.value, targetKind: "", targetId: "" })}><option value="" disabled>{c.action}</option>{desk.actions.map((row) => <option key={`${row.targetKind}:${row.actionKey}`} value={row.actionKey}>{c.actionLabels[row.actionKey] ?? row.label}</option>)}</select></label><label className="xus-field">{c.target}<select className="xus-input" required value={action.targetId} onChange={(e) => setAction({ ...action, targetId: e.target.value })}><option value="" disabled>{c.target}</option>{targets.map((row) => <option key={row.id} value={row.id}>{row.label}</option>)}</select></label><label className="xus-field">{c.note}<input className="xus-input" maxLength="1000" value={action.note} onChange={(e) => setAction({ ...action, note: e.target.value })} /></label></div><BusyButton className="xus-btn xus-btn--go" pending={busy} disabled={Boolean(actionBlock)} disabledReason={actionBlock}>{c.execute}</BusyButton></form></div><div className="xus-cardbody xus-cardbody--divided"><h3 className="xus-eyebrow">{c.history}</h3>{desk.history.length === 0 && <p className="xus-note">{c.emptyHistory}</p>}</div>{desk.history.map((row) => <div className="xus-row" key={row.id}><div className="xus-rowmain"><strong className="xus-name">{c.actionLabels[row.actionKey] ?? row.actionKey}</strong><small className="xus-meta">{targetKindLabel(lang, row.targetKind)} · {row.targetLabel}</small><small className="xus-meta">{c.actor}: {row.actorLabel}</small><small className="xus-meta">{c.before}: {stateObjectLabel(row.previousState, stateLabels, lang)}</small><small className="xus-meta">{c.after}: {stateObjectLabel(row.resultingState, stateLabels, lang)}</small>{row.note && <small className="xus-meta">{row.note}</small>}<small className="xus-meta">{c.executed}: {formatStamp(lang, row.createdAt)}</small></div></div>)}</>
      )}
      {desk && (page > 0 || desk.hasNext?.[tab]) && <nav className="xus-cardbody xus-cardbody--divided xus-btnrow" aria-label={c.page.replace("{page}", page + 1)}><BusyButton type="button" className="xus-btn" pending={busy} disabled={page === 0} onClick={() => setPage((value) => Math.max(0, value - 1))}>{c.previous}</BusyButton><span className="xus-note">{c.page.replace("{page}", page + 1)}</span><BusyButton type="button" className="xus-btn" pending={busy} disabled={!desk.hasNext?.[tab]} onClick={() => setPage((value) => value + 1)}>{c.next}</BusyButton></nav>}
      </BusyRegion>
    </article>
  );
}
