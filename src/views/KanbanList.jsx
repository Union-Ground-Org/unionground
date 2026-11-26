import { useEffect, useMemo, useRef, useState } from "react";
import { BusyButton } from "../components/BusyControls.jsx";
import { runBusyWrite } from "../lib/busyWrite.js";
import { Plus } from "lucide-react";
import { useDeviceParityState } from "../lib/deviceParity.js";
import { STATUS_IDS, byBoardOrder } from "../lib/kanban.js";
import { TrackerRow } from "../components/TrackerRow.jsx";
import { TrackerStageGroup } from "../components/TrackerStageGroup.jsx";
import { classifyDeadline, localDateKey } from "../lib/taskSchedule.js";
import { limitTaskTitle } from "../lib/taskTitle.js";

export function groupListTasks(
  tasks,
  groupBy,
  workstreamNames = [],
  unassignedLabel = "Unassigned",
  statusLabel = (status) => status,
) {
  const statusRank = new Map(STATUS_IDS.map((status, index) => [status, index]));
  if (groupBy === "status") {
    // Seed every canonical status in board order, including empty groups;
    // ids stay raw and deterministic, only the display name is localized.
    const byStatus = new Map(STATUS_IDS.map((status) => [status, []]));
    for (const task of tasks) {
      if (!byStatus.has(task.status)) byStatus.set(task.status, []);
      byStatus.get(task.status).push(task);
    }
    return STATUS_IDS.map((status) => ({
      id: `status:${status}`,
      name: statusLabel(status),
      tasks: [...(byStatus.get(status) ?? [])].sort(byBoardOrder),
    }));
  }
  const groups = new Map();
  if (groupBy === "workstream") {
    for (const name of workstreamNames) groups.set(name, []);
  }
  for (const task of tasks) {
    const key = groupBy === "assignee" ? (task.assigneeName || unassignedLabel) : task.workstream;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(task);
  }
  const out = [...groups.entries()].map(([name, rows]) => ({
    id: groupBy === "assignee"
      ? (name === unassignedLabel ? "assignee:unassigned" : `assignee:${name}`)
      : `workstream:${name}`,
    name,
    tasks: [...rows].sort((a, b) =>
      (statusRank.get(a.status) ?? 99) - (statusRank.get(b.status) ?? 99)
      || byBoardOrder(a, b)),
  }));
  if (groupBy === "assignee") out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function ListComposer({ group, t, onCreate }) {
  const composerKey = encodeURIComponent(group);
  const [open, setOpen] = useDeviceParityState(`tasks.list.composer.${composerKey}.open`, false);
  const [title, setTitle] = useDeviceParityState(`tasks.list.composer.${composerKey}.title`, "");
  const [busy, setBusy] = useState(false);
  // Synchronous write lock (#8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  const addButtonRef = useRef(null);
  const inputRef = useRef(null);
  const openedOnMountRef = useRef(open);
  const restoreAddFocusRef = useRef(false);

  useEffect(() => {
    if (open) {
      if (!openedOnMountRef.current) inputRef.current?.focus();
    } else if (restoreAddFocusRef.current) {
      restoreAddFocusRef.current = false;
      addButtonRef.current?.focus();
    }
    openedOnMountRef.current = open;
  }, [open]);

  function submit(event) {
    return runBusyWrite(busyWriteRef, "create", () => submitNow(event), event);
  }

  async function submitNow(event) {
    event.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      await onCreate(group, "to_do", title.trim());
      restoreAddFocusRef.current = true;
      setTitle("");
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  function cancel() {
    restoreAddFocusRef.current = true;
    setOpen(false);
    setTitle("");
  }

  if (!open) {
    return (
      <button ref={addButtonRef} type="button" className="kan-list__add" onClick={() => setOpen(true)}>
        <Plus size={15} aria-hidden="true" /> {t("kanban.newTask")}
      </button>
    );
  }
  return (
    <form className="kan-list__composer" onSubmit={submit}>
      <label className="task-owned">
        <span className="visually-hidden">{t("tasks.taskTitle")}</span>
        <input className="task-owned" ref={inputRef} value={title} onChange={(event) => setTitle(limitTaskTitle(event.target.value, title))} placeholder={t("tasks.taskTitle")} />
      </label>
      <BusyButton className="task-owned" type="submit" pending={busy} disabled={!title.trim()}>{t("tasks.add")}</BusyButton>
      <button className="task-owned" type="button" onClick={cancel} aria-label={t("tasks.cancel")}>×</button>
    </form>
  );
}


export function KanbanList({
  tasks,
  emptyNote = null,
  workstreamNames,
  chapterId,
  t,
  lang,
  doneVisible,
  onOpenTask,
  onCycleStatus,
  onCreateInline,
  onCreateDefault,
  depCounts,
  subtaskCounts,
  desktopWork = false,
}) {
  // Shared and desktop-local hooks both run unconditionally so a runtime
  // desktop/tablet resize can never change hook order. The non-desktop
  // selector accepts only Workstream/Assignee, so the desktop Status default
  // lives in its own key and never writes tasks.list.groupBy.
  const [groupBy, setGroupBy] = useDeviceParityState("tasks.list.groupBy", "workstream");
  const [collapsed, setCollapsed] = useDeviceParityState("tasks.list.collapsed", () => new Set());
  const [revealedDone, setRevealedDone] = useDeviceParityState("tasks.list.revealedDone", () => new Set());
  const [desktopGroupBy, setDesktopGroupBy] = useState("status");
  const [desktopCollapsed, setDesktopCollapsed] = useState(() => new Set());
  const [desktopRevealedDone, setDesktopRevealedDone] = useState(() => new Set());
  const groups = useMemo(
    () => groupListTasks(tasks, groupBy, workstreamNames, t("tasks.unassigned")),
    [groupBy, tasks, t, workstreamNames],
  );
  const desktopGroups = useMemo(
    () => groupListTasks(tasks, desktopGroupBy, workstreamNames, t("tasks.unassigned"),
      (status) => t(`tasks.status.${status}`)),
    [desktopGroupBy, tasks, t, workstreamNames],
  );
  const todayKey = localDateKey();

  function toggleGroup(name) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }

  function toggleDesktopGroup(id) {
    setDesktopCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  if (desktopWork) {
    return (
      <section className="kan-list kan-list--desktop" aria-label={t("tasks.view.list")}>
        <div className="kan-list__toolbar">
          <label className="task-owned">
            <span>{t("kanban.groupBy")}</span>
            <select className="task-owned"
              value={desktopGroupBy}
              onChange={(event) => {
                setDesktopGroupBy(event.target.value);
                setDesktopCollapsed(new Set());
                setDesktopRevealedDone(new Set());
              }}
            >
              <option value="status">{t("tasks.statusLabel")}</option>
              <option value="workstream">{t("tasks.workstream")}</option>
              <option value="assignee">{t("tasks.assignee")}</option>
            </select>
          </label>
          {(desktopGroupBy !== "workstream" || tasks.length === 0) && onCreateDefault && (
            <button type="button" className="kan-list__add" onClick={() => onCreateDefault()}>
              <Plus size={15} aria-hidden="true" /> {t("kanban.newTask")}
            </button>
          )}
          <span>{t("tasks.window60")}</span>
        </div>
        {tasks.length === 0 ? (
          <div className="kan-list__empty">
            {emptyNote ?? <p>{t("tasks.list.emptyDesktop")}</p>}
          </div>
        ) : (
          <div className="kan-list__scroll">
            <div className="kan-list__inner">
              <div className="kan-list__columns" aria-hidden="true">
                <span /><span>{t("kanban.key")}</span><span>{t("tasks.taskTitle")}</span><span>{t("tasks.statusLabel")}</span><span>{t("tasks.assignee")}</span><span>{t("kanban.dueDate")}</span><span />
              </div>
              {desktopGroups.map((group) => {
                const isCollapsed = desktopCollapsed.has(group.id);
                const hiddenDone = !doneVisible && !desktopRevealedDone.has(group.id)
                  ? group.tasks.filter((task) => task.status === "done").length
                  : 0;
                const visible = hiddenDone ? group.tasks.filter((task) => task.status !== "done") : group.tasks;
                const panelId = `task-desktop-list-${encodeURIComponent(group.id)}`;
                return (
                  <TrackerStageGroup
                    key={group.id} dataGroup={group.id} id={panelId} name={group.name} count={group.tasks.length} rows={visible}
                    collapsed={isCollapsed} onToggle={() => toggleDesktopGroup(group.id)}
                    headerAction={desktopGroupBy === "workstream" && <ListComposer group={group.name} t={t} onCreate={onCreateInline} />}
                    showAllLabel={(count) => t("kanban.showAllTasks", { count })} showFewerLabel={t("kanban.showFewerTasks")}
                renderRow={(task) => (
                            <TrackerRow
                              key={task.id}
                              task={task}
                              chapterId={chapterId}
                              t={t}
                              lang={lang}
                              onOpenTask={onOpenTask}
                              onCycleStatus={onCycleStatus}
                              depCount={depCounts?.get(task.id) || 0}
                              subtaskCount={subtaskCounts?.get(task.id)}
                              urgency={classifyDeadline(task, todayKey)}
                            />
                          )}
                    onRevealRows={hiddenDone > 0 ? () => setDesktopRevealedDone((current) => new Set([...current, group.id])) : undefined}
                    revealRowsLabel={t("kanban.showDone", { count: hiddenDone })}
                    revealRowsPage={Math.floor(group.tasks.findIndex((task) => task.status === "done") / 25) + 1}
                  />
                );
              })}
            </div>
          </div>
        )}
      </section>
    );
  }

  return (
    <section className="kan-list" aria-label={t("tasks.view.list")}>
      <div className="kan-list__toolbar">
        <label className="task-owned">
          <span>{t("kanban.groupBy")}</span>
          <select className="task-owned" value={groupBy} onChange={(event) => { setGroupBy(event.target.value); setCollapsed(new Set()); setRevealedDone(new Set()); }}>
            <option value="workstream">{t("tasks.workstream")}</option>
            <option value="assignee">{t("tasks.assignee")}</option>
          </select>
        </label>
        <span>{t("tasks.window60")}</span>
      </div>
      <div className="kan-list__scroll">
        <div className="kan-list__inner">
          <div className="kan-list__columns" aria-hidden="true">
            <span /><span>{t("kanban.key")}</span><span>{t("tasks.taskTitle")}</span><span>{t("tasks.statusLabel")}</span><span>{t("tasks.assignee")}</span><span>{t("kanban.dueDate")}</span><span />
          </div>
          {groups.map((group) => {
            const isCollapsed = collapsed.has(group.name);
            const hiddenDone = !doneVisible && !revealedDone.has(group.name)
              ? group.tasks.filter((task) => task.status === "done").length
              : 0;
            const visible = hiddenDone ? group.tasks.filter((task) => task.status !== "done") : group.tasks;
            const panelId = `task-list-${groupBy}-${encodeURIComponent(group.name)}`;
            return (
              <TrackerStageGroup
                key={group.id} id={panelId} name={group.name} count={group.tasks.length} rows={visible}
                collapsed={isCollapsed} onToggle={() => toggleGroup(group.name)}
                headerAction={groupBy === "workstream" && <ListComposer group={group.name} t={t} onCreate={onCreateInline} />}
                showAllLabel={(count) => t("kanban.showAllTasks", { count })} showFewerLabel={t("kanban.showFewerTasks")}
                renderRow={(task) => (
                        <TrackerRow
                          key={task.id}
                          task={task}
                          chapterId={chapterId}
                          t={t}
                          lang={lang}
                          onOpenTask={onOpenTask}
                          onCycleStatus={onCycleStatus}
                          depCount={depCounts?.get(task.id) || 0}
                          subtaskCount={subtaskCounts?.get(task.id)}
                          urgency={classifyDeadline(task, todayKey)}
                        />
                      )}
                onRevealRows={hiddenDone > 0 ? () => setRevealedDone((current) => new Set([...current, group.name])) : undefined}
                revealRowsLabel={t("kanban.showDone", { count: hiddenDone })}
                revealRowsPage={Math.floor(group.tasks.findIndex((task) => task.status === "done") / 25) + 1}
              />
            );
          })}
        </div>
      </div>
    </section>
  );
}
