import { addDays, dateInZone, startOfWeek, validDate } from "./dates";

export type CategoryRow = { id: string; name: string; seed_key: string | null; behavior: "fixed" | "flexible" | "deadline"; calendar_default: boolean; archived_at: string | null };
export type TaskRow = { id: string; parent_task_id: string | null; title: string; deleted_at: string | null; version?: number; recurrence_enabled?: boolean };
export type OccurrenceRow = {
  id: string; task_id: string; recurrence_key?: string; version?: number; scheduled_date: string; timezone: string;
  start_time: string | null; starts_at: string | null;
  end_date?: string | null; end_time?: string | null; ends_at?: string | null;
  original_date: string; original_start_time: string | null; original_timezone: string;
  status: "open" | "completed" | "canceled"; completed_at: string | null;
  deleted_at: string | null;
  definition_snapshot: { title: string; category_id: string; category_name: string; behavior: "fixed" | "flexible" | "deadline" };
};

export type ReadTask = {
  id: string; occurrenceId: string; recurrenceKey: string; recurring: boolean; seriesVersion: number; occurrenceVersion: number; title: string; categoryName: string; categoryStyle: string;
  date: string; scheduledDate: string; time: string; endDate: string; endTime: string; startsAt: string; endsAt: string; timezone: string;
  originalDate: string; originalTime: string; originalTimezone: string;
  status: OccurrenceRow["status"]; behavior: OccurrenceRow["definition_snapshot"]["behavior"];
  parentId: string | null; parentTitle: string | null;
  overdue: boolean;
};

export type BacklogCursor = { before: string; offset: number };
export type ReadyWorkspace = { kind: "ready"; timezone: string; today: string; selected: string; tasks: ReadTask[];
  backlog: ReadTask[]; backlogCursor: BacklogCursor | null };
export type Workspace = ReadyWorkspace | { kind: "setup" } | { kind: "error" };

export function projectWorkspace(timezone: string, selectedDate: unknown, categories: CategoryRow[], definitions: TaskRow[], occurrences: OccurrenceRow[], now = new Date()): ReadyWorkspace {
  const today = dateInZone(now, timezone);
  // Leave room for week navigation/calendar arithmetic at supported date boundaries.
  const selected = validDate(selectedDate) && selectedDate >= "0002-01-01" && selectedDate <= "9998-12-31" ? selectedDate : today;
  const week = startOfWeek(selected);
  const weekEnd = addDays(week, 6);
  const tasks = new Map(definitions.filter((task) => !task.deleted_at).map((task) => [task.id, task]));
  const active = occurrences.filter((occurrence) => !occurrence.deleted_at && tasks.has(occurrence.task_id));
  const snapshots = new Map(active.map((occurrence) => [`${occurrence.task_id}:${occurrence.recurrence_key ?? "once"}`, occurrence.definition_snapshot]));
  const styles = new Map(categories.map((category) => [category.id, category.seed_key]));
  const projected: ReadTask[] = [];
  for (const occurrence of active) {
    if (occurrence.status === "canceled") continue;
    const task = tasks.get(occurrence.task_id)!;
    const snapshot = occurrence.definition_snapshot;
    const completedToday = occurrence.status === "completed" && !!occurrence.completed_at && dateInZone(new Date(occurrence.completed_at), timezone) === today;
    const slotToday = dateInZone(now, occurrence.timezone);
    // Evaluate deadlines in their stored zone. No fake midnight instant for anytime.
    const isPast = occurrence.starts_at ? Date.parse(occurrence.starts_at) <= now.getTime() : occurrence.scheduled_date < slotToday;
    const wasPastAtCompletion = occurrence.completed_at && (occurrence.starts_at
      ? Date.parse(occurrence.starts_at) < Date.parse(occurrence.completed_at)
      : occurrence.scheduled_date < dateInZone(new Date(occurrence.completed_at), occurrence.timezone));
    const overdue = snapshot.behavior === "deadline" && ((occurrence.status === "open" && isPast) || (completedToday && !!wasPastAtCompletion));
    // Rollover is a display projection, never a write or new occurrence. Completed
    // rolled tasks stay on their completion day after refresh.
    let date = occurrence.scheduled_date;
    if (snapshot.behavior === "flexible") {
      if (occurrence.status === "open" && date < today) date = today;
      else if (occurrence.status === "completed" && occurrence.completed_at) {
        const completionDay = dateInZone(new Date(occurrence.completed_at), timezone);
        if (completionDay > date) date = completionDay;
      }
    }
    if ((date < week || date > weekEnd) && !(today >= week && today <= weekEnd && overdue)) continue;
    projected.push({
      id: task.id, occurrenceId: occurrence.id, recurrenceKey: occurrence.recurrence_key ?? "once",
      recurring: !!task.recurrence_enabled,
      seriesVersion: (task.parent_task_id ? tasks.get(task.parent_task_id)?.version : task.version) ?? 0,
      occurrenceVersion: occurrence.version ?? 0, title: snapshot.title,
      categoryName: snapshot.category_name, categoryStyle: styles.get(snapshot.category_id) ?? "custom",
      date, scheduledDate: occurrence.scheduled_date, time: occurrence.start_time ?? "",
      endDate: occurrence.end_date ?? "", endTime: occurrence.end_time ?? "",
      startsAt: occurrence.starts_at ?? "", endsAt: occurrence.ends_at ?? "", timezone: occurrence.timezone,
      originalDate: occurrence.original_date, originalTime: occurrence.original_start_time ?? "", originalTimezone: occurrence.original_timezone,
      status: occurrence.status, behavior: snapshot.behavior, parentId: task.parent_task_id,
      parentTitle: task.parent_task_id ? snapshots.get(`${task.parent_task_id}:${occurrence.recurrence_key ?? "once"}`)?.title ?? tasks.get(task.parent_task_id)?.title ?? null : null,
      overdue,
    });
  }
  projected.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.id.localeCompare(b.id));
  return { kind: "ready", timezone, today, selected, tasks: projected, backlog: [], backlogCursor: null };
}
