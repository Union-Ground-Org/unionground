import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { dateTimeFormat } from "../lib/i18n.js";
import { taskKey } from "../lib/kanban.js";
import { runBusyWrite } from "../lib/busyWrite.js";
import { BusyButton, BusyInput, BusyTextarea } from "../components/BusyControls.jsx";

const MENTION_CHIP_LIMIT = 12;

function compareCommentAscending(a, b) {
  return String(a.createdAt).localeCompare(String(b.createdAt))
    || String(a.id).localeCompare(String(b.id));
}

function compareCommentDescending(a, b) {
  return String(b.createdAt).localeCompare(String(a.createdAt))
    || String(b.id).localeCompare(String(a.id));
}

function finiteTaskNumber(task) {
  const number = Number(task.taskNumber);
  return Number.isFinite(number) ? number : Number.POSITIVE_INFINITY;
}

export function TaskFieldNotesView({
  tasks,
  comments,
  commentsUnavailable = false,
  commentsTruncated = false,
  assignees,
  memberId,
  chapterId,
  doneVisible,
  demo,
  lang,
  t,
  onOpen,
  onCreate,
  onAddComment,
  packet = null,
}) {
  const eligibleTasks = useMemo(
    () => tasks.filter((task) => doneVisible || task.status !== "done"),
    [doneVisible, tasks],
  );
  const visibleTaskIds = useMemo(() => new Set(eligibleTasks.map((task) => task.id)), [eligibleTasks]);
  const visibleComments = useMemo(
    () => comments
      .filter((comment) => visibleTaskIds.has(comment.taskId) && comment.chapterId === chapterId)
      .sort(compareCommentDescending),
    [chapterId, comments, visibleTaskIds],
  );
  const commentsByTask = useMemo(() => {
    const grouped = new Map();
    for (const comment of visibleComments) {
      if (!grouped.has(comment.taskId)) grouped.set(comment.taskId, []);
      grouped.get(comment.taskId).push(comment);
    }
    for (const rows of grouped.values()) rows.sort(compareCommentAscending);
    return grouped;
  }, [visibleComments]);
  const indexTasks = useMemo(() => [...eligibleTasks].sort((a, b) => {
    const aLatest = commentsByTask.get(a.id)?.at(-1);
    const bLatest = commentsByTask.get(b.id)?.at(-1);
    if (aLatest && bLatest) return compareCommentDescending(aLatest, bLatest) || String(a.id).localeCompare(String(b.id));
    if (aLatest) return -1;
    if (bLatest) return 1;
    return finiteTaskNumber(a) - finiteTaskNumber(b) || String(a.id).localeCompare(String(b.id));
  }), [commentsByTask, eligibleTasks]);

  const [selectedId, setSelectedId] = useState(() => indexTasks[0]?.id || null);
  const [drafts, setDrafts] = useState({});
  const [mentions, setMentions] = useState({});
  const [busy, setBusy] = useState(false);
  // A note save's outcome belongs to the task it
  // was for, one message per task, so work on another task never drops it.
  const [messages, setMessages] = useState({});
  // The messages belong to one member in one
  // chapter, and only to tasks still in the list, so the map stays bounded
  // and no message carries to another member or chapter.
  const messageScope = JSON.stringify([memberId ?? null, chapterId ?? null]);
  const messageScopeRef = useRef(messageScope);
  // Each change of member or chapter starts a new
  // generation, so a round trip back to an earlier member does not admit an
  // answer from before it; an answer is kept only while its task is listed.
  const messageGenerationRef = useRef(0);
  const listedTaskIdsRef = useRef(new Set());
  const composerRef = useRef(null);
  // Synchronous write locks: the note save and the packet draft each
  // refuse a second activation before React commits their busy state.
  const busyWriteRef = useRef(new Set());
  const focusRequestRef = useRef(null);
  const [focusSettlement, setFocusSettlement] = useState(0);

  useLayoutEffect(() => {
    if (messageScopeRef.current === messageScope) return;
    messageScopeRef.current = messageScope;
    messageGenerationRef.current += 1;
    setMessages({});
  }, [messageScope]);

  useLayoutEffect(() => {
    listedTaskIdsRef.current = new Set(indexTasks.map((task) => task.id));
    setMessages((current) => {
      const listed = {};
      for (const task of indexTasks) if (task.id in current) listed[task.id] = current[task.id];
      return Object.keys(listed).length === Object.keys(current).length ? current : listed;
    });
  }, [indexTasks]);

  useEffect(() => {
    if (!indexTasks.some((task) => task.id === selectedId)) {
      setSelectedId(indexTasks[0]?.id || null);
    }
  }, [indexTasks, selectedId]);

  const selectedTask = indexTasks.find((task) => task.id === selectedId) || indexTasks[0] || null;
  const selectedTaskId = selectedTask?.id;
  const selectedMessage = messages[selectedTaskId];
  const selectedComments = selectedTask ? commentsByTask.get(selectedTask.id) || [] : [];
  const body = selectedTask ? drafts[selectedTask.id] || "" : "";
  const selectedMentions = selectedTask ? mentions[selectedTask.id] || [] : [];
  const peopleById = useMemo(() => new Map(assignees.map((person) => [person.id, person])), [assignees]);
  // Design pass 2026-09-13: production rendered the same first name up to 38
  // times because `assignees` carries one entry per assignment. One chip per
  // person, sorted, and only the first dozen until the author asks for more.
  const mentionCandidates = useMemo(() => {
    const seen = new Set();
    return assignees
      .filter((person) => person.id && person.id !== memberId && person.fullName)
      .filter((person) => (seen.has(person.id) ? false : (seen.add(person.id), true)))
      .sort((a, b) => a.fullName.localeCompare(b.fullName, lang));
  }, [assignees, memberId, lang]);
  const [showAllMentions, setShowAllMentions] = useState(false);
  const visibleMentions = showAllMentions ? mentionCandidates : mentionCandidates.slice(0, MENTION_CHIP_LIMIT);
  const stamp = useMemo(
    () => dateTimeFormat(lang, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }),
    [lang],
  );

  useLayoutEffect(() => () => focusRequestRef.current?.cancel(), [selectedTaskId, memberId, chapterId]);

  useLayoutEffect(() => {
    const request = focusRequestRef.current;
    if (busy || !request?.settled) return;
    const composer = composerRef.current;
    const restore = composer === request.composer
      && composer.isConnected && !composer.disabled
      && request.taskId === selectedTaskId && request.memberId === memberId && request.chapterId === chapterId
      && request.canRestore();
    request.cancel();
    if (restore) composer.focus();
  }, [busy, focusSettlement, selectedTaskId, memberId, chapterId]);

  // REQ-UG-FIELD-NOTES-AI-PACKET-20261001: pick notes on this task and ask
  // Compass for a draft packet. `packet` is null unless the organization has
  // both AI switches on; the server enforces them again and re-reads every
  // note, so this only decides whether the control is offered.
  const [packetOpen, setPacketOpen] = useState(false);
  const [packetSelection, setPacketSelection] = useState([]);
  const [packetBusy, setPacketBusy] = useState(false);
  const [packetDraft, setPacketDraft] = useState(null);
  const [packetSources, setPacketSources] = useState([]);
  const [packetError, setPacketError] = useState("");
  const packetRequestRef = useRef(0);
  // closePacket ends a running draft's busy state (Cancel, or another task,
  // member or chapter), so it ends that draft's lock too.
  const packetUnlockRef = useRef(null);
  const packetAvailable = Boolean(packet);
  const packetLimit = packet?.noteLimit || 0;
  // Bounded by the note limit, so a plain filter is cheaper than memoizing it
  // against a list that is rebuilt whenever the thread changes.
  const packetSelected = packetSelection.filter((id) => selectedComments.some((comment) => comment.id === id));

  function closePacket() {
    packetRequestRef.current += 1;
    packetUnlockRef.current?.();
    packetUnlockRef.current = null;
    setPacketBusy(false);
    setPacketOpen(false);
    setPacketSelection([]);
    setPacketDraft(null);
    setPacketSources([]);
    setPacketError("");
  }

  useLayoutEffect(() => {
    closePacket();
    // Invalidate before a different context can render, and on unmount. A
    // return to the same task/member must not revive its old response.
    return () => { packetRequestRef.current += 1; };
  }, [selectedTaskId, chapterId, memberId, packetAvailable]);

  function togglePacketNote(noteId) {
    packetRequestRef.current += 1;
    setPacketError("");
    setPacketDraft(null);
    setPacketSources([]);
    setPacketSelection((current) => {
      if (current.includes(noteId)) return current.filter((id) => id !== noteId);
      if (current.length >= packetLimit) return current;
      return [...current, noteId];
    });
  }

  function draftPacket(event) {
    event.preventDefault();
    return runBusyWrite(busyWriteRef, "packet", (unlock) => draftPacketNow(unlock), event);
  }

  async function draftPacketNow(unlock) {
    if (!selectedTask || packetBusy) return;
    if (!packetSelected.length) { setPacketError(t("fieldNotes.packet.needNotes")); return; }
    const requestId = ++packetRequestRef.current;
    packetUnlockRef.current = unlock;
    setPacketBusy(true);
    setPacketError("");
    setPacketDraft(null);
    setPacketSources([]);
    try {
      const result = await packet.draft(selectedTask.id, packetSelected);
      if (requestId !== packetRequestRef.current) return;
      setPacketDraft(result.packet);
      setPacketSources(result.sources);
    } catch (failure) {
      if (requestId !== packetRequestRef.current) return;
      const code = typeof failure?.code === "string" ? failure.code : "";
      const message = code ? t(`fieldNotes.packet.${code}`) : t("fieldNotes.packet.failed");
      setPacketError(message === `fieldNotes.packet.${code}` ? t("fieldNotes.packet.failed") : message);
    } finally {
      if (requestId === packetRequestRef.current) {
        unlock();
        packetUnlockRef.current = null;
        setPacketBusy(false);
      }
    }
  }

  function chooseTask(taskId) {
    focusRequestRef.current?.cancel();
    setSelectedId(taskId);
    // The task left behind loses its own message, as before; every other
    // task keeps an outcome its member has not seen yet.
    if (taskId !== selectedTaskId) dropMessage(selectedTaskId);
  }

  function dropMessage(taskId) {
    setMessages((current) => {
      if (!(taskId in current)) return current;
      const next = { ...current };
      delete next[taskId];
      return next;
    });
  }

  function updateBody(value) {
    if (!selectedTask) return;
    setDrafts((current) => ({ ...current, [selectedTask.id]: value }));
    dropMessage(selectedTask.id);
  }

  function toggleMention(id) {
    if (!selectedTask) return;
    setMentions((current) => {
      const taskMentions = new Set(current[selectedTask.id] || []);
      if (taskMentions.has(id)) taskMentions.delete(id);
      else taskMentions.add(id);
      return { ...current, [selectedTask.id]: [...taskMentions] };
    });
  }

  function submit(event) {
    event.preventDefault();
    return runBusyWrite(busyWriteRef, "note", (unlock) => submitNow(event, unlock), event);
  }

  async function submitNow(event, unlock) {
    const text = body.trim();
    if (!selectedTask || !text || text.length > 2000 || busy) return;
    focusRequestRef.current?.cancel();
    const composer = composerRef.current;
    const ownerDocument = composer.ownerDocument;
    const origin = ownerDocument.activeElement;
    const originInForm = event.currentTarget.contains(origin);
    const requestGeneration = messageGenerationRef.current;
    const request = {
      composer, taskId: selectedTask.id, memberId, chapterId, settled: false,
      canRestore: () => (originInForm || origin === ownerDocument.body)
        && (ownerDocument.activeElement === composer
        || ownerDocument.activeElement === ownerDocument.body
        || (originInForm && ownerDocument.activeElement === origin)),
      cancel: () => {
        ownerDocument.removeEventListener("focusin", cancelOnFocus, true);
        if (focusRequestRef.current === request) focusRequestRef.current = null;
      },
    };
    function cancelOnFocus(event) {
      if (event.target !== composer && event.target !== ownerDocument.body) request.cancel();
    }
    focusRequestRef.current = request;
    ownerDocument.addEventListener("focusin", cancelOnFocus, true);
    setBusy(true);
    dropMessage(request.taskId);
    // An outcome that answers after the member or chapter changed, even back
    // to the same values, or while its task is not listed, is not shown.
    const keepOutcome = (message) => {
      if (messageGenerationRef.current !== requestGeneration || !listedTaskIdsRef.current.has(request.taskId)) return;
      setMessages((current) => ({ ...current, [request.taskId]: message }));
    };
    try {
      const created = await onAddComment?.(selectedTask.id, text, [...new Set(selectedMentions)]);
      if (!created) throw new Error("comment unavailable");
      setDrafts((current) => ({ ...current, [selectedTask.id]: "" }));
      setMentions((current) => ({ ...current, [selectedTask.id]: [] }));
      keepOutcome({ kind: "notice", text: t("tasks.fieldNoteAdded") });
    } catch {
      keepOutcome({ kind: "error", text: t("tasks.fieldNoteFailed") });
    } finally {
      unlock();
      setBusy(false);
      if (focusRequestRef.current === request) {
        request.settled = true;
        // A distinct settlement also triggers the effect when an immediate
        // response batches busy=true/false into a single enabled commit.
        setFocusSettlement((current) => current + 1);
      }
    }
  }

  return (
    <section className="tasks-work-docket tasks-field-notes-view" aria-label={t("tasks.view.field_notes")}>
      <header className="tasks-work-docket__head">
        <div>
          <h2 className="task-owned" data-workspace-focus="">{t("tasks.fieldNotesTitle")}</h2>
          <p className="task-owned">{t("tasks.fieldNotesPermission")}</p>
        </div>
        <span>
          {demo && <b>{t("tasks.sampleSessionOnly")}</b>}
          <span>{t(visibleComments.length === 1 ? "tasks.fieldNoteOne" : "tasks.fieldNoteCount", { count: visibleComments.length })}</span>
        </span>
      </header>

      <div className="tasks-field-notes__notices">
        {commentsUnavailable && <p className="task-owned" role="alert">{t("tasks.fieldNotesUnavailable")}</p>}
        {commentsTruncated && <p className="task-owned" role="status">{t("tasks.fieldNotesTruncated")}</p>}
      </div>

      {indexTasks.length === 0 ? (
        <div className="tasks-work-empty">
          <p className="task-owned">{t("tasks.fieldNotesNoTasks")}</p>
          <button type="button" onClick={onCreate}>{t("tasks.new")}</button>
        </div>
      ) : (
        <div className="tasks-field-notes__workspace">
          <ul className="tasks-field-notes__index" aria-label={t("tasks.fieldNotesIndex")}>
            {indexTasks.map((task) => {
              const rows = commentsByTask.get(task.id) || [];
              const latest = rows.at(-1);
              return (
                <li className="task-owned" key={task.id}>
                  <button className="task-owned"
                    type="button"
                    aria-current={task.id === selectedTask?.id ? "true" : undefined}
                    onClick={() => chooseTask(task.id)}
                  >
                    <strong className="task-owned">{task.title}</strong>
                    {task.unitName && <span className="task-owned">{task.unitName}</span>}
                    <small className="task-owned">{[taskKey(task, chapterId), task.workstream, t(`tasks.status.${task.status}`)].filter(Boolean).join(" · ")}</small>
                    <span className="task-owned">
                      {t(rows.length === 1 ? "tasks.fieldNoteOne" : "tasks.fieldNoteCount", { count: rows.length })}
                      {latest && <time dateTime={latest.createdAt}>{stamp.format(new Date(latest.createdAt))}</time>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          <section className="tasks-field-notes__detail" aria-label={t("tasks.fieldNotesThread", { task: selectedTask.title })}>
            <header>
              <div>
                <span>{taskKey(selectedTask, chapterId)}</span>
                <h3>{selectedTask.title}</h3>
                <p>{[selectedTask.workstream, t(`tasks.status.${selectedTask.status}`)].filter(Boolean).join(" · ")}</p>
              </div>
              <div>
                <button className="task-owned" type="button" onClick={() => composerRef.current?.focus()}>{t("tasks.newFieldNote")}</button>
                {packet && selectedComments.length > 0 && (
                  <button className="task-owned" type="button" aria-expanded={packetOpen} onClick={() => (packetOpen ? closePacket() : setPacketOpen(true))}>
                    {t("fieldNotes.packet.open")}
                  </button>
                )}
                <button className="task-owned" type="button" onClick={() => onOpen(selectedTask)} aria-label={t("tasks.openFieldNotes", { task: selectedTask.title })}>
                  {t("tasks.openTask")}
                </button>
              </div>
            </header>

            <div className="tasks-field-notes__thread" role="feed" aria-label={t("tasks.fieldNotesThread", { task: selectedTask.title })}>
              {selectedComments.length === 0 && (!commentsUnavailable || commentsTruncated) && (
                <p className="tasks-field-notes__empty">
                  {commentsTruncated ? t("tasks.fieldNotesEmptyTruncated") : t("tasks.fieldNotesEmpty")}
                </p>
              )}
              {selectedComments.map((comment) => {
                const mine = comment.authorId === memberId;
                return (
                  <article key={comment.id} className={mine ? "tasks-field-note tasks-field-note--mine" : "tasks-field-note"}>
                    <header className="task-owned">
                      <strong>{mine ? t("tasks.you") : peopleById.get(comment.authorId)?.fullName || t("tasks.chapterMember")}</strong>
                      <time dateTime={comment.createdAt}>{stamp.format(new Date(comment.createdAt))}</time>
                    </header>
                    <p className="task-owned">{comment.body}</p>
                  </article>
                );
              })}
            </div>

            {packet && packetOpen && (
              <form className="tasks-field-notes__packet" onSubmit={draftPacket} aria-label={t("fieldNotes.packet.title")}>
                <h4 className="task-owned">{t("fieldNotes.packet.title")}</h4>
                <p>{t("fieldNotes.packet.intro")}</p>
                <ul className="tasks-field-notes__packet-picker">
                  {selectedComments.map((comment) => {
                    const chosen = packetSelected.includes(comment.id);
                    return (
                      <li key={comment.id}>
                        <label className="task-owned">
                          <BusyInput
                            type="checkbox"
                            checked={chosen}
                            pending={packetBusy}
                            disabled={!chosen && packetSelected.length >= packetLimit}
                            onChange={() => togglePacketNote(comment.id)}
                          />
                          <span className="visually-hidden">{t("fieldNotes.packet.selectLabel")}</span>
                          <time className="task-owned" dateTime={comment.createdAt}>{stamp.format(new Date(comment.createdAt))}</time>
                          <span>{comment.body}</span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
                <footer className="task-owned">
                  <small>{t("fieldNotes.packet.selected", { count: packetSelected.length, limit: packetLimit })}</small>
                  {packetSelected.length >= packetLimit && <small>{t("fieldNotes.packet.limitReached", { limit: packetLimit })}</small>}
                  <BusyButton className="task-owned" type="submit" pending={packetBusy} disabled={packetSelected.length === 0}>
                    {packetBusy ? t("fieldNotes.packet.working") : t("fieldNotes.packet.submit")}
                  </BusyButton>
                  <BusyButton className="task-owned" type="button" onClick={closePacket} pending={packetBusy}>{t("fieldNotes.packet.cancel")}</BusyButton>
                </footer>
                {packetError && <p className="tasks-error" role="alert">{packetError}</p>}
                {packetDraft && (
                  <article className="tasks-field-notes__packet-draft" aria-label={t("fieldNotes.packet.draftLabel")}>
                    <p className="tasks-field-notes__packet-badge task-owned">{t("fieldNotes.packet.draftLabel")}</p>
                    <h5 className="task-owned">{packetDraft.headline}</h5>
                    <h6 className="task-owned">{t("fieldNotes.packet.summary")}</h6>
                    <p className="task-owned">{packetDraft.summary}</p>
                    <h6 className="task-owned">{t("fieldNotes.packet.plainLanguage")}</h6>
                    <p className="task-owned">{packetDraft.plainLanguage}</p>
                    {packetDraft.checklist.length > 0 && (
                      <>
                        <h6 className="task-owned">{t("fieldNotes.packet.checklist")}</h6>
                        <ul className="task-owned">{packetDraft.checklist.map((item, index) => <li className="task-owned" key={`check-${index}`}>{item}</li>)}</ul>
                      </>
                    )}
                    {packetDraft.questions.length > 0 && (
                      <>
                        <h6 className="task-owned">{t("fieldNotes.packet.questions")}</h6>
                        <ul className="task-owned">{packetDraft.questions.map((item, index) => <li className="task-owned" key={`ask-${index}`}>{item}</li>)}</ul>
                      </>
                    )}
                    <h6 className="task-owned">{t("fieldNotes.packet.sources")}</h6>
                    {packetDraft.citations.length === 0 ? (
                      <p className="task-owned">{t("fieldNotes.packet.noSources")}</p>
                    ) : (
                      <ul className="task-owned">
                        {packetDraft.citations.map((citation) => {
                          const source = packetSources.find((row) => row.marker === citation.marker);
                          return <li className="task-owned" key={citation.marker}>{[citation.title, source?.ref].filter(Boolean).join(" · ")}</li>;
                        })}
                      </ul>
                    )}
                  </article>
                )}
              </form>
            )}

            <form className="tasks-field-notes__composer" onSubmit={submit}>
              <label>
                <span className="visually-hidden">{t("tasks.fieldNotePlaceholder")}</span>
                <BusyTextarea className="task-owned"
                  ref={composerRef}
                  value={body}
                  onChange={(event) => updateBody(event.target.value)}
                  placeholder={t("tasks.fieldNotePlaceholder")}
                  maxLength={2000}
                  pending={busy}
                  required
                />
              </label>
              <div className="tasks-field-notes__mentions" aria-label={t("tasks.fieldNoteMentions")}>
                <span>{t("tasks.fieldNoteMentions")}</span>
                {visibleMentions.map((person) => (
                  <button className="task-owned"
                    key={person.id}
                    type="button"
                    title={person.fullName}
                    aria-pressed={selectedMentions.includes(person.id)}
                    onClick={() => toggleMention(person.id)}
                  >
                    @{person.fullName}{mentionCandidates.some((other) => other.id !== person.id && other.fullName === person.fullName) ? ` (${person.id})` : ""}
                  </button>
                ))}
                {!showAllMentions && mentionCandidates.length > MENTION_CHIP_LIMIT ? (
                  <button type="button" className="tasks-field-notes__mentions-more task-owned" onClick={() => setShowAllMentions(true)}>
                    {t("tasks.fieldNoteMentionsMore", { count: mentionCandidates.length - MENTION_CHIP_LIMIT })}
                  </button>
                ) : null}
              </div>
              <footer className="task-owned">
                <small>{body.length}/2000</small>
                <BusyButton className="task-owned" type="submit" pending={busy} disabled={!body.trim()}>
                  {busy ? t("tasks.addingFieldNote") : t("tasks.addFieldNote")}
                </BusyButton>
              </footer>
              {/* A note save's outcome belongs to the task it was for (tooling
                  ledger 445): one that answers after a task switch shows only
                  when that task is open again. */}
              {selectedMessage?.kind === "error" && <p className="tasks-error" role="alert">{selectedMessage.text}</p>}
              <p className="visually-hidden" role="status" aria-live="polite">{selectedMessage?.kind === "notice" ? selectedMessage.text : ""}</p>
            </form>
          </section>
        </div>
      )}
    </section>
  );
}
