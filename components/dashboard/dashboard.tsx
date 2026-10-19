"use client";

import { useState, useSyncExternalStore } from "react";
import { addDays, categoryFor, dateKey, formatDate, formatTime, sampleTasks, startOfWeek, type Task } from "@/lib/tasks/demo";
import { Icon } from "./icon";
import { TaskModal, type TaskDraft } from "./task-modal";

const subscribe = () => () => {};

function withoutBranch(tasks: Task[], id: string): Task[] {
  const removed = new Set([id]);
  let previousSize = 0;
  while (previousSize !== removed.size) {
    previousSize = removed.size;
    for (const task of tasks) if (task.parentId && removed.has(task.parentId)) removed.add(task.id);
  }
  return tasks.filter((task) => !removed.has(task.id));
}

export function Dashboard() {
  // Initialize dates in the browser's timezone, without a server hydration mismatch.
  const ready = useSyncExternalStore(subscribe, () => true, () => false);
  return ready ? <Planner /> : <main className="loading-shell" aria-busy="true">Loading your workspace…</main>;
}

function Planner() {
  const [today] = useState(() => dateKey(new Date()));
  const [selected, setSelected] = useState(today);
  const [tasks, setTasks] = useState<Task[]>(() => sampleTasks(today));
  const [view, setView] = useState("Dashboard");
  const [modal, setModal] = useState<{ task?: Task; postpone: boolean } | null>(null);
  const [notice, setNotice] = useState("");
  const week = startOfWeek(selected);
  const days = Array.from({ length: 7 }, (_, index) => addDays(week, index));
  const dayTasks = tasks.filter((task) => task.date === selected);
  const overdue = selected === today ? tasks.filter((task) => task.date < today && categoryFor(task.category).deadline && (task.status === "open" || (task.status === "completed" && task.completedOn === today))) : [];
  const scheduled = dayTasks.filter((task) => task.time).sort((a, b) => a.time.localeCompare(b.time));
  const anytime = dayTasks.filter((task) => !task.time);

  function save(draft: TaskDraft) {
    const { subtasks, ...task } = draft;
    setTasks((current) => {
      const keep = new Set(subtasks.map((sub) => sub.id));
      let next = current;
      for (const sub of current.filter((item) => item.parentId === task.id && !keep.has(item.id))) next = withoutBranch(next, sub.id);
      next = next.filter((item) => item.id !== task.id);
      next.push(task);
      for (const sub of subtasks) {
        const existing = next.find((item) => item.id === sub.id);
        next = next.filter((item) => item.id !== sub.id);
        next.push({ ...task, time: "", endTime: "", location: "", recurrence: "", recurrenceEnd: "", calendar: false, status: "open", completedOn: undefined, ...existing, ...sub, parentId: task.id });
      }
      return next;
    });
    setSelected(task.date);
    setNotice(modal?.postpone ? `Postponed “${task.title}”.` : `Saved “${task.title}”.`);
    setModal(null);
  }

  function remove(id: string) {
    const title = tasks.find((task) => task.id === id)?.title;
    setTasks((current) => withoutBranch(current, id));
    setModal(null);
    setNotice(`Deleted “${title}” and any subtasks.`);
  }

  function toggle(task: Task) {
    setTasks((current) => current.map((item) => item.id === task.id ? { ...item, status: item.status === "completed" ? "open" : "completed", completedOn: item.status === "completed" ? undefined : today } : item));
    setNotice(`${task.status === "completed" ? "Reopened" : "Completed"} “${task.title}”.`);
  }

  function cancel(task: Task) {
    setTasks((current) => current.map((item) => item.id === task.id ? { ...item, status: "canceled", completedOn: undefined } : item));
    setNotice(`Canceled “${task.title}”.`);
  }

  function taskRow(task: Task, isOverdue = false) {
    const parent = tasks.find((item) => item.id === task.parentId);
    return <TaskRow key={task.id} task={task} parent={parent?.title} overdue={isOverdue}
      onToggle={() => toggle(task)} onEdit={() => setModal({ task, postpone: false })}
      onPostpone={() => setModal({ task, postpone: true })} onCancel={() => cancel(task)} onDelete={() => remove(task.id)} />;
  }

  return <div className="workspace">
    <a href="#main-content" className="skip-link">Skip to content</a>
    <aside className="sidebar">
      <button className="brand" onClick={() => { setView("Dashboard"); setSelected(today); }} aria-label="Ventus home"><span className="brand-mark" aria-hidden="true">v</span>Ventus<span className="brand-period">.</span></button>
      <p className="nav-label">WORKSPACE</p>
      <nav aria-label="Main navigation">
        <button className={`nav-item ${view === "Dashboard" ? "active" : ""}`} aria-current={view === "Dashboard" ? "page" : undefined} onClick={() => setView("Dashboard")}><Icon name="dashboard" />Dashboard</button>
        <a className="nav-item" href="https://calendar.google.com/" target="_blank" rel="noopener noreferrer"><Icon name="calendar" />Calendar<span className="external-mark" aria-hidden="true">↗</span><span className="sr-only"> (opens Google Calendar in a new tab)</span></a>
        <button className={`nav-item ${view === "Performance" ? "active" : ""}`} aria-current={view === "Performance" ? "page" : undefined} onClick={() => setView("Performance")}><Icon name="performance" />Performance<span className="nav-soon">Later</span></button>
        <button className={`nav-item ${view === "Settings" ? "active" : ""}`} aria-current={view === "Settings" ? "page" : undefined} onClick={() => setView("Settings")}><Icon name="settings" />Settings</button>
      </nav>
    </aside>

    <main id="main-content" className="main-content">
      <header className="page-header"><h1>{view}</h1></header>
      {view === "Dashboard" ? <>
        <section className="week-planner" aria-label="Weekly planner">
          <div className="week-toolbar"><div><h2>{formatDate(selected, { month: "long", year: "numeric" })}</h2><p>{formatDate(week, { month: "short", day: "numeric" })} – {formatDate(addDays(week, 6), { month: "short", day: "numeric", year: "numeric" })}</p></div>
            <div className="week-controls"><button className="button today-button" onClick={() => setSelected(today)}>Today</button><div className="arrow-group"><button className="icon-button" aria-label="Previous week" onClick={() => setSelected(addDays(selected, -7))}><Icon name="left" size={17} /></button><button className="icon-button" aria-label="Next week" onClick={() => setSelected(addDays(selected, 7))}><Icon name="right" size={17} /></button></div></div>
          </div>
          <div className="week-scroll"><div className="day-grid">{days.map((date) => {
            const items = tasks.filter((task) => task.date === date);
            const names = [...new Set(items.map((item) => categoryFor(item.category).name))];
            return <button key={date} className={`day-card ${selected === date ? "selected" : ""}`} aria-pressed={selected === date} aria-label={`${formatDate(date, { weekday: "long", month: "long", day: "numeric" })}, ${items.length} ${items.length === 1 ? "task" : "tasks"}${date === today ? ", today" : ""}`} onClick={() => setSelected(date)}>
              <span className="day-name">{formatDate(date, { weekday: "short" })}{date === today && <span className="today-dot" aria-label="Today" />}</span><span className="day-number">{formatDate(date, { day: "numeric" })}</span><span className="day-count">{items.length} {items.length === 1 ? "task" : "tasks"}</span><span className="day-categories" title={names.join(", ")}>{names.length ? `${names[0]}${names.length > 1 ? ` +${names.length - 1}` : ""}` : "No tasks planned"}</span>
            </button>;
          })}</div></div>
        </section>

        <section className="daily-panel" aria-labelledby="daily-heading">
          <div className="daily-header"><div><div className="daily-title"><h2 id="daily-heading">{formatDate(selected, { weekday: "long", month: "long", day: "numeric" })}</h2>{selected === today && <span className="small-tag">Today</span>}</div></div><button className="button primary" onClick={() => setModal({ postpone: false })}><Icon name="plus" size={17} />Add task</button></div>
          {overdue.length > 0 && <details className="overdue-panel"><summary><span className="overdue-title"><Icon name="warning" size={17} />Overdue<span className="overdue-count">{overdue.length}</span></span><span className="overdue-expand">View tasks<Icon name="down" size={16} /></span></summary><ul className="overdue-list">{overdue.map((task) => taskRow(task, true))}</ul></details>}
          <section className="task-section" aria-labelledby="scheduled-heading"><div className="section-heading"><h3 id="scheduled-heading">Scheduled Tasks</h3></div>{scheduled.length ? <ul className="task-list">{scheduled.map((task) => taskRow(task))}</ul> : <p className="empty-section">No scheduled tasks for this day.</p>}</section>
          <section className="task-section anytime-section" aria-labelledby="anytime-heading"><div className="section-heading"><h3 id="anytime-heading">Anytime Tasks</h3></div>{anytime.length ? <ul className="task-list">{anytime.map((task) => taskRow(task))}</ul> : <p className="empty-section">Nothing here yet. Add a task without a time.</p>}
            <button className="add-inline" onClick={() => setModal({ postpone: false })}><Icon name="plus" size={16} />Add another task</button>
          </section>
        </section>
      </> : <section className="placeholder-panel"><span className="small-tag">Not implemented yet</span><h2>{view === "Performance" ? "Performance arrives in Phase 2." : "Settings will be available in a later milestone."}</h2><p>{view === "Performance" ? "Points, rankings, and analytics are outside this preview." : "Account preferences and calendar connections are not connected in this preview."}</p><button className="button secondary" onClick={() => setView("Dashboard")}>Back to Dashboard</button></section>}
      <footer className="preview-note"><span className="local-indicator" />Sample data only. All changes reset when you reload.</footer>
      <p className="sr-only" role="status" aria-live="polite">{notice}</p>
    </main>
    {modal && <TaskModal task={modal.task} tasks={tasks} date={selected} postpone={modal.postpone} onSave={save} onDelete={remove} onClose={() => setModal(null)} />}
  </div>;
}

