"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { addDays, categories, categoryFor, validDate, type Task } from "@/lib/tasks/demo";
import { Icon } from "./icon";

export type TaskDraft = Task & { subtasks: { id: string; title: string; date: string }[] };

export function TaskModal({ task, tasks, date, postpone, onSave, onDelete, onClose }: {
  task?: Task;
  tasks: Task[];
  date: string;
  postpone: boolean;
  onSave: (draft: TaskDraft) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const dateInput = useRef<HTMLInputElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<TaskDraft>(() => ({
    id: task?.id ?? crypto.randomUUID(), title: "", category: "", date,
    time: "", endTime: "", location: "", recurrence: "", recurrenceEnd: "", calendar: false, status: "open",
    ...task,
    ...(postpone && task ? { date: addDays(task.date, 1) } : {}),
    subtasks: tasks.filter((item) => !!task && item.parentId === task.id).map(({ id, title, date }) => ({ id, title, date })),
  }));
  const [error, setError] = useState("");

  useEffect(() => {
    const element = dialog.current;
    const active = document.activeElement as HTMLElement | null;
    const trigger = active?.closest(".row-menu")?.querySelector("summary") ?? active;
    element?.showModal();
    (postpone ? dateInput : titleInput).current?.focus();
    return () => {
      element?.close();
      if (trigger?.isConnected) trigger.focus();
      else document.querySelector<HTMLButtonElement>(".daily-header .primary")?.focus();
    };
  }, [postpone]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft.title.trim() || !categories.some((item) => item.id === draft.category) || !validDate(draft.date)) {
      setError("Enter a title, category, and valid date."); return;
    }
    if (draft.time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.time)) {
      setError("Enter a valid start time."); return;
    }
    if (draft.endTime && (!/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.endTime) || !draft.time || draft.endTime <= draft.time)) {
      setError("End time must be after the start time on the same day."); return;
    }
    if (draft.recurrenceEnd && (!validDate(draft.recurrenceEnd) || draft.recurrenceEnd < draft.date)) {
      setError("The recurrence end date must be on or after the task date."); return;
    }
    if (draft.subtasks.some((item) => !item.title.trim() || !validDate(item.date))) {
      setError("Give each subtask a title and valid date, or remove the empty subtask."); return;
    }
    onSave({ ...draft, title: draft.title.trim(), location: draft.location.trim(), subtasks: draft.subtasks.map((item) => ({ ...item, title: item.title.trim() })) });
  }

  return <dialog ref={dialog} className="task-dialog" aria-labelledby="task-dialog-title"
    onKeyDown={(event) => {
      if (event.key !== "Tab") return;
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), summary")).filter((element) => element.getClientRects().length > 0);
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && event.target === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && event.target === last) { event.preventDefault(); first?.focus(); }
    }}
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <form onSubmit={submit} className="task-form">
      <header className="modal-header">
        <h2 id="task-dialog-title">{postpone ? "Postpone task" : task ? "Edit task" : "New task"}</h2>
        <button type="button" className="icon-button" aria-label="Close task dialog" onClick={onClose}><Icon name="close" /></button>
      </header>
      <div className="modal-body">
        {task?.status === "canceled" && <p className="form-notice">This task is canceled. Saving edits keeps it canceled.</p>}
        <label className="field">Title <span aria-hidden="true">*</span><input ref={titleInput} required maxLength={160} placeholder="What needs to get done?" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
        <div className="field-pair">
          <label className="field">Category <span aria-hidden="true">*</span><select required value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value, calendar: categoryFor(event.target.value).calendar })}><option value="" disabled>Select a category</option>{categories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label className="field">Date <span aria-hidden="true">*</span><input ref={dateInput} type="date" required value={draft.date} onInput={(event) => setDraft({ ...draft, date: event.currentTarget.value })} /></label>
        </div>
        <div className="optional-sections">
          <details open={!!(task?.time || task?.endTime)}><summary>Time <span>{draft.time ? "Time set" : "Optional"}<Icon name="down" size={15} /></span></summary><div className="optional-content">
            <div className="field-pair time-fields">
              <label className="field">Start time<input type="time" value={draft.time} onInput={(event) => { const time = event.currentTarget.value; setDraft({ ...draft, time, endTime: time ? draft.endTime : "" }); }} /></label>
              <label className="field">End time (optional)<input type="time" value={draft.endTime ?? ""} onInput={(event) => setDraft({ ...draft, endTime: event.currentTarget.value })} /></label>
            </div>
            <p className="field-help">Leave times empty for an anytime task.</p>
          </div></details>
          <details open={!!task?.recurrence}><summary>Recurrence <span>{draft.recurrence ? "Schedule set" : "Optional"}<Icon name="down" size={15} /></span></summary><div className="optional-content">
            <label className="field">Repeat<select value={draft.recurrence} onChange={(event) => setDraft({ ...draft, recurrence: event.target.value, recurrenceEnd: event.target.value ? draft.recurrenceEnd : "" })}><option value="">Does not repeat</option><option value="daily">Daily</option><option value="weekly">Weekly on this weekday</option><option value="monthly">Monthly on this date</option><option value="annually">Annually</option><option value="weekdays">Monday through Friday</option></select></label>
            {draft.recurrence && <label className="field">End date (optional)<input type="date" min={draft.date} value={draft.recurrenceEnd} onInput={(event) => setDraft({ ...draft, recurrenceEnd: event.currentTarget.value })} /></label>}
            <p className="field-help">Preview only. Repeat preferences are saved locally; additional occurrences are not generated.</p>
          </div></details>
          <details open={!!task?.location}><summary>Location <span>{draft.location ? "Location set" : "Optional"}<Icon name="down" size={15} /></span></summary><div className="optional-content"><label className="field">Location<input maxLength={200} placeholder="Add a place or meeting link" value={draft.location} onChange={(event) => setDraft({ ...draft, location: event.target.value })} /></label></div></details>
          <details open={draft.subtasks.length > 0}><summary>Subtasks <span>{draft.subtasks.length || "Optional"}<Icon name="down" size={15} /></span></summary><div className="optional-content">
            <p className="field-help">Each subtask appears on its own date. Complete it independently from its parent.</p>
            {draft.subtasks.map((item, index) => <div key={item.id} className="subtask-fields">
              <label className="field"><span className="sr-only">Subtask {index + 1} title</span><input required maxLength={160} placeholder="Subtask title" value={item.title} onChange={(event) => setDraft({ ...draft, subtasks: draft.subtasks.map((sub) => sub.id === item.id ? { ...sub, title: event.target.value } : sub) })} /></label>
              <label className="field"><span className="sr-only">Subtask {index + 1} date</span><input type="date" required value={item.date} onInput={(event) => setDraft({ ...draft, subtasks: draft.subtasks.map((sub) => sub.id === item.id ? { ...sub, date: event.currentTarget.value } : sub) })} /></label>
              <button type="button" className="icon-button" aria-label={`Remove subtask ${index + 1}`} onClick={() => setDraft({ ...draft, subtasks: draft.subtasks.filter((sub) => sub.id !== item.id) })}><Icon name="close" size={16} /></button>
            </div>)}
            <button type="button" className="text-button" onClick={() => setDraft({ ...draft, subtasks: [...draft.subtasks, { id: crypto.randomUUID(), title: "", date: draft.date }] })}><Icon name="plus" size={15} />Add subtask</button>
          </div></details>
        </div>
        <label className="calendar-option"><input type="checkbox" checked={draft.calendar} onChange={(event) => setDraft({ ...draft, calendar: event.target.checked })} /><span>Add to Google Calendar</span><span className="small-tag">Preview only</span></label>
        {error && <p role="alert" className="form-error">{error}</p>}
      </div>
      <footer className="modal-footer">
        {task && <button type="button" className="delete-button" onClick={() => onDelete(task.id)}>Delete{draft.subtasks.length ? " task & subtasks" : " task"}</button>}
        <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button className="button primary" type="submit">{task ? "Save changes" : "Create task"}</button></div>
      </footer>
    </form>
  </dialog>;
}
