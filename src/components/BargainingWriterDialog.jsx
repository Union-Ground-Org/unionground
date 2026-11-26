import { useEffect, useRef, useState } from "react";
import { CircleAlert, LockKeyhole } from "lucide-react";
import { Dialog } from "./Dialogs.jsx";
import { catalogue, t } from "../lib/i18n.js";

// A value the catalogue does not name yet (a newer server enum) still reads
// as words rather than a raw token.
function optionLabel(lang, group, value) {
  const key = `bargainingWriter.option.${group}.${value}`;
  return Object.hasOwn(catalogue.en, key) ? t(lang, key) : value.replaceAll("_", " ");
}

// This id is an idempotency key, not a secret: the server pairs a retry with
// the write it is retrying. crypto.randomUUID is the right source and is used
// whenever it exists, but it is absent on http:// origins and in older
// WebViews — and this ran during render, so throwing there did not fail one
// write, it threw inside React's render phase and, with no error boundary
// above it, took the entire member shell to a blank document. A weaker id is
// worth far less than an app that still works; the fallback is still v4-shaped
// and unique enough that two of a single member's writes cannot collide.
function requestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const hex = (length) => Array.from({ length }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  const variant = "89ab"[Math.floor(Math.random() * 4)];
  return `${Date.now().toString(16).padStart(12, "0").slice(-8)}-${hex(4)}-4${hex(3)}-${variant}${hex(3)}-${hex(12)}`;
}

function value(form, name) {
  return String(form.get(name) || "").trim();
}

function optionalNumber(form, name) {
  const raw = value(form, name);
  return raw === "" ? null : Number(raw);
}

function optionalIso(form, name) {
  const raw = value(form, name);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString();
}

function localDateValue(date = new Date()) {
  const localTime = date.getTime() - date.getTimezoneOffset() * 60_000;
  return new Date(localTime).toISOString().slice(0, 10);
}

function localDateTimeValue(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  const localTime = date.getTime() - date.getTimezoneOffset() * 60_000;
  return new Date(localTime).toISOString().slice(0, 16);
}

function phaseChoices(cycle) {
  const choices = {
    preparing: ["proposal_development"],
    proposal_development: ["at_table"],
    at_table: ["mediation", "fact_finding", "impasse", "tentative_agreement"],
    mediation: ["at_table", "tentative_agreement"],
    fact_finding: ["at_table", "tentative_agreement"],
    impasse: ["at_table", "tentative_agreement"],
    tentative_agreement: ["at_table", "ratification"],
    ratification: cycle?.canCertify === true ? ["at_table"] : [],
  };
  const current = choices[cycle?.phase || cycle?.status] || [];
  return current.filter((next) => (
    !["tentative_agreement", "ratification"].includes(next)
    || cycle?.canAdvanceToRatification === true
  ));
}

function proposalChoices(proposal, cycle) {
  if (cycle?.proposals?.some(
    (candidate) => candidate.parentProposalId === proposal?.id,
  )) {
    return [];
  }
  const choices = {
    draft: ["approved", "withdrawn"],
    approved: ["presented", "withdrawn"],
    presented: ["countered", "tentative_agreement", "accepted", "rejected", "withdrawn"],
    countered: ["tentative_agreement", "accepted", "rejected", "withdrawn"],
    tentative_agreement: ["withdrawn"],
  };
  const available = choices[proposal?.status] || [];
  const phase = cycle?.phase || cycle?.status;
  const formalStatusAllowed = Boolean(cycle?.bargainingStartedOn)
    && ["at_table", "mediation", "fact_finding", "impasse", "tentative_agreement"].includes(phase);
  return available.filter((status) => (
    !(proposal?.recordKind === "agreement_package" && ["accepted", "rejected"].includes(status))
    && !(proposal?.recordKind === "article" && status === "tentative_agreement")
    && (
      !["presented", "countered", "tentative_agreement", "accepted", "rejected"].includes(status)
      || formalStatusAllowed
    )
    && (
      status !== "tentative_agreement"
      || proposal?.canMarkTentativeAgreement === true
    )
  ));
}