function TaskRow({ task, parent, overdue, onToggle, onEdit, onPostpone, onCancel, onDelete }: {
  task: Task; parent?: string; overdue: boolean;
  onToggle: () => void; onEdit: () => void; onPostpone: () => void; onCancel: () => void; onDelete: () => void;
}) {
  return <li className={`task-row ${task.status}`}>
    <input className="completion-checkbox" type="checkbox" aria-label={`Complete ${task.title}`} checked={task.status === "completed"} disabled={task.status === "canceled"} onChange={onToggle} />
    <div className="task-time">{overdue ? <span className="due-label">{formatDate(task.date, { month: "short", day: "numeric" })}{task.time && <small>{formatTime(task.time)}</small>}</span> : task.time ? <time dateTime={`${task.date}T${task.time}`}>{formatTime(task.time)}</time> : <span className="anytime-dash" aria-hidden="true">—</span>}</div>
    <div className="task-name"><button className="task-title" onClick={onEdit}>{task.title}</button>{parent && <span className="parent-label">Subtask of {parent}</span>}{task.status === "canceled" && <span className="canceled-label">Canceled</span>}</div>
    <span className={`category-label category-${task.category}`}>{categoryFor(task.category).name}</span>
    <details className="row-menu" onKeyDown={(event) => { if (event.key === "Escape") { event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); } }}>
      <summary aria-label={`Actions for ${task.title}`}><span aria-hidden="true">···</span></summary>
      <div className="row-menu-content" onClick={(event) => { const details = event.currentTarget.closest("details"); if (details) details.open = false; }}>
        <button onClick={onPostpone} disabled={task.status === "canceled"}>Postpone</button><button onClick={onCancel} disabled={task.status === "canceled"}>Cancel task</button><button className="danger" onClick={onDelete}>Delete</button>
      </div>
    </details>
  </li>;
}
