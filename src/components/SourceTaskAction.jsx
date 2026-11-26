import { useEffect, useRef, useState } from "react";
import { BusyButton } from "./BusyControls.jsx";
import { isPermissionRefusal, isSourceGone } from "../features/connectedWorkflows/landing.js";
import { useLang } from "../lib/LanguageContext.jsx";
import "./SourceTaskAction.css";

// One control per source. The source identity is the React key, so a parent
// that reuses this instance for another record (a thread that swaps its
// selected message, a dialog that keeps its slot) starts from a clean state
// instead of showing the previous record's "Task created" beside the new one.
// A request still in flight for the old record resolves into an instance that
// has already unmounted and is dropped there.
export function SourceTaskAction(props) {
  return <SourceTaskControl key={`${props.sourceKind}\u001f${props.sourceId}`} {...props} />;
}

// Props beyond the original four are all optional, so every existing caller
// (notification, broadcast and case surfaces) renders exactly what it did.
//   onResolve(sourceKind, sourceId, task) -> Promise<{ task } | null>
//     Called when the task is opened. The server, not this component, decides
//     whether the link still exists and the actor may still see it: a resolved
//     task is what onOpenTask receives, null says the link is gone, and a 42501
//     says the role was revoked. Without it the last task this control saw is
//     handed straight to onOpenTask, as before.
//   onOpenTask(task) may be async (the connected opener re-reads the task and
//     its source, then navigates) and may reject for a revoked role or a task
//     that is gone. It is awaited inside the same guard as onResolve, so a
//     refusal becomes a state on this control and never an unhandled rejection.
//   variant="message" draws the compact inline control used on each message.
//   describedBy names the element (a message's timestamp) that tells a screen
//     reader which of several identical buttons this is, without copying any
//     of the record's text into a label.
// Creation itself is never decided here. onCreate is always called, and the
// database answers with the existing task (created: false) when the source is
// already linked; the busy lock only stops one control from double-submitting.
function SourceTaskControl({
  sourceKind,
  sourceId,
  onCreate,
  onOpenTask = null,
  onResolve = null,
  variant = "dialog",
  describedBy = undefined,
  className = variant === "message" ? "source-task__button" : "dialog-secondary",
}) {
  const { t } = useLang();
  const [phase, setPhase] = useState(null);
  const [outcome, setOutcome] = useState(null);
  const [task, setTask] = useState(null);
  const [failure, setFailure] = useState(null);
  const busyRef = useRef(false);
  const liveRef = useRef(true);
  useEffect(() => {
    liveRef.current = true;
    return () => { liveRef.current = false; };
  }, []);

  async function create() {
    if (busyRef.current) return;
    busyRef.current = true;
    setPhase("creating");
    setFailure(null);
    try {
      const result = await onCreate(sourceKind, sourceId);
      if (!liveRef.current) return;
      if (!result?.task) throw new Error("Task result missing");
      setTask(result.task);
      setOutcome(result.created ? "created" : "existing");
    } catch (error) {
      if (!liveRef.current) return;
      setFailure(isPermissionRefusal(error) ? "denied" : "create");
    } finally {
      busyRef.current = false;
      if (liveRef.current) setPhase(null);
    }
  }

  async function open() {
    if (!task || busyRef.current) return;
    busyRef.current = true;
    setPhase("opening");
    setFailure(null);
    try {
      let target = task;
      if (onResolve) {
        const resolved = await onResolve(sourceKind, sourceId, task);
        if (!liveRef.current) return;
        if (!resolved?.task) {
          setTask(null);
          setOutcome(null);
          setFailure("unavailable");
          return;
        }
        target = resolved.task;
        setTask(target);
        setOutcome("existing");
      }
      // The opener runs synchronously up to its first await, so a plain callback
      // still fires inside the click; awaiting is what keeps a rejection here.
      await onOpenTask?.(target);
    } catch (error) {
      if (!liveRef.current) return;
      if (isPermissionRefusal(error)) {
        setTask(null);
        setOutcome(null);
        setFailure("denied");
      } else if (isSourceGone(error)) {
        setTask(null);
        setOutcome(null);
        setFailure("unavailable");
      } else {
        setFailure("open");
      }
    } finally {
      busyRef.current = false;
      if (liveRef.current) setPhase(null);
    }
  }

  const rowClass = variant === "message" ? "source-task source-task--message" : "dialog-secondary-row";
  const status = task && <span role="status">{t(outcome === "created" ? "sourceTask.created" : "sourceTask.existing")}</span>;

  // Permission is gone: no control is left to offer, and retrying cannot help.
  if (failure === "denied") {
    return (
      <div className={rowClass}>
        <span role="alert">{t("sourceTask.denied")}</span>
      </div>
    );
  }
  if (task && onOpenTask) {
    return (
      <div className={rowClass}>
        {status}
        {failure === "open" && <span role="alert">{t("sourceTask.openError")}</span>}
        <BusyButton type="button" className={className} aria-describedby={describedBy} pending={phase === "opening"} onClick={open}>
          {t(phase === "opening" ? "sourceTask.opening" : "sourceTask.open")}
        </BusyButton>
      </div>
    );
  }
  return (
    <div className={rowClass}>
      {status}
      {failure === "create" && <span role="alert">{t("sourceTask.error")}</span>}
      {failure === "unavailable" && <span role="alert">{t("sourceTask.unavailable")}</span>}
      <BusyButton type="button" className={className} aria-describedby={describedBy} pending={phase === "creating"} onClick={create}>
        {t(phase === "creating" ? "sourceTask.creating" : "sourceTask.create")}
      </BusyButton>
    </div>
  );
}
