import { validDate, validTimezone } from "./dates";
import { TaskInputError, type LifecycleCommand, type SaveCommand, type TaskDraft } from "./editor";
import { validTime } from "./schedules";

export const validId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export const validVersion = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

function exact(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !fields.includes(key)) || fields.some((key) => !Object.hasOwn(value, key))) throw new TaskInputError("Missing, unknown or protected task field.");
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, required = false): string {
  if (typeof value !== "string" || value.length > max || (required && !value.trim())) throw new TaskInputError("Check task titles, location and time selections.");
  return value.trim();
}
function date(value: unknown): string {
  if (!validDate(value) || value < "0002-01-01" || value > "9998-12-31") throw new TaskInputError("Enter a valid task date.");
  return value;
}
export function validateSaveCommand(value: unknown): SaveCommand {
  try { if (new TextEncoder().encode(JSON.stringify(value)).length > 65536) throw new Error(); } catch { throw new TaskInputError("The task form exceeds the 64 KiB limit."); }
  const kind = (value as { kind?: unknown } | null)?.kind;
  const editFields = ["kind", "taskId", "rootId", "rootVersion", "taskVersion", "occurrenceVersion", "draft"];
  const command = exact(value, kind === "create" ? ["kind", "creationKey", "draft"] : [
    ...editFields,
    ...((value && typeof value === "object" && "recurrenceKey" in value) ? ["recurrenceKey", "scope"] : []),
  ]);
  if (kind !== "create" && kind !== "edit") throw new TaskInputError("Unsupported task operation.");
  const raw = exact({ ...(command.draft as object), recurrence: (command.draft as { recurrence?: unknown } | null)?.recurrence ?? null },
    ["title", "categoryId", "date", "time", "endTime", "timezone", "startInstant", "endInstant", "location", "calendarOptIn", "subtasks", "recurrence"]);
  if (typeof raw.calendarOptIn !== "boolean") throw new TaskInputError("Choose whether this task appears in Google Calendar.");
  if (!validId(raw.categoryId) || !validTimezone(raw.timezone) || !Array.isArray(raw.subtasks)) throw new TaskInputError("Choose a category, timezone and valid subtasks.");
  const time = text(raw.time, 15); const endTime = text(raw.endTime, 15);
  if ((time && !validTime(time)) || (endTime && (!time || !validTime(endTime)))) throw new TaskInputError("Enter valid start and end times.");
  const seen = new Set<string>();
  const draft: TaskDraft = {
    title: text(raw.title, 240, true), categoryId: raw.categoryId, date: date(raw.date), time, endTime,
    timezone: raw.timezone, startInstant: text(raw.startInstant, 40), endInstant: text(raw.endInstant, 40), location: text(raw.location, 1000), calendarOptIn: raw.calendarOptIn,
    subtasks: raw.subtasks.map((value) => {
      const sub = exact(value, ["id", "title", "date", "startInstant", "endInstant"]);
      if ((sub.id !== null && !validId(sub.id)) || (typeof sub.id === "string" && seen.has(sub.id))) throw new TaskInputError("Invalid or repeated subtask reference.");
      if (typeof sub.id === "string") seen.add(sub.id);
      return { id: sub.id as string | null, title: text(sub.title, 240, true), date: date(sub.date), startInstant: text(sub.startInstant, 40), endInstant: text(sub.endInstant, 40) };
    }),
  };
  if (raw.recurrence !== null) {
    const rule = exact(raw.recurrence, ["frequency", "weekdays", "endDate", "foldSide"]);
    if (!["none", "daily", "weekly", "monthly", "yearly", "weekdays"].includes(String(rule.frequency)) ||
      !["earlier", "later"].includes(String(rule.foldSide)) ||
      !Array.isArray(rule.weekdays) || rule.weekdays.length > 7 ||
      rule.weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6) ||
      new Set(rule.weekdays).size !== rule.weekdays.length ||
      (rule.frequency === "weekdays" ? rule.weekdays.length === 0 : rule.weekdays.length !== 0) ||
      (rule.endDate !== "" && (!validDate(rule.endDate) || rule.endDate < draft.date))) {
      throw new TaskInputError("Enter a valid recurrence schedule.");
    }
    draft.recurrence = rule as TaskDraft["recurrence"];
  }
  if (kind === "create") {
    if (!validId(command.creationKey) || draft.subtasks.some((sub) => sub.id !== null)) throw new TaskInputError("Invalid creation key or existing subtask reference.");
    if (draft.subtasks.length > 99) throw new TaskInputError("A creation command supports at most 100 tasks.");
    return { kind, creationKey: command.creationKey, draft };
  }
  if (!validId(command.taskId) || !validId(command.rootId) || !validVersion(command.rootVersion) || !validVersion(command.taskVersion) ||
    !(validVersion(command.occurrenceVersion) || ("recurrenceKey" in command && command.occurrenceVersion === 0))) throw new TaskInputError("Invalid task reference or expected version.");
  if ("recurrenceKey" in command && (!(command.recurrenceKey === "once" || validDate(command.recurrenceKey)) ||
      !["occurrence", "series"].includes(String(command.scope)))) throw new TaskInputError("Invalid recurrence edit scope.");
  return { kind, taskId: command.taskId, rootId: command.rootId, rootVersion: command.rootVersion,
    taskVersion: command.taskVersion, occurrenceVersion: command.occurrenceVersion, draft,
    ...("recurrenceKey" in command ? { recurrenceKey: command.recurrenceKey as string, scope: command.scope as "occurrence" | "series" } : {}) };
}

