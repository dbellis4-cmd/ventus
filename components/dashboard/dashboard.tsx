"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { addDays, formatDate, formatTime, startOfWeek, validDate } from "@/lib/tasks/dates";
import type { ReadTask, Workspace } from "@/lib/tasks/projections";
import { Icon } from "./icon";
import { TimezoneSetup } from "./timezone-setup";
import { TaskModal } from "./task-modal";
import { changeTaskLifecycle, getTaskEditor } from "@/app/task-actions";
import type { TaskEditor } from "@/lib/tasks/editor";
import { LifecycleDialog, type LifecycleMode } from "./lifecycle-dialog";
import { LogoutButton } from "@/components/auth/logout-button";

export function Dashboard({ workspace }: { workspace: Workspace }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [view, setView] = useState("Dashboard");
  const [editor, setEditor] = useState<TaskEditor | null>(null);
  const [lifecycle, setLifecycle] = useState<{ mode: LifecycleMode; editor: TaskEditor } | null>(null);
  const [editorLoading, setEditorLoading] = useState(false);
  const [busyTask, setBusyTask] = useState<string | null>(null);
  const taskInFlight = useRef<string | null>(null);
  const [notice, setNotice] = useState("");
  const [noticeError, setNoticeError] = useState(false);
  const editorRequest = useRef(0);
  const ready = workspace.kind === "ready" ? workspace : null;
  const today = ready?.today ?? "2000-01-01";
  const selected = ready?.selected ?? today;
  const tasks = ready?.tasks ?? [];
  const week = startOfWeek(selected);
  const days = Array.from({ length: 7 }, (_, index) => addDays(week, index));
  const overdue = selected === today ? tasks.filter((task) => task.overdue) : [];
  const dayTasks = tasks.filter((task) => task.date === selected && !(selected === today && task.overdue));
  const scheduled = dayTasks.filter((task) => task.time).sort((a, b) => a.time.localeCompare(b.time) || a.id.localeCompare(b.id));
  const anytime = dayTasks.filter((task) => !task.time);

  function selectDay(date: string) {
    if (!validDate(date) || date < "0002-01-01" || date > "9998-12-31") return;
    editorRequest.current += 1;
    setEditorLoading(false);
    startTransition(() => router.push(`/?date=${date}`, { scroll: false }));
  }

  // Refresh deadlines and Today across midnight and when returning to this tab.
  // Every refresh goes through the server's verified session and owned reads.
  useEffect(() => {
    function refresh() { if (document.visibilityState === "visible") router.refresh(); }
    const interval = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [router]);

  async function openEditor(taskId: string | null = null) {
    const request = ++editorRequest.current;
    setEditorLoading(true); setNotice(""); setNoticeError(false);
    try {
      const result = await getTaskEditor(taskId);
      if (request !== editorRequest.current) return;
      if (result.ok) {
        const task = result.editor.nodes.find((node) => node.id === taskId);
        if (task && task.status !== "open") {
          setNotice(task.status === "completed" ? "Reopen this task with its checkbox before editing." : "Canceled tasks cannot be edited."); setNoticeError(true);
        } else setEditor(result.editor);
      } else { setNotice(result.message); setNoticeError(true); }
    } catch { if (request === editorRequest.current) { setNotice("Unable to load the task editor. Please try again."); setNoticeError(true); } }
    finally { if (request === editorRequest.current) setEditorLoading(false); }
  }

  function saved(date: string, refreshFailed: boolean) {
    setEditor(null); setLifecycle(null); setNotice(refreshFailed ? "Task saved. Refresh the Dashboard to see the latest data." : "Task saved."); setNoticeError(false);
    startTransition(() => { router.push(`/?date=${date}`, { scroll: false }); router.refresh(); });
  }

  async function toggleCompletion(task: ReadTask) {
    if (taskInFlight.current) return;
    taskInFlight.current = task.id; setBusyTask(task.id); setNotice("");
    try {
      const loaded = await getTaskEditor(task.id);
      if (!loaded.ok) { setNotice(loaded.message); setNoticeError(true); return; }
      const node = loaded.editor.nodes.find((item) => item.id === task.id);
      if (!node || node.status !== task.status || node.date !== task.scheduledDate) { setNotice("This task changed elsewhere. Refresh and try again."); setNoticeError(true); router.refresh(); return; }
      const result = await changeTaskLifecycle({ kind: "completion", taskId: task.id, rootVersion: loaded.editor.rootVersion,
        taskVersion: node.taskVersion, occurrenceVersion: node.occurrenceVersion, completed: task.status !== "completed" });
      if (result.ok) saved(result.date, !!result.refreshFailed);
      else { setNotice(result.message); setNoticeError(true); if (result.code !== "invalid") router.refresh(); }
    } catch { setNotice("The completion outcome is unknown. Refresh the Dashboard before trying again."); setNoticeError(true); router.refresh(); }
    finally { taskInFlight.current = null; setBusyTask(null); }
  }

  async function openLifecycle(task: ReadTask, mode: LifecycleMode) {
    if (taskInFlight.current) return;
    taskInFlight.current = task.id; setBusyTask(task.id); setNotice("");
    try {
      const result = await getTaskEditor(task.id);
      if (!result.ok) { setNotice(result.message); setNoticeError(true); return; }
      const node = result.editor.nodes.find((item) => item.id === task.id);
      if (!node || node.status !== task.status || node.date !== task.scheduledDate || (mode !== "delete" && node.status !== "open")) {
        setNotice("This task changed elsewhere. Refresh and try again."); setNoticeError(true); router.refresh(); return;
      }
      setLifecycle({ mode, editor: result.editor });
    } catch { setNotice("Unable to load this task. Please try again."); setNoticeError(true); }
    finally { taskInFlight.current = null; setBusyTask(null); }
  }

  function taskRow(task: ReadTask, isOverdue = false) {
    return <TaskRow key={task.occurrenceId} task={task} overdue={isOverdue} accountTimezone={ready!.timezone} loading={editorLoading || !!busyTask} onEdit={() => void openEditor(task.id)} onComplete={() => void toggleCompletion(task)} onLifecycle={(mode) => void openLifecycle(task, mode)} />;
  }

  return <div className="workspace">
    <a href="#main-content" className="skip-link">Skip to content</a>
    <aside className="sidebar">
      <button className="brand" onClick={() => { setView("Dashboard"); if (ready) selectDay(today); else router.refresh(); }} aria-label="Ventus home"><span className="brand-mark" aria-hidden="true">v</span>Ventus<span className="brand-period">.</span></button>
      <p className="nav-label">WORKSPACE</p>
      <nav aria-label="Main navigation">
        <button className={`nav-item ${view === "Dashboard" ? "active" : ""}`} aria-current={view === "Dashboard" ? "page" : undefined} onClick={() => setView("Dashboard")}><Icon name="dashboard" />Dashboard</button>
        <a className="nav-item" href="https://calendar.google.com/" target="_blank" rel="noopener noreferrer"><Icon name="calendar" />Calendar<span className="external-mark" aria-hidden="true">↗</span><span className="sr-only"> (opens Google Calendar in a new tab)</span></a>
        <button className={`nav-item ${view === "Performance" ? "active" : ""}`} aria-current={view === "Performance" ? "page" : undefined} onClick={() => setView("Performance")}><Icon name="performance" />Performance<span className="nav-soon">Later</span></button>
        <button className={`nav-item ${view === "Settings" ? "active" : ""}`} aria-current={view === "Settings" ? "page" : undefined} onClick={() => setView("Settings")}><Icon name="settings" />Settings</button>
      </nav>
      <LogoutButton />
    </aside>

    <main id="main-content" className="main-content">
      <header className="page-header"><h1>{view}</h1></header>
      {view === "Dashboard" ? workspace.kind === "setup" ? <TimezoneSetup /> : workspace.kind === "error" ? <section className="placeholder-panel" role="alert"><h2>Unable to load your workspace</h2><p>Your tasks could not be retrieved. Please try again.</p><button className="button secondary" onClick={() => router.refresh()}>Retry</button></section> : <>
        <section className="week-planner" aria-label="Weekly planner" aria-busy={pending}>
          <div className="week-toolbar"><div><h2>{formatDate(selected, { month: "long", year: "numeric" })}</h2><p>{formatDate(week, { month: "short", day: "numeric" })} – {formatDate(addDays(week, 6), { month: "short", day: "numeric", year: "numeric" })}</p></div>
            <div className="week-controls"><button className="button today-button" disabled={pending} onClick={() => selectDay(today)}>Today</button><div className="arrow-group"><button className="icon-button" aria-label="Previous week" disabled={pending || addDays(selected, -7) < "0002-01-01"} onClick={() => selectDay(addDays(selected, -7))}><Icon name="left" size={17} /></button><button className="icon-button" aria-label="Next week" disabled={pending || addDays(selected, 7) > "9998-12-31"} onClick={() => selectDay(addDays(selected, 7))}><Icon name="right" size={17} /></button></div></div>
          </div>
          <div className="week-scroll"><div className="day-grid">{days.map((date) => {
            const items = tasks.filter((task) => task.date === date || (date === today && task.overdue));
            const names = [...new Set(items.map((item) => item.categoryName))];
            return <button key={date} className={`day-card ${selected === date ? "selected" : ""}`} disabled={pending} aria-pressed={selected === date} aria-label={`${formatDate(date, { weekday: "long", month: "long", day: "numeric" })}, ${items.length} ${items.length === 1 ? "task" : "tasks"}${date === today ? ", today" : ""}`} onClick={() => selectDay(date)}>
              <span className="day-name">{formatDate(date, { weekday: "short" })}{date === today && <span className="today-dot" aria-label="Today" />}</span><span className="day-number">{formatDate(date, { day: "numeric" })}</span><span className="day-count">{items.length} {items.length === 1 ? "task" : "tasks"}</span><span className="day-categories" title={names.join(", ")}>{names.length ? `${names[0]}${names.length > 1 ? ` +${names.length - 1}` : ""}` : "No tasks planned"}</span>
            </button>;
          })}</div></div>
        </section>

        <section className="daily-panel" aria-labelledby="daily-heading" aria-busy={pending}>
          <p className="stage-notice" role={noticeError ? "alert" : "status"}>{editorLoading ? "Loading task editor…" : busyTask ? "Updating task…" : pending ? "Loading selected day…" : notice}</p>
          <div className="daily-header"><div><div className="daily-title"><h2 id="daily-heading">{formatDate(selected, { weekday: "long", month: "long", day: "numeric" })}</h2>{selected === today && <span className="small-tag">Today</span>}</div></div><button className="button primary" disabled={pending || editorLoading} onClick={() => void openEditor()}><Icon name="plus" size={17} />Add task</button></div>
          {overdue.length > 0 && <details className="overdue-panel"><summary><span className="overdue-title"><Icon name="warning" size={17} />Overdue<span className="overdue-count">{overdue.length}</span></span><span className="overdue-expand">View tasks<Icon name="down" size={16} /></span></summary><ul className="overdue-list">{overdue.map((task) => taskRow(task, true))}</ul></details>}
          <section className="task-section" aria-labelledby="scheduled-heading"><div className="section-heading"><h3 id="scheduled-heading">Scheduled Tasks</h3></div>{scheduled.length ? <ul className="task-list">{scheduled.map((task) => taskRow(task))}</ul> : <p className="empty-section">No scheduled tasks for this day.</p>}</section>
          <section className="task-section anytime-section" aria-labelledby="anytime-heading"><div className="section-heading"><h3 id="anytime-heading">Anytime Tasks</h3></div>{anytime.length ? <ul className="task-list">{anytime.map((task) => taskRow(task))}</ul> : <p className="empty-section">No anytime tasks for this day.</p>}
            <button className="add-inline" disabled={pending || editorLoading} onClick={() => void openEditor()}><Icon name="plus" size={16} />Add another task</button>
          </section>
        </section>
      </> : <section className="placeholder-panel"><span className="small-tag">Not implemented yet</span><h2>{view === "Performance" ? "Performance arrives in Phase 2." : "Settings will be available in a later milestone."}</h2><p>{view === "Performance" ? "Points, rankings, and analytics are outside this preview." : "Account preferences and calendar connections are not connected in this preview."}</p><button className="button secondary" onClick={() => setView("Dashboard")}>Back to Dashboard</button></section>}
      {ready && <footer className="preview-note"><span className="local-indicator" />Workspace timezone: {ready.timezone}</footer>}
      <p className="sr-only" role="status" aria-live="polite">{pending ? "Loading selected day…" : ready ? `Showing ${formatDate(selected, { weekday: "long", month: "long", day: "numeric" })}.` : ""}</p>
    </main>
    {editor && <TaskModal editor={editor} date={selected} onSaved={saved} onClose={() => setEditor(null)} onDelete={(current) => { setEditor(null); setLifecycle({ mode: "delete", editor: current }); }} />}
    {lifecycle && <LifecycleDialog editor={lifecycle.editor} mode={lifecycle.mode} onSaved={saved} onClose={() => { setLifecycle(null); router.refresh(); }} />}
  </div>;
}

function TaskRow({ task, overdue, accountTimezone, loading, onEdit, onComplete, onLifecycle }: { task: ReadTask; overdue: boolean; accountTimezone: string; loading: boolean; onEdit: () => void; onComplete: () => void; onLifecycle: (mode: LifecycleMode) => void }) {
  const original = `${formatDate(task.originalDate, { month: "short", day: "numeric", year: "numeric" })}${task.originalTime ? ` ${formatTime(task.originalTime)}` : ""} (${task.originalTimezone})`;
  return <li className={`task-row ${task.status}`} title={`Originally scheduled: ${original}`}>
    <input className="completion-checkbox" type="checkbox" aria-label={`${task.status === "completed" ? "Reopen" : "Complete"} ${task.title}`} checked={task.status === "completed"} disabled={loading || task.status === "canceled"} onChange={onComplete} />
    <div className="task-time">{overdue ? <span className="due-label">{formatDate(task.originalDate, { month: "short", day: "numeric" })}{task.originalTime && <small>{formatTime(task.originalTime)}</small>}</span> : task.time ? <time dateTime={`${task.scheduledDate}T${task.time}`}>{formatTime(task.time)}</time> : <span className="anytime-dash" aria-hidden="true">—</span>}</div>
    <div className="task-name"><button className="task-title" disabled={loading || task.status !== "open"} title={task.status === "open" ? "Edit task" : "Reopen completed tasks before editing; canceled tasks cannot be edited."} onClick={onEdit}>{task.title}</button>{task.parentTitle && <span className="parent-label">Subtask of {task.parentTitle}</span>}{task.timezone !== accountTimezone && <span className="parent-label">{task.timezone}</span>}{task.date !== task.scheduledDate && <span className="sr-only">Originally scheduled: {original}</span>}</div>
    <span className={`category-label category-${task.categoryStyle}`}>{task.categoryName}</span>
    <details className="row-menu" onKeyDown={(event) => { if (event.key === "Escape") { event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); } }}>
      <summary aria-label={`Actions for ${task.title}`}><span aria-hidden="true">···</span></summary>
      <div className="row-menu-content"><button disabled={loading || task.status !== "open"} onClick={(event) => { event.currentTarget.closest("details")!.open = false; onLifecycle("postpone"); }}>Postpone</button><button disabled={loading || task.status !== "open"} onClick={(event) => { event.currentTarget.closest("details")!.open = false; onLifecycle("cancel"); }}>Cancel task</button><button className="danger" disabled={loading} onClick={(event) => { event.currentTarget.closest("details")!.open = false; onLifecycle("delete"); }}>Delete</button></div>
    </details>
  </li>;
}
