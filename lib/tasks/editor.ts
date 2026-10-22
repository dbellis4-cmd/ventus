import type { CategoryRow } from "./projections";

export type EditorNode = {
  id: string; parentId: string | null; taskVersion: number; occurrenceVersion: number;
  title: string; categoryId: string; location: string; calendarOptIn: boolean; status: "open" | "completed" | "canceled";
  behavior: "fixed" | "flexible" | "deadline"; behaviorOverride: "fixed" | "flexible" | "deadline" | null;
  date: string; timezone: string; time: string; startsAt: string;
  endDate: string; endTime: string; endsAt: string;
};
export type TaskEditor = {
  taskId: string | null; rootId: string | null; rootVersion: number | null;
  timezone: string; categories: CategoryRow[]; nodes: EditorNode[];
  recurrenceKey?: string;
  seriesRule?: NonNullable<TaskDraft["recurrence"]>;
  seriesCalendarOptIn?: boolean;
};
export type SubtaskDraft = { id: string | null; title: string; date: string; startInstant: string; endInstant: string };
export type TaskDraft = {
  title: string; categoryId: string; date: string; time: string; endTime: string;
  timezone: string; startInstant: string; endInstant: string; location: string; calendarOptIn: boolean; subtasks: SubtaskDraft[];
  recurrence?: { frequency: "none" | "daily" | "weekly" | "monthly" | "yearly" | "weekdays"; weekdays: number[]; endDate: string; foldSide: "earlier" | "later" };
};
export type SaveCommand = { kind: "create"; creationKey: string; draft: TaskDraft } | {
  kind: "edit"; taskId: string; rootId: string; rootVersion: number;
  taskVersion: number; occurrenceVersion: number; draft: TaskDraft;
  recurrenceKey?: string; scope?: "occurrence" | "series";
};
export type TaskErrorCode = "invalid" | "conflict" | "unavailable" | "uncertain" | "unauthorized";
export type TaskFailure = { ok: false; code: TaskErrorCode; message: string };
export type EditorResult = { ok: true; editor: TaskEditor } | TaskFailure;
export type SaveResult = { ok: true; taskId: string; date: string; refreshFailed?: boolean } | TaskFailure;
export type LifecycleCommand = {
  taskId: string; rootVersion: number; taskVersion: number; occurrenceVersion: number; recurrenceKey?: string;
} & ({ kind: "completion"; completed: boolean } | { kind: "postpone"; date: string; time: string; endDate: string; endTime: string; startInstant: string; endInstant: string; timezone?: string } | { kind: "cancel"; reason: string } | { kind: "delete"; scope?: "occurrence" | "future_series" });
export type LifecycleResult = { ok: true; date: string; refreshFailed?: boolean } | TaskFailure;

export class TaskInputError extends Error {
  constructor(message: string, readonly code: TaskErrorCode = "invalid") { super(message); }
}

export function initialDraft(editor: TaskEditor, date: string): TaskDraft {
  const task = editor.nodes.find((node) => node.id === editor.taskId);
  const parent = editor.nodes.find((node) => node.id === task?.parentId);
  return {
    title: task?.title ?? "", categoryId: parent?.categoryId ?? task?.categoryId ?? "", date: task?.date ?? date,
    time: task?.time ?? "", endTime: task?.endTime ?? "", timezone: task?.timezone ?? editor.timezone,
    startInstant: task?.startsAt ?? "", endInstant: task?.endsAt ?? "", location: task?.location ?? "",
    calendarOptIn: task?.calendarOptIn ?? editor.categories.find((item) => item.id === (parent?.categoryId ?? task?.categoryId))?.calendar_default ?? false,
    recurrence: editor.seriesRule ?? { frequency: "none", weekdays: [], endDate: "", foldSide: "earlier" },
    subtasks: editor.nodes.filter((node) => !!task && !task.parentId && node.parentId === task.id).map((node) => ({
      id: node.id, title: node.title, date: node.date, startInstant: node.startsAt, endInstant: node.endsAt,
    })),
  };
}
