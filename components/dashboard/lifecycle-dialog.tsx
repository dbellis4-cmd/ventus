"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { changeTaskLifecycle } from "@/app/task-actions";
import { addDays, validDate } from "@/lib/tasks/dates";
import type { LifecycleCommand, TaskEditor, TaskFailure } from "@/lib/tasks/editor";
import { InstantChoice } from "./task-modal";

export type LifecycleMode = "postpone" | "cancel" | "delete";

export function LifecycleDialog({ editor, mode, onSaved, onClose }: {
  editor: TaskEditor; mode: LifecycleMode; onSaved: (date: string, refreshFailed: boolean) => void; onClose: () => void;
}) {
  const task = editor.nodes.find((node) => node.id === editor.taskId)!;
  const dialog = useRef<HTMLDialogElement>(null);
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<TaskFailure | null>(null);
  const [date, setDate] = useState(task.date);
  const [time, setTime] = useState(task.time);
  const [endDate, setEndDate] = useState(task.endDate);
  const [endTime, setEndTime] = useState(task.endTime);
  const [startInstant, setStartInstant] = useState(task.startsAt);
  const [endInstant, setEndInstant] = useState(task.endsAt);
  const [reason, setReason] = useState("");
  const locked = pending || error?.code === "conflict" || error?.code === "uncertain";
  const descendants = editor.nodes.filter((node) => {
    let parent = node.parentId;
    while (parent) {
      if (parent === task.id) return true;
      parent = editor.nodes.find((candidate) => candidate.id === parent)?.parentId ?? null;
    }
    return false;
  });
  const canceledDescendants = descendants.filter((node) => node.status === "canceled").length;

  useEffect(() => {
    const active = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    element?.showModal();
    element?.querySelector<HTMLElement>("input, button:not([aria-label])")?.focus();
    return () => { element?.close(); if (active?.isConnected) active.focus(); };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || locked) return;
    const base = { taskId: task.id, rootVersion: editor.rootVersion!, taskVersion: task.taskVersion, occurrenceVersion: task.occurrenceVersion };
    const command: LifecycleCommand = mode === "postpone"
      ? { ...base, kind: "postpone", date, time, endDate: endTime ? endDate : "", endTime, startInstant, endInstant }
      : mode === "cancel" ? { ...base, kind: "cancel", reason } : { ...base, kind: "delete" };
    inFlight.current = true; setPending(true);
    try {
      const result = await changeTaskLifecycle(command);
      if (result.ok) onSaved(result.date, !!result.refreshFailed);
      else setError(result);
    } catch { setError({ ok: false, code: "uncertain", message: "The outcome is unknown. Refresh the Dashboard before trying again." }); }
    finally { inFlight.current = false; setPending(false); }
  }

  return <dialog ref={dialog} className="task-dialog" aria-labelledby="lifecycle-title" aria-busy={pending}
    onCancel={(event) => { event.preventDefault(); if (!inFlight.current) onClose(); }}
    onClick={(event) => { if (event.target === event.currentTarget && !inFlight.current) onClose(); }}>
    <form className="task-form" onSubmit={submit}>
      <header className="modal-header"><h2 id="lifecycle-title">{mode === "postpone" ? "Postpone task" : mode === "cancel" ? "Cancel task" : "Delete task"}</h2><button type="button" className="icon-button" aria-label="Close" disabled={pending} onClick={onClose}>×</button></header>
      <div className="modal-body">
        <p className="field-help">{task.title}</p>
        {mode === "postpone" && <>
          <label className="field">New date<input type="date" required disabled={locked} value={date} onChange={(event) => {
            const next = event.target.value;
            const offset = validDate(next) && validDate(date) ? Math.round((Date.parse(`${next}T12:00:00Z`) - Date.parse(`${date}T12:00:00Z`)) / 86_400_000) : 0;
            setEndDate(endDate && offset ? addDays(endDate, offset) : endDate);
            setDate(next); setStartInstant(""); setEndInstant("");
          }} /></label>
          <div className="field-pair">
            <label className="field">Start time (optional)<input type="time" step="any" disabled={locked} value={time} onChange={(event) => { setTime(event.target.value); setStartInstant(""); if (!event.target.value) { setEndTime(""); setEndDate(""); setEndInstant(""); } }} /></label>
            <label className="field">End time (optional)<input type="time" step="any" disabled={locked} value={endTime} onChange={(event) => { setEndTime(event.target.value); setEndInstant(""); setEndDate(event.target.value ? endDate || date : ""); }} /></label>
          </div>
          {endTime && <label className="field">End date<input type="date" required disabled={locked} value={endDate} onChange={(event) => { setEndDate(event.target.value); setEndInstant(""); }} /></label>}
          <InstantChoice date={date} time={time} timezone={task.timezone} value={startInstant} label="Start time offset" disabled={locked} onChange={setStartInstant} />
          <InstantChoice date={endDate || date} time={endTime} timezone={task.timezone} value={endInstant} label="End time offset" disabled={locked} onChange={setEndInstant} />
          <p className="field-help">Times use {task.timezone}. This changes the current schedule and preserves the original date in history.</p>
        </>}
        {mode === "cancel" && <><p className="field-help">Canceling keeps this task in history and does not cancel its subtasks.</p><label className="field">Reason (optional)<input maxLength={500} disabled={locked} value={reason} onChange={(event) => setReason(event.target.value)} /></label></>}
        {mode === "delete" && <p className="field-help">This removes the task from active views{descendants.length ? ` and also deletes ${descendants.length} ${descendants.length === 1 ? "subtask" : "subtasks"}${canceledDescendants ? ` (${descendants.length - canceledDescendants} active, ${canceledDescendants} already canceled)` : ""}` : ""}. Its history is preserved. This cannot be undone here.</p>}
        {error && <p role="alert" className="form-error">{error.message}</p>}
      </div>
      <footer className="modal-footer"><div className="modal-actions"><button type="button" className="button secondary" disabled={pending} onClick={onClose}>Back</button><button type="submit" className={`button ${mode === "postpone" ? "primary" : "danger"}`} disabled={locked}>{pending ? "Saving…" : mode === "postpone" ? "Postpone" : mode === "cancel" ? "Confirm cancellation" : "Delete task"}</button></div></footer>
    </form>
  </dialog>;
}
