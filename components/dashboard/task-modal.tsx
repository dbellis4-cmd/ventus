"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { getTaskEditor, saveTask } from "@/app/task-actions";
import { initialDraft, type SaveCommand, type TaskEditor, type TaskFailure } from "@/lib/tasks/editor";
import { possibleInstants } from "@/lib/tasks/schedules";
import { validateSaveCommand } from "@/lib/tasks/validation";
import { Icon } from "./icon";

export function TaskModal({ editor: initialEditor, date, onSaved, onClose, onDelete }: {
  editor: TaskEditor; date: string; onSaved: (date: string, refreshFailed: boolean) => void; onClose: () => void; onDelete?: (editor: TaskEditor) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const [editor, setEditor] = useState(initialEditor);
  const [draft, setDraft] = useState(() => initialDraft(initialEditor, date));
  const [creationKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<TaskFailure | null>(null);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const lastCommand = useRef<SaveCommand | null>(null);
  const task = editor.nodes.find((node) => node.id === editor.taskId);
  const isSubtask = !!task?.parentId;
  const parent = editor.nodes.find((node) => node.id === task?.parentId);
  const inheritedCategory = editor.categories.find((category) => category.id === parent?.categoryId);
  const closed = !!task && task.status !== "open";
  const locked = pending || closed || error?.code === "uncertain" || error?.code === "conflict";
  const categories = editor.categories.filter((category) => !category.archived_at || category.id === task?.categoryId);
  const enteredSubtasks = draft.subtasks.filter((sub) => sub.id || sub.title.trim());
  const visibleSubtasks = draft.subtasks.map((item, index) => ({ item, index })).filter(({ item }) => editor.nodes.find((node) => node.id === item.id)?.status !== "canceled");

  useEffect(() => {
    const element = dialog.current;
    const active = document.activeElement as HTMLElement | null;
    element?.showModal();
    titleInput.current?.focus();
    return () => {
      element?.close();
      if (active?.isConnected) active.focus();
      else document.querySelector<HTMLButtonElement>(".daily-header .primary")?.focus();
    };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || error?.code === "conflict") return;
    let command: SaveCommand;
    try {
      command = error?.code === "uncertain" && lastCommand.current ? lastCommand.current : validateSaveCommand(task ? {
        kind: "edit", taskId: task.id, rootId: editor.rootId, rootVersion: editor.rootVersion,
        taskVersion: task.taskVersion, occurrenceVersion: task.occurrenceVersion, draft: { ...draft, subtasks: enteredSubtasks },
      } : { kind: "create", creationKey, draft: { ...draft, subtasks: enteredSubtasks } });
    } catch (reason) {
      setError({ ok: false, code: "invalid", message: reason instanceof Error ? reason.message : "Check the task fields." }); return;
    }
    lastCommand.current = command;
    inFlight.current = true;
    setPending(true);
    try {
      const result = await saveTask(command);
      if (result.ok) onSaved(result.date, !!result.refreshFailed);
      else setError(result);
    } catch {
      // Keep this exact command and creation key for an uncertain network retry.
      setError({ ok: false, code: "uncertain", message: "The save outcome is unknown. Retry the same save before making changes. Your draft is kept." });
    } finally { inFlight.current = false; setPending(false); }
  }

  async function reloadSavedTask() {
    if (!task || inFlight.current) return;
    inFlight.current = true; setPending(true);
    try {
      const result = await getTaskEditor(task.id);
      if (result.ok) {
        setEditor(result.editor); setDraft(initialDraft(result.editor, date)); setError(null); lastCommand.current = null;
      } else setError({ ...result, code: "conflict" });
    } catch { setError({ ok: false, code: "conflict", message: "Unable to reload. Your draft is still kept. Please try again." }); }
    finally { inFlight.current = false; setPending(false); }
  }

  function close() { if (!inFlight.current) onClose(); }
  function updateSubtask(index: number, patch: Partial<typeof draft.subtasks[number]>) {
    setDraft({ ...draft, subtasks: draft.subtasks.map((sub, i) => i === index ? { ...sub, ...patch } : sub) });
  }
  function addSubtask() {
    setDraft({ ...draft, subtasks: [...draft.subtasks, { id: null, title: "", date: draft.date, startInstant: "", endInstant: "" }] });
  }

  return <dialog ref={dialog} className="task-dialog" aria-labelledby="task-dialog-title" aria-busy={pending}
    onKeyDown={(event) => {
      if (event.key !== "Tab") return;
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), summary")).filter((element) => element.getClientRects().length > 0);
      const first = controls[0]; const last = controls[controls.length - 1];
      if (event.shiftKey && event.target === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && event.target === last) { event.preventDefault(); first?.focus(); }
    }}
    onCancel={(event) => { event.preventDefault(); close(); }}
    onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
    <form onSubmit={submit} className="task-form">
      <header className="modal-header">
        <div><h2 id="task-dialog-title">{isSubtask ? "Edit subtask" : task ? "Edit task" : "New task"}</h2>
          {isSubtask && <p className="subtask-parent">Part of: {parent?.title}</p>}
        </div>
        <button type="button" className="icon-button" aria-label="Close task dialog" disabled={pending} onClick={close}><Icon name="close" /></button>
      </header>
      <div className="modal-body">
        {closed && <p className="form-notice">{task?.status === "completed" ? "Reopen this task from its checkbox before editing." : "Canceled tasks cannot be edited."}</p>}
        <label className="field">Title <span aria-hidden="true">*</span><input ref={titleInput} required maxLength={240} disabled={locked} placeholder="What needs to get done?" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
        <div className="field-pair">
          {isSubtask ? <label className="field">Category<input readOnly value={inheritedCategory?.name ?? ""} /></label> : <label className="field">Category <span aria-hidden="true">*</span><select required disabled={locked} value={draft.categoryId} onChange={(event) => setDraft({ ...draft, categoryId: event.target.value })}><option value="" disabled>Select a category</option>{categories.map((item) => <option key={item.id} value={item.id} disabled={!!item.archived_at}>{item.name}{item.archived_at ? " (archived)" : ""}</option>)}</select></label>}
          <label className="field">Date <span aria-hidden="true">*</span><input type="date" required disabled={locked} value={draft.date} onInput={(event) => setDraft({ ...draft, date: event.currentTarget.value, startInstant: "", endInstant: "" })} /></label>
        </div>
        <div className="optional-sections">
          <details open={!!(task?.time || task?.endTime)}><summary>Time <span>{draft.time ? "Time set" : "Optional"}<Icon name="down" size={15} /></span></summary><div className="optional-content">
            <div className="field-pair time-fields">
              <label className="field">Start time<input type="time" step="any" disabled={locked} value={draft.time} onInput={(event) => { const time = event.currentTarget.value; setDraft({ ...draft, time, endTime: time ? draft.endTime : "", startInstant: "", endInstant: "" }); }} /></label>
              <label className="field">End time (optional)<input type="time" step="any" disabled={locked} value={draft.endTime} onInput={(event) => setDraft({ ...draft, endTime: event.currentTarget.value, endInstant: "" })} /></label>
            </div>
            <InstantChoice date={draft.date} time={draft.time} timezone={draft.timezone} value={draft.startInstant} label="Start time offset" disabled={locked} onChange={(value) => setDraft({ ...draft, startInstant: value })} />
            <InstantChoice date={task?.endDate && task.endDate !== task.date ? task.endDate : draft.date} time={draft.endTime} timezone={draft.timezone} value={draft.endInstant} label="End time offset" disabled={locked} onChange={(value) => setDraft({ ...draft, endInstant: value })} />
            <p className="field-help">Leave times empty for an anytime task. Time zone: {draft.timezone}.</p>
            {task?.endDate && task.endDate !== task.date && <p className="field-help">Stored end date: {task.endDate}. Overnight schedule changes are not available.</p>}
          </div></details>
          {!isSubtask && <details><summary>Recurrence <span>Unavailable<Icon name="down" size={15} /></span></summary><div className="optional-content">
            <label className="field">Repeat<select disabled value="" onChange={() => {}}><option value="">Does not repeat</option></select></label>
            <p className="field-help">Recurring tasks will be available in a later milestone.</p>
          </div></details>}
          <details open={!!task?.location}><summary>Location <span>{draft.location ? "Location set" : "Optional"}<Icon name="down" size={15} /></span></summary><div className="optional-content"><label className="field">Location<input maxLength={1000} disabled={locked} placeholder="Add a place or meeting link" value={draft.location} onChange={(event) => setDraft({ ...draft, location: event.target.value })} /></label></div></details>
          {!isSubtask && <details open={visibleSubtasks.length > 0} onToggle={(event) => { if (event.currentTarget.open && !visibleSubtasks.length) addSubtask(); }}><summary>Subtasks <span>{visibleSubtasks.filter(({ item }) => item.id || item.title.trim()).length || "Optional"}<Icon name="down" size={15} /></span></summary><div className="optional-content">
            <p className="field-help">Each active subtask appears on its own date. Canceled subtasks stay canceled when you save the parent. Use its task row to complete or delete a saved subtask.</p>
            {visibleSubtasks.map(({ item, index }, visibleIndex) => {
              const saved = editor.nodes.find((node) => node.id === item.id);
              const closed = !!saved && saved.status !== "open";
              return <div key={item.id ?? `new-${index}`}>
                <div className="subtask-fields">
                  <label className="field"><span className="sr-only">Subtask {visibleIndex + 1} title</span><input required={!!item.id || !!item.title.trim()} maxLength={240} disabled={locked || closed} placeholder="Subtask title" value={item.title} onChange={(event) => updateSubtask(index, { title: event.target.value })} /></label>
                  <label className="field"><span className="sr-only">Subtask {visibleIndex + 1} date</span><input type="date" required={!!item.id || !!item.title.trim()} disabled={locked || closed} value={item.date} onInput={(event) => updateSubtask(index, { date: event.currentTarget.value, startInstant: "", endInstant: "" })} /></label>
                  <button type="button" className="icon-button" disabled={locked || !!item.id} title={item.id ? "Use the saved subtask's task row to delete it." : undefined} aria-label={`Remove subtask ${visibleIndex + 1}`} onClick={() => setDraft({ ...draft, subtasks: draft.subtasks.filter((_, i) => i !== index) })}><Icon name="close" size={16} /></button>
                </div>
                {saved?.time && <InstantChoice date={item.date} time={saved.time} timezone={saved.timezone} value={item.startInstant} label={`Subtask ${visibleIndex + 1} start time offset`} disabled={locked || closed} onChange={(value) => updateSubtask(index, { startInstant: value })} />}
                {saved?.endTime && <InstantChoice date={item.date} time={saved.endTime} timezone={saved.timezone} value={item.endInstant} label={`Subtask ${visibleIndex + 1} end time offset`} disabled={locked || closed} onChange={(value) => updateSubtask(index, { endInstant: value })} />}
              </div>;
            })}
            <button type="button" className="text-button" disabled={locked || draft.subtasks.filter((sub) => !sub.id).length >= 99} onClick={addSubtask}><Icon name="plus" size={15} />Add subtask</button>
          </div></details>}
        </div>
        {!isSubtask && <label className="calendar-option"><input type="checkbox" disabled checked={task?.calendarOptIn ?? editor.categories.find((category) => category.id === draft.categoryId)?.calendar_default ?? false} /><span>Add to Google Calendar</span><span className="small-tag">Unavailable</span></label>}
        {error && <p role="alert" className="form-error">{error.message}</p>}
        {error?.code === "conflict" && <button type="button" className="text-button" disabled={pending} onClick={() => void reloadSavedTask()}>Reload saved task (discard draft)</button>}
      </div>
      <footer className="modal-footer">
        {task && <button type="button" className="delete-button" disabled={pending || !onDelete} onClick={() => onDelete?.(editor)}>Delete{isSubtask ? " subtask" : draft.subtasks.length ? " task & subtasks" : " task"}</button>}
        <div className="modal-actions"><button type="button" className="button secondary" disabled={pending} onClick={close}>Cancel</button><button className="button primary" disabled={pending || closed || error?.code === "conflict"} type="submit">{pending ? "Saving…" : error?.code === "uncertain" ? "Retry same save" : task ? "Save changes" : "Create task"}</button></div>
      </footer>
    </form>
  </dialog>;
}

export function InstantChoice({ date, time, timezone, value, label, disabled, onChange }: {
  date: string; time: string; timezone: string; value: string; label: string; disabled: boolean; onChange: (value: string) => void;
}) {
  const choices = possibleInstants(date, time, timezone);
  if (choices.length < 2) return null;
  const selected = choices.find((choice) => Date.parse(choice) === Date.parse(value)) ?? "";
  return <label className="field">{label}<select required disabled={disabled} value={selected} onChange={(event) => onChange(event.target.value)}>
    <option value="" disabled>Choose an explicit instant ({timezone})</option>
    {choices.map((choice) => <option key={choice} value={choice}>{time} — {choice} (UTC)</option>)}
  </select></label>;
}