export function validateLifecycleCommand(value: unknown): LifecycleCommand {
  const kind = (value as { kind?: unknown } | null)?.kind;
  const hasTimezone = !!value && typeof value === "object" && "timezone" in value;
  const hasScope = !!value && typeof value === "object" && "scope" in value;
  const base = ["kind", "taskId", "rootVersion", "taskVersion", "occurrenceVersion"];
  const fields = kind === "completion" ? [...base, "completed"] : kind === "postpone" ? [...base, "date", "time", "endDate", "endTime", "startInstant", "endInstant", ...(hasTimezone ? ["timezone"] : [])] : kind === "cancel" ? [...base, "reason"] : kind === "delete" ? [...base, "scope"] : base;
  const extras = value && typeof value === "object" && "recurrenceKey" in value ? { recurrenceKey: (value as { recurrenceKey: unknown }).recurrenceKey } : {};
  const raw = exact({ ...(value as object), ...extras, ...(kind === "delete" && !hasScope ? { scope: "occurrence" } : {}) },
    [...fields, ...("recurrenceKey" in extras ? ["recurrenceKey"] : [])]);
  if (!validId(raw.taskId) || !validVersion(raw.rootVersion) || !validVersion(raw.taskVersion) ||
    !(validVersion(raw.occurrenceVersion) || ("recurrenceKey" in raw && raw.occurrenceVersion === 0))) throw new TaskInputError("Invalid task reference or expected version.");
  if ("recurrenceKey" in raw && !(raw.recurrenceKey === "once" || validDate(raw.recurrenceKey))) throw new TaskInputError("Invalid occurrence key.");
  const common = { taskId: raw.taskId, rootVersion: raw.rootVersion, taskVersion: raw.taskVersion, occurrenceVersion: raw.occurrenceVersion,
    ...("recurrenceKey" in raw ? { recurrenceKey: raw.recurrenceKey as string } : {}) };
  if (kind === "completion" && typeof raw.completed === "boolean") return { kind, ...common, completed: raw.completed };
  if (kind === "cancel") return { kind, ...common, reason: text(raw.reason, 500) };
  if (kind === "delete" && (raw.scope === "occurrence" || raw.scope === "future_series")) return { kind, ...common, scope: raw.scope };
  if (kind === "postpone") {
    const time = text(raw.time, 15); const endTime = text(raw.endTime, 15); const endDate = raw.endDate === "" ? "" : date(raw.endDate);
    if ((time && !validTime(time)) || (endTime && (!time || !endDate || !validTime(endTime))) || (!endTime && endDate)) throw new TaskInputError("Enter valid start and end times.");
    if ("timezone" in raw && !validTimezone(raw.timezone)) throw new TaskInputError("Invalid occurrence timezone.");
    return { kind, ...common, date: date(raw.date), time, endDate, endTime, startInstant: text(raw.startInstant, 40), endInstant: text(raw.endInstant, 40),
      ...("timezone" in raw ? { timezone: raw.timezone as string } : {}) };
  }
  throw new TaskInputError("Unsupported task operation.");
}