export function BargainingWriterDialog({
  mode,
  campaign,
  cycle,
  target,
  lang,
  onClose,
  onSave,
  restoreFocusRef,
}) {
  const tr = (key) => t(lang, `bargainingWriter.${key}`);
  const sessionStartsAt = Date.parse(target?.startsAt || "");
  const bargainingStartedAt = Date.parse(
    cycle?.bargainingStartedOn
      ? `${cycle.bargainingStartedOn}T00:00:00Z`
      : "",
  );
  const futureSession = mode === "sessionOutcome"
    && Number.isFinite(sessionStartsAt)
    && sessionStartsAt > Date.now();
  const heldSessionAllowed = mode === "sessionOutcome"
    && !futureSession
    && Number.isFinite(sessionStartsAt)
    && Number.isFinite(bargainingStartedAt)
    && sessionStartsAt >= bargainingStartedAt
    && !["preparing", "proposal_development"].includes(cycle?.phase || cycle?.status);
  const idRef = useRef(null);
  if (!idRef.current) idRef.current = requestId();
  const retryPayload = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [memberSafeConfirmed, setMemberSafeConfirmed] = useState(false);
  const [confirmationAnnouncement, setConfirmationAnnouncement] = useState("");
  const [decisionMethod, setDecisionMethod] = useState("vote");
  const [sessionOutcome, setSessionOutcome] = useState(
    heldSessionAllowed ? "held" : "cancelled",
  );
  const [recordKind, setRecordKind] = useState("article");
  const [parentProposalId, setParentProposalId] = useState("");
  const [relationKind, setRelationKind] = useState("revision");
  const [proposalStatus, setProposalStatus] = useState(
    mode === "proposalStatus" ? proposalChoices(target, cycle)[0] || "" : "",
  );
  const [sourceKinds, setSourceKinds] = useState({
    vote: "union_report",
    not_required: "written_rule",
  });
  const errorRef = useRef(null);
  const formRef = useRef(null);
  const today = localDateValue();
  const nowDateTime = localDateTimeValue();
  const sessionStartDateTime = localDateTimeValue(target?.startsAt);
  const presentationDateRequired = mode === "proposalStatus"
    && !target?.presentedOn
    && ["presented", "countered", "tentative_agreement", "accepted", "rejected"].includes(proposalStatus);

  useEffect(() => {
    if (error) errorRef.current?.focus({ preventScroll: true });
  }, [error]);

  useEffect(() => {
    if (mode !== "proposalStatus") return;
    const choices = proposalChoices(target, cycle);
    setProposalStatus((current) => (
      choices.includes(current) ? current : choices[0] || ""
    ));
    setMemberSafeConfirmed(false);
    setConfirmationAnnouncement("");
  }, [
    mode,
    target?.id,
    target?.status,
    target?.revision,
    target?.canMarkTentativeAgreement,
    cycle?.revision,
    cycle?.phase,
    cycle?.status,
    cycle?.bargainingStartedOn,
  ]);

  function payloadFor(form) {
    const shared = { requestId: idRef.current };
    if (mode === "open") {
      return {
        ...shared,
        campaignId: campaign.id,
        expectedCampaignRevision: campaign.revision,
        title: value(form, "title"),
        targetFirstContractOn: value(form, "targetFirstContractOn") || null,
        nextAction: value(form, "nextAction"),
        nextDeadlineAt: optionalIso(form, "nextDeadlineAt"),
      };
    }
    if (mode === "phase") {
      return {
        ...shared,
        cycleId: cycle.id,
        expectedRevision: cycle.revision,
        expectedCampaignRevision: campaign.revision,
        nextPhase: value(form, "nextPhase"),
        effectiveOn: value(form, "effectiveOn") || null,
        reason: value(form, "reason"),
        nextAction: value(form, "nextAction"),
        nextDeadlineAt: optionalIso(form, "nextDeadlineAt"),
      };
    }
    if (mode === "proposal") {
      const parentId = value(form, "parentProposalId");
      const parent = cycle.proposals.find((item) => item.id === parentId);
      return {
        ...shared,
        cycleId: cycle.id,
        expectedCycleRevision: cycle.revision,
        topic: value(form, "topic"),
        title: value(form, "title"),
        side: value(form, "side"),
        recordKind: value(form, "recordKind"),
        includedProposalIds: form.getAll("includedProposalIds").map(String),
        documentSha256: value(form, "documentSha256").toLowerCase() || null,
        parentProposalId: parent?.id || null,
        parentExpectedRevision: parent?.revision || null,
        relationKind: parent ? value(form, "relationKind") : null,
        memberSummary: value(form, "memberSummary"),
        internalNotes: value(form, "internalNotes"),
      };
    }
    if (mode === "proposalStatus") {
      const nextStatus = value(form, "nextStatus");
      return {
        ...shared,
        proposalId: target.id,
        expectedRevision: target.revision,
        expectedCycleRevision: cycle.revision,
        nextStatus,
        presentedOn: nextStatus === "withdrawn"
          ? null
          : value(form, "presentedOn") || null,
        reason: value(form, "reason"),
      };
    }
    if (mode === "session") {
      return {
        ...shared,
        cycleId: cycle.id,
        expectedCycleRevision: cycle.revision,
        startsAt: optionalIso(form, "startsAt"),
        location: value(form, "location"),
        agenda: value(form, "agenda"),
      };
    }
    if (mode === "sessionOutcome") {
      return {
        ...shared,
        sessionId: target.id,
        expectedRevision: target.revision,
        expectedCycleRevision: cycle.revision,
        status: value(form, "status"),
        endsAt: optionalIso(form, "endsAt"),
        memberUpdate: value(form, "memberUpdate"),
        internalMinutes: value(form, "internalMinutes"),
        reason: value(form, "reason"),
      };
    }
    if (mode === "ratification") {
      const method = value(form, "decisionMethod");
      return {
        ...shared,
        cycleId: cycle.id,
        expectedCycleRevision: cycle.revision,
        expectedCampaignRevision: campaign.revision,
        agreementProposalId: value(form, "agreementProposalId"),
        agreementSha256: value(form, "agreementSha256").toLowerCase(),
        decisionMethod: method,
        heldOn: value(form, "heldOn"),
        sourceReportedOutcome: method === "not_required"
          ? "not_required"
          : value(form, "sourceReportedOutcome"),
        sourceKind: value(form, "sourceKind"),
        sourceReference: value(form, "sourceReference"),
        sourceSha256: value(form, "sourceSha256").toLowerCase(),
        ruleSummary: value(form, "ruleSummary"),
        eligibilitySource: value(form, "eligibilitySource"),
        eligibleCount: method === "vote" ? optionalNumber(form, "eligibleCount") : null,
        ballotsCast: method === "vote" ? optionalNumber(form, "ballotsCast") : null,
        approveCount: method === "vote" ? optionalNumber(form, "approveCount") : null,
        rejectCount: method === "vote" ? optionalNumber(form, "rejectCount") : null,
        abstainCount: method === "vote" ? optionalNumber(form, "abstainCount") : null,
        invalidCount: method === "vote" ? optionalNumber(form, "invalidCount") : null,
        quorumRequiredCount: method === "vote" ? optionalNumber(form, "quorumRequiredCount") : null,
        thresholdNumerator: method === "vote" ? optionalNumber(form, "thresholdNumerator") : null,
        thresholdDenominator: method === "vote" ? optionalNumber(form, "thresholdDenominator") : null,
        approvalComparator: method === "vote" ? value(form, "approvalComparator") : null,
        approvalDenominator: method === "vote" ? value(form, "approvalDenominator") : null,
      };
    }
    if (mode === "ratificationCorrection") {
      return {
        ...shared,
        cycleId: cycle.id,
        expectedCycleRevision: cycle.revision,
        expectedCampaignRevision: campaign.revision,
        ratificationId: target.id,
        reasonCode: value(form, "reasonCode"),
        sourceKind: value(form, "sourceKind"),
        sourceReference: value(form, "sourceReference"),
        sourceSha256: value(form, "sourceSha256").toLowerCase(),
      };
    }
    return {
      ...shared,
      cycleId: cycle.id,
      expectedCycleRevision: cycle.revision,
      expectedCampaignRevision: campaign.revision,
      ratificationId: value(form, "ratificationId"),
      agreementSha256: value(form, "agreementSha256").toLowerCase(),
      signedOn: value(form, "signedOn"),
      sourceKind: value(form, "sourceKind"),
      sourceReference: value(form, "sourceReference"),
      sourceSha256: value(form, "sourceSha256").toLowerCase(),
      expectedSignatoryCount: optionalNumber(form, "expectedSignatoryCount"),
      verifiedSignatoryCount: optionalNumber(form, "verifiedSignatoryCount"),
      effectiveOn: value(form, "effectiveOn") || null,
      expiresOn: value(form, "expiresOn") || null,
    };
  }

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const payload = uncertain && retryPayload.current
      ? retryPayload.current
      : payloadFor(form);
    retryPayload.current = payload;
    setBusy(true);
    setError("");
    try {
      await onSave(payload);
    } catch (err) {
      if (err.code === "40001") {
        idRef.current = requestId();
        retryPayload.current = null;
        setUncertain(false);
        setError(tr("changed"));
        setMemberSafeConfirmed(false);
        setConfirmationAnnouncement(tr("confirmationReset"));
      } else {
        setUncertain(!err.code);
        setError(tr("failed"));
      }
    } finally {
      setBusy(false);
    }
  }

  function changedAfterError() {
    if (!error || uncertain) return;
    idRef.current = requestId();
    retryPayload.current = null;
    setError("");
  }

  const availableParents = cycle?.proposals?.filter(
    (item) => (
      item.recordKind === recordKind
      && (
        !["accepted", "rejected", "withdrawn", "superseded"].includes(item.status)
        || (
          item.status === "accepted"
          && recordKind === "article"
          && ["at_table", "mediation", "fact_finding", "impasse"].includes(
            cycle?.phase || cycle?.status,
          )
        )
      )
    ),
  ) || [];
  const selectedParent = availableParents.find(
    (item) => item.id === parentProposalId,
  ) || null;
  const parentIds = new Set(
    (cycle?.proposals || []).map((item) => item.parentProposalId).filter(Boolean),
  );
  const packageCandidates = (cycle?.proposals || []).filter((item) => (
    item.recordKind === "article"
    && item.status === "accepted"
    && !parentIds.has(item.id)
  ));
  const unresolvedArticleLeaves = (cycle?.proposals || []).filter((item) => (
    item.recordKind === "article"
    && !["accepted", "rejected", "withdrawn", "superseded"].includes(item.status)
    && !parentIds.has(item.id)
  ));
  const packageReady = packageCandidates.length > 0
    && unresolvedArticleLeaves.length === 0;
  const tentativeAgreements = cycle?.proposals?.filter(
    (item) => item.status === "tentative_agreement",
  ) || [];
  const authorizedRatifications = cycle?.ratifications?.filter(
    (item) => item.current === true && item.corrected !== true,
  ) || [];

  useEffect(() => {
    if (!parentProposalId) return;
    if (!availableParents.some((item) => item.id === parentProposalId)) {
      setParentProposalId("");
      setRelationKind("revision");
    }
  }, [availableParents, parentProposalId]);

  useEffect(() => {
    if (recordKind === "agreement_package" && !packageReady) {
      setRecordKind("article");
    }
  }, [packageReady, recordKind]);

  return (
    <Dialog
      eyebrow={tr("eyebrow")}
      title={tr(`titles.${mode}`)}
      onClose={onClose}
      busy={busy}
      locked={uncertain}
      describedBy={mode === "ratificationCorrection"
        ? "bargaining-writer-privacy bargaining-writer-correction-warning"
        : "bargaining-writer-privacy"}
      restoreFocusRef={restoreFocusRef}
      wide
    >
      <form
        ref={formRef}
        className="stack-form bargaining-writer"
        onSubmit={submit}
        onChange={changedAfterError}
        onInput={(event) => {
          if (event.target?.name === "memberSafeConfirmed") return;
          if (memberSafeConfirmed) {
            setMemberSafeConfirmed(false);
            setConfirmationAnnouncement(tr("confirmationReset"));
          }
        }}
      >
        <aside id="bargaining-writer-privacy" className="lifecycle-privacy-note">
          <LockKeyhole size={17} />
          <p>{tr("privacy")} {tr("evidence")}</p>
        </aside>
        <fieldset disabled={busy || uncertain}>
          {mode === "open" && <>
            <label>{tr("title")}<input name="title" minLength={3} maxLength={160} required /></label>
            <label>{tr("targetDate")}<input name="targetFirstContractOn" type="date" /></label>
            <label>{tr("nextAction")}<textarea name="nextAction" maxLength={600} /></label>
            <label>{tr("nextDeadline")}<input name="nextDeadlineAt" type="datetime-local" /></label>
          </>}

          {mode === "phase" && <>
            <label>
              {(cycle?.phase || cycle?.status) === "ratification"
                ? tr("rollbackPhase")
                : tr("phase")}
              <select name="nextPhase" defaultValue={phaseChoices(cycle)[0] || ""} required>
                {phaseChoices(cycle).map((phase) => <option key={phase} value={phase}>{tr(`phaseLabel.${phase}`)}</option>)}
              </select>
            </label>
            {!cycle.bargainingStartedOn && phaseChoices(cycle).includes("at_table") && (
              <label>{tr("effectiveOn")}<input name="effectiveOn" type="date" max={today} required /></label>
            )}
            <label>{tr("nextAction")}<textarea name="nextAction" maxLength={600} /></label>
            <label>{tr("nextDeadline")}<input name="nextDeadlineAt" type="datetime-local" /></label>
            <label>
              {(cycle?.phase || cycle?.status) === "ratification"
                ? tr("rollbackReason")
                : tr("reason")}
              <textarea
              name="reason"
              maxLength={1000}
              required={(cycle?.phase || cycle?.status) === "ratification"}
            /></label>
          </>}

          {mode === "proposal" && <>
            <label>{tr("recordKind")}
              <select
                name="recordKind"
                value={recordKind}
                onChange={(event) => setRecordKind(event.target.value)}
              >
                {["article", "agreement_package"].map((kind) => (
                  <option
                    key={kind}
                    value={kind}
                    disabled={kind === "agreement_package" && !packageReady}
                  >
                    {optionLabel(lang, "recordKind", kind)}
                  </option>
                ))}
              </select>
            </label>
            <label>{tr("topic")}<input name="topic" minLength={1} maxLength={120} required /></label>
            <label>{tr("proposalTitle")}<input name="title" minLength={3} maxLength={200} required /></label>
            <label>{tr("side")}
              <select name="side" defaultValue="union">
                {["union", "employer", "joint"].map((side) => (
                  <option key={side} value={side}>{optionLabel(lang, "side", side)}</option>
                ))}
              </select>
            </label>
            <label>{tr("parentVersion")}
              <select
                name="parentProposalId"
                value={parentProposalId}
                onChange={(event) => {
                  const nextId = event.target.value;
                  const nextParent = availableParents.find((item) => item.id === nextId);
                  setParentProposalId(nextId);
                  setRelationKind(nextParent?.status === "accepted" ? "replacement" : "revision");
                }}
              >
                <option value="">{tr("rootVersion")}</option>
                {availableParents.map((item) => (
                  <option key={item.id} value={item.id}>{item.title} · v{item.version}</option>
                ))}
              </select>
            </label>
            <label>{tr("relation")}
              <select
                name="relationKind"
                value={relationKind}
                onChange={(event) => setRelationKind(event.target.value)}
              >
                {(selectedParent?.status === "accepted"
                  ? ["replacement"]
                  : ["revision", "counter", "replacement"]).map((relation) => (
                  <option key={relation} value={relation}>{optionLabel(lang, "relation", relation)}</option>
                ))}
              </select>
            </label>
            {recordKind === "agreement_package" && <>
              <div className="bargaining-writer__included">
                <strong>{tr("includedProposals")}</strong>
                <ul>
                  {packageCandidates.map((item) => (
                    <li key={item.id}>{item.title} · v{item.version}</li>
                  ))}
                </ul>
                {packageCandidates.map((item) => (
                  <input
                    key={item.id}
                    type="hidden"
                    name="includedProposalIds"
                    value={item.id}
                  />
                ))}
              </div>
              <label>{tr("packageDocumentHash")}
                <input name="documentSha256" pattern="[0-9a-fA-F]{64}" maxLength={64} required />
              </label>
            </>}
            <label>{tr("memberSummary")}<textarea name="memberSummary" maxLength={2000} /></label>
            <label>{tr("internalNotes")}<textarea name="internalNotes" maxLength={12000} /></label>
          </>}

          {mode === "proposalStatus" && <>
            <p className="bargaining-writer__target"><strong>{target.title}</strong> · v{target.version}</p>
            <label>{tr("proposalStatus")}
              <select
                name="nextStatus"
                value={proposalStatus}
                onChange={(event) => setProposalStatus(event.target.value)}
                required
              >
                {proposalChoices(target, cycle).map((status) => (
                  <option key={status} value={status}>{optionLabel(lang, "proposalStatus", status)}</option>
                ))}
              </select>
            </label>
            {!target.memberSummary && ["presented", "countered"].includes(target.status) && (
              <p className="bargaining-writer__guidance">{tr("missingMemberSummary")}</p>
            )}
            <label>{tr("presentedOn")}
              <input
                name="presentedOn"
                 type="date"
                 defaultValue={target.presentedOn || ""}
                 min={cycle?.bargainingStartedOn || undefined}
                 max={today}
                 required={presentationDateRequired}
                 disabled={proposalStatus === "withdrawn"}
               />
            </label>
            <label>{tr("reason")}<textarea name="reason" maxLength={2000} /></label>
          </>}

          {mode === "session" && <>
            <label>{tr("startsAt")}<input name="startsAt" type="datetime-local" required /></label>
            <label>{tr("location")}<input name="location" maxLength={240} /></label>
            <label>{tr("agenda")}<textarea name="agenda" maxLength={12000} /></label>
          </>}

          {mode === "sessionOutcome" && <>
            <p className="bargaining-writer__target"><strong>{tr("sessionNumber")} {target.sessionNumber}</strong></p>
            <label>{tr("sessionStatus")}
              <select
                name="status"
                value={sessionOutcome}
                onChange={(event) => setSessionOutcome(event.target.value)}
              >
                {["held", "cancelled"].map((status) => (
                  <option
                    key={status}
                    value={status}
                    disabled={status === "held" && !heldSessionAllowed}
                  >
                    {optionLabel(lang, "sessionStatus", status)}
                  </option>
                ))}
              </select>
            </label>
            <fieldset
              className="bargaining-writer__conditional"
              hidden={sessionOutcome !== "held"}
              disabled={sessionOutcome !== "held"}
            >
              <legend>{tr("heldSessionDetails")}</legend>
              <label>{tr("endsAt")}
                <input
                  name="endsAt"
                  type="datetime-local"
                  min={sessionStartDateTime}
                  max={nowDateTime}
                  required
                />
              </label>
              <label>{tr("memberUpdate")}<textarea name="memberUpdate" minLength={3} maxLength={2000} required /></label>
            </fieldset>
            <label>{tr("minutes")}<textarea name="internalMinutes" maxLength={20000} /></label>
            <label>{tr("reason")}<textarea name="reason" maxLength={2000} required={sessionOutcome !== "held"} /></label>
          </>}

          {mode === "ratification" && <>
            <label>{tr("agreement")}
              <select name="agreementProposalId" defaultValue={tentativeAgreements[0]?.id || ""} required>
                {tentativeAgreements.map((item) => (
                  <option key={item.id} value={item.id}>{item.title} · v{item.version}</option>
                ))}
              </select>
            </label>
            <label>{tr("agreementHash")}<input name="agreementSha256" pattern="[0-9a-fA-F]{64}" maxLength={64} required /></label>
            <label>{tr("decisionMethod")}
              <select
                name="decisionMethod"
                value={decisionMethod}
                onChange={(event) => setDecisionMethod(event.target.value)}
              >
                <option value="vote">{tr("vote")}</option>
                <option value="not_required">{tr("notRequired")}</option>
              </select>
            </label>
            <label>{tr("heldOn")}<input name="heldOn" type="date" max={today} required /></label>
            {decisionMethod === "vote" && <>
              <label>{tr("sourceOutcome")}
                <select name="sourceReportedOutcome" defaultValue="approved">
                  {["approved", "rejected", "no_quorum"].map((outcome) => (
                    <option key={outcome} value={outcome}>{optionLabel(lang, "outcome", outcome)}</option>
                  ))}
                </select>
              </label>
            </>}
            <fieldset
              className="bargaining-writer__conditional"
              hidden={decisionMethod !== "vote"}
              disabled={decisionMethod !== "vote"}
            >
              <legend>{tr("aggregateRule")}</legend>
              <div className="bargaining-writer__grid">
                <label>{tr("eligibleCount")}<input name="eligibleCount" type="number" min="1" max="10000000" required /></label>
                <label>{tr("ballotsCast")}<input name="ballotsCast" type="number" min="0" max="10000000" required /></label>
                <label>{tr("approveCount")}<input name="approveCount" type="number" min="0" max="10000000" required /></label>
                <label>{tr("rejectCount")}<input name="rejectCount" type="number" min="0" max="10000000" required /></label>
                <label>{tr("abstainCount")}<input name="abstainCount" type="number" min="0" max="10000000" required /></label>
                <label>{tr("invalidCount")}<input name="invalidCount" type="number" min="0" max="10000000" required /></label>
                <label>{tr("quorumCount")}<input name="quorumRequiredCount" type="number" min="0" max="10000000" required /></label>
                <label>{tr("thresholdNumerator")}<input name="thresholdNumerator" type="number" min="1" max="10000000" required /></label>
                <label>{tr("thresholdDenominator")}<input name="thresholdDenominator" type="number" min="1" max="10000000" required /></label>
                <label>{tr("approvalComparator")}
                  <select name="approvalComparator" defaultValue="at_least">
                    {["at_least", "more_than"].map((comparator) => (
                      <option key={comparator} value={comparator}>{optionLabel(lang, "comparator", comparator)}</option>
                    ))}
                  </select>
                </label>
                <label>{tr("denominator")}
                  <select name="approvalDenominator" defaultValue="non_abstaining">
                    {["eligible", "ballots_cast", "non_abstaining"].map((denominator) => (
                      <option key={denominator} value={denominator}>{optionLabel(lang, "denominator", denominator)}</option>
                    ))}
                  </select>
                </label>
              </div>
            </fieldset>
            <label>{tr("sourceKind")}
              <select
                name="sourceKind"
                value={sourceKinds[decisionMethod]}
                onChange={(event) => setSourceKinds((current) => ({
                  ...current,
                  [decisionMethod]: event.target.value,
                }))}
              >
                {["union_report", "independent_tally", "meeting_minutes", "written_rule", "other"].map((kind) => (
                  <option key={kind} value={kind}>{optionLabel(lang, "sourceKind", kind)}</option>
                ))}
              </select>
            </label>
            <label>{tr("sourceReference")}<textarea name="sourceReference" minLength={3} maxLength={1000} required /></label>
            <label>{tr("sourceHash")}<input name="sourceSha256" pattern="[0-9a-fA-F]{64}" maxLength={64} required /></label>
            <label>{tr("ruleSummary")}<textarea name="ruleSummary" minLength={3} maxLength={2000} required /></label>
            <label>{tr("eligibilitySource")}<textarea name="eligibilitySource" minLength={3} maxLength={1000} required /></label>
          </>}

          {mode === "ratificationCorrection" && <>
            <p className="bargaining-writer__target">
              <strong>{tr("currentSourcedRecord")}</strong> · {target.heldOn}
              {target.outcome ? ` · ${optionLabel(lang, "outcome", target.outcome)}` : ""}
            </p>
            <label>{tr("correctionReason")}
              <select name="reasonCode" defaultValue="source_error" required>
                {["source_error", "tally_error", "rule_error", "wrong_agreement", "duplicate_record", "other"].map((reason) => (
                  <option key={reason} value={reason}>{optionLabel(lang, "correctionReason", reason)}</option>
                ))}
              </select>
            </label>
            <label>{tr("sourceKind")}
              <select name="sourceKind" defaultValue="official_record" required>
                {["union_report", "independent_tally", "meeting_minutes", "written_rule", "official_record", "other"].map((kind) => (
                  <option key={kind} value={kind}>{optionLabel(lang, "sourceKind", kind)}</option>
                ))}
              </select>
            </label>
            <label>{tr("sourceReference")}<textarea name="sourceReference" minLength={3} maxLength={1000} required /></label>
            <label>{tr("sourceHash")}<input name="sourceSha256" pattern="[0-9a-fA-F]{64}" maxLength={64} required /></label>
          </>}

          {mode === "contract" && <>
            <label>{tr("ratification")}
              <select name="ratificationId" defaultValue={authorizedRatifications[0]?.id || ""} required>
                {authorizedRatifications.map((item) => (
                  <option key={item.id} value={item.id}>{item.heldOn} · {optionLabel(lang, "outcome", item.outcome)}</option>
                ))}
              </select>
            </label>
            <label>{tr("agreementHash")}<input name="agreementSha256" pattern="[0-9a-fA-F]{64}" maxLength={64} required /></label>
            <label>{tr("signedOn")}<input name="signedOn" type="date" max={today} required /></label>
            <label>{tr("effectiveDate")}<input name="effectiveOn" type="date" /></label>
            <label>{tr("expirationDate")}<input name="expiresOn" type="date" /></label>
            <label>{tr("sourceKind")}
              <select name="sourceKind" defaultValue="executed_contract">
                {["executed_contract", "signed_memorandum", "official_record", "other"].map((kind) => (
                  <option key={kind} value={kind}>{optionLabel(lang, "sourceKind", kind)}</option>
                ))}
              </select>
            </label>
            <label>{tr("sourceReference")}<textarea name="sourceReference" minLength={3} maxLength={1000} required /></label>
            <label>{tr("sourceHash")}<input name="sourceSha256" pattern="[0-9a-fA-F]{64}" maxLength={64} required /></label>
            <fieldset className="bargaining-writer__conditional">
              <legend>{tr("signatoryEvidence")}</legend>
              <div className="bargaining-writer__grid">
              <label>{tr("expectedSigners")}<input name="expectedSignatoryCount" type="number" min="1" max="1000" required /></label>
              <label>{tr("verifiedSigners")}<input name="verifiedSignatoryCount" type="number" min="1" max="1000" required /></label>
              </div>
            </fieldset>
          </>}
          <label className="bargaining-writer__confirmation">
            <input
              name="memberSafeConfirmed"
              type="checkbox"
              checked={memberSafeConfirmed}
              onChange={(event) => {
                setMemberSafeConfirmed(event.target.checked);
                setConfirmationAnnouncement("");
              }}
              required
            />
            <span>
              {mode === "ratificationCorrection"
                ? tr("correctionConfirmation")
                : tr("memberSafeConfirmation")}
            </span>
          </label>
          <span className="visually-hidden" aria-live="polite">
            {confirmationAnnouncement}
          </span>
        </fieldset>

        {mode === "ratification" && (
          <aside className="lifecycle-warning">
            <CircleAlert size={18} />
            <p>{tr("externalBoundary")} {decisionMethod === "not_required" ? tr("notRequiredBoundary") : ""}</p>
          </aside>
        )}
        {mode === "contract" && (
          <aside className="lifecycle-warning">
            <CircleAlert size={18} />
            <p>{tr("contractBoundary")}</p>
          </aside>
        )}
        {mode === "ratificationCorrection" && (
          <aside
            id="bargaining-writer-correction-warning"
            className="lifecycle-warning"
            tabIndex={-1}
          >
            <CircleAlert size={18} />
            <p>{tr("correctionBoundary")}</p>
          </aside>
        )}
        {error && (
          <p ref={errorRef} className="auth-message auth-message--error" role="alert" tabIndex={-1}>
            {error}
          </p>
        )}
        <button className="dialog-primary" disabled={busy}>
          {busy
            ? tr("saving")
            : uncertain
              ? tr("retry")
              : mode === "ratificationCorrection"
                ? tr("correctionSave")
                : tr("save")}
        </button>
        {uncertain && (
          <button
            type="button"
            className="outline-pill"
            disabled={busy}
            onClick={onClose}
          >
            {tr("verifyLater")}
          </button>
        )}
      </form>
    </Dialog>
  );
}

export { phaseChoices, proposalChoices };
