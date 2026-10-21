import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { projectWorkspace, type BacklogCursor, type CategoryRow, type OccurrenceRow, type ReadTask, type TaskRow, type Workspace } from "@/lib/tasks/projections";
import { addDays, dateInZone, startOfWeek, validDate } from "@/lib/tasks/dates";

// Explicit projections exclude ownership, retry fingerprints, history and tokens
// from browser props. RLS remains authoritative; filters add defense in depth.
const categoryFields = "id,name,seed_key,behavior,calendar_default,archived_at";
const taskFields = "id,parent_task_id,title,deleted_at,version,recurrence_enabled";
const occurrenceFields = "id,task_id,recurrence_key,version,scheduled_date,timezone,start_time,starts_at,end_date,end_time,ends_at,original_date,original_start_time,original_timezone,status,completed_at,deleted_at,definition_snapshot";

type Candidate = {
  task_id: string; recurrence_key: string; scheduled_date: string; timezone: string;
  start_time: string | null; starts_at: string | null;
  end_date: string | null; end_time: string | null; ends_at: string | null;
  definition_snapshot: OccurrenceRow["definition_snapshot"];
};

export async function readRecurrenceCandidates(client: SupabaseClient, userId: string, from: string, to: string): Promise<OccurrenceRow[]> {
  const candidates: Candidate[] = [];
  let afterTaskId: string | null = null;
  let afterKey: string | null = null;
  for (;;) {
    const { data, error } = await client.rpc("list_recurrence_candidates_page", {
      p_from: from, p_to: to, p_after_task_id: afterTaskId, p_after_key: afterKey,
    });
    if (error || !Array.isArray(data)) throw error ?? new Error("Missing recurrence result");
    const page = data as Candidate[];
    candidates.push(...page);
    if (page.length < 100) break;
    const last = page[page.length - 1];
    if (last.task_id === afterTaskId && last.recurrence_key === afterKey) throw new Error("Recurrence page did not advance");
    afterTaskId = last.task_id;
    afterKey = last.recurrence_key;
  }
  const keys = [...new Set(candidates.map((item) => item.recurrence_key))];
  const stored: OccurrenceRow[] = [];
  for (let start = 0; start < keys.length; start += 100) {
    stored.push(...await readOwnedRows<OccurrenceRow>(client, "task_occurrences",
      occurrenceFields, userId, false, { key: "recurrence_key", value: keys.slice(start, start + 100) }));
  }
  const byKey = new Map(stored.map((row) => [`${row.task_id}:${row.recurrence_key}`, row]));
  return candidates.filter((row) => !byKey.has(`${row.task_id}:${row.recurrence_key}`)).map((row) => ({
    id: `${row.task_id}:${row.recurrence_key}`, task_id: row.task_id, version: 0,
    recurrence_key: row.recurrence_key, scheduled_date: row.scheduled_date, timezone: row.timezone,
    start_time: row.start_time, starts_at: row.starts_at,
    end_date: row.end_date, end_time: row.end_time, ends_at: row.ends_at,
    original_date: row.scheduled_date,
    original_start_time: row.start_time, original_timezone: row.timezone,
    status: "open", completed_at: null, deleted_at: null, definition_snapshot: row.definition_snapshot,
  }));
}

export async function readSettings(client: SupabaseClient, userId: string) {
  const { data, error } = await client.from("user_settings").select("timezone,defaults_initialized_at").eq("user_id", userId).maybeSingle();
  if (error) throw error;
  return data as { timezone: string; defaults_initialized_at: string | null } | null;
}

// Keyset pagination avoids the Data API's default row limit silently hiding older
// deadlines or off-week parents. Stage 1 reads the active workspace; return only
// the requested week's projection. Windowed querying can replace this if needed.
export async function readOwnedRows<T extends { id: string }>(client: SupabaseClient, table: string, fields: string, userId: string, activeOnly: boolean, filter?: { key: string; value: string | boolean | string[] }, dateRange?: { from: string; to: string }, completedSince?: string): Promise<T[]> {
  const rows: T[] = [];
  let after: string | undefined;
  for (;;) {
    let query = client.from(table).select(fields).eq("owner_id", userId).order("id").limit(500);
    if (activeOnly) query = query.is("deleted_at", null);
    if (filter) query = Array.isArray(filter.value)
      ? query.in(filter.key, filter.value) : query.eq(filter.key, filter.value);
    if (dateRange) query = query.gte("scheduled_date", dateRange.from).lte("scheduled_date", dateRange.to);
    if (completedSince) query = query.gte("completed_at", completedSince);
    if (after) query = query.gt("id", after);
    const { data, error } = await query;
    if (error || !data) throw error ?? new Error("Missing workspace result");
    const page = data as unknown as T[];
    rows.push(...page);
    if (!page.length) return rows;
    // Continue even after a short page: provider max_rows may be below 500.
    after = page[page.length - 1].id;
  }
}

type StopRow = { id: string; task_id: string; effective_from: string; stopped: boolean };
type BacklogRevision = { id: string; effective_from: string;
  definition_snapshot: { behavior: string };
  child_templates: { day_offset: number; snapshot: { behavior: string } }[] };

async function readWorkspaceDefinitions(client: SupabaseClient, userId: string) {
  const [categories, tasks, stops] = await Promise.all([
    readOwnedRows<CategoryRow>(client, "categories", categoryFields, userId, false),
    readOwnedRows<TaskRow>(client, "tasks", taskFields, userId, true),
    readOwnedRows<StopRow>(client, "task_recurrence_revisions", "id,task_id,effective_from,stopped",
      userId, false, { key: "stopped", value: true }),
  ]);
  const stopDates = new Map(stops.map((stop) => [stop.task_id, stop.effective_from]));
  const parentIds = new Map(tasks.map((task) => [task.id, task.parent_task_id]));
  return { categories, tasks, visible(row: OccurrenceRow) {
    const stop = stopDates.get(parentIds.get(row.task_id) ?? row.task_id);
    return row.status !== "open" || !stop || row.recurrence_key === "once" ||
      (row.recurrence_key ?? "") < stop && row.scheduled_date < stop;
  } };
}

async function projectWindow(client: SupabaseClient, userId: string, timezone: string,
  selected: string, from: string, to: string,
  definitions: Awaited<ReturnType<typeof readWorkspaceDefinitions>>, recentCompletions = false) {
  const [stored, generated] = await Promise.all([
    readOwnedRows<OccurrenceRow>(client, "task_occurrences", occurrenceFields, userId, true,
      undefined, { from, to }),
    readRecurrenceCandidates(client, userId, from, to),
  ]);
  const completed = recentCompletions ? await readOwnedRows<OccurrenceRow>(client,
    "task_occurrences", occurrenceFields, userId, true,
    { key: "status", value: "completed" }, undefined,
    new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()) : [];
  const all = [...new Map([...stored, ...generated, ...completed].map((row) => [row.id, row])).values()];
  const keys = [...new Set(all.map((row) => row.recurrence_key ?? "once"))];
  const deletedParents = new Set<string>();
  for (let start = 0; start < keys.length; start += 100) {
    let after: string | undefined;
    for (;;) {
      let query = client.from("task_occurrences").select("id,task_id,recurrence_key")
        .eq("owner_id", userId).in("recurrence_key", keys.slice(start, start + 100))
        .not("deleted_at", "is", null).order("id").limit(500);
      if (after) query = query.gt("id", after);
      const { data, error } = await query;
      if (error || !data) throw error ?? new Error("Missing deleted occurrence keys");
      for (const row of data) deletedParents.add(`${row.task_id}:${row.recurrence_key}`);
      if (!data.length) break;
      after = data[data.length - 1].id;
    }
  }
  const parentIds = new Map(definitions.tasks.map((task) => [task.id, task.parent_task_id]));
  return projectWorkspace(timezone, selected, definitions.categories, definitions.tasks,
    all.filter((row) => definitions.visible(row) &&
      (row.status !== "open" || !parentIds.get(row.task_id) ||
        !deletedParents.has(`${parentIds.get(row.task_id)}:${row.recurrence_key ?? "once"}`)))).tasks;
}

export async function readMissedPage(client: SupabaseClient, userId: string, timezone: string,
  cursor: BacklogCursor, definitions?: Awaited<ReturnType<typeof readWorkspaceDefinitions>>):
  Promise<{ tasks: ReadTask[]; cursor: BacklogCursor | null }> {
  const state = definitions ?? await readWorkspaceDefinitions(client, userId);
  const today = dateInZone(new Date(), timezone);
  const openStored = () => client.from("task_occurrences").select("scheduled_date").eq("owner_id", userId)
    .eq("status", "open").in("definition_snapshot->>behavior", ["deadline", "flexible"])
    .is("deleted_at", null);
  // shortcut: A series revision may have no open past instances; add a database existence check if empty recurring history becomes common.
  const [oldestStored, revisions] = await Promise.all([
    openStored().order("scheduled_date", { ascending: true }).limit(1).maybeSingle(),
    readOwnedRows<BacklogRevision>(client, "task_recurrence_revisions",
      "id,effective_from,definition_snapshot,child_templates", userId, false,
      { key: "stopped", value: false }),
  ]);
  if (oldestStored.error) throw oldestStored.error;
  const eligible = (snapshot: { behavior: string }) => snapshot.behavior === "deadline" || snapshot.behavior === "flexible";
  const seriesStarts = revisions.flatMap((revision) => [
    ...(eligible(revision.definition_snapshot) ? [revision.effective_from] : []),
    ...revision.child_templates.filter((child) => eligible(child.snapshot))
      .map((child) => addDays(revision.effective_from, child.day_offset)),
  ]);
  const earliestSeries = seriesStarts.sort()[0];
  const earliest = [oldestStored.data?.scheduled_date, earliestSeries]
    .filter((value): value is string => !!value).sort()[0];
  if (!earliest) return { tasks: [], cursor: null };
  let page = cursor;
  if (!earliestSeries && !page.offset) {
    const nearest = await openStored().lte("scheduled_date", page.before)
      .order("scheduled_date", { ascending: false }).limit(1).maybeSingle();
    if (nearest.error) throw nearest.error;
    if (!nearest.data) return { tasks: [], cursor: null };
    page = { before: nearest.data.scheduled_date, offset: 0 };
  }
  // Bound each request, while skipping empty weeks before returning a result.
  for (let checked = 0; checked < 8; checked++) {
    const from = addDays(page.before, -6);
    const items = (await projectWindow(client, userId, timezone, today, from, page.before, state))
      .filter((task) => task.overdue || task.date === today && task.scheduledDate < today && task.status !== "canceled");
    const tasks = items.slice(page.offset, page.offset + 50);
    let next: BacklogCursor | null = page.offset + 50 < items.length
      ? { before: page.before, offset: page.offset + 50 }
      : earliest && from > earliest ? { before: addDays(from, -1), offset: 0 } : null;
    if (next && !next.offset && !earliestSeries) {
      const older = await openStored().lte("scheduled_date", next.before)
        .order("scheduled_date", { ascending: false }).limit(1).maybeSingle();
      if (older.error) throw older.error;
      next = older.data ? { before: older.data.scheduled_date, offset: 0 } : null;
    }
    if (tasks.length || !next) return { tasks, cursor: next };
    page = next;
  }
  return { tasks: [], cursor: page };
}

export async function loadWorkspace(verifiedUserId: string, selectedDate?: unknown): Promise<Workspace | { kind: "signed-out" }> {
  try {
    const client = await createClient();
    const { data: { user }, error } = await client.auth.getUser();
    if (error || !user || user.id !== verifiedUserId) return { kind: "signed-out" };
    const settings = await readSettings(client, user.id);
    if (!settings?.defaults_initialized_at) return { kind: "setup" };
    const definitions = await readWorkspaceDefinitions(client, user.id);
    const today = dateInZone(new Date(), settings.timezone);
    const selected = validDate(selectedDate) && selectedDate >= "0002-01-01" && selectedDate <= "9998-12-31" ? selectedDate : today;
    const week = startOfWeek(selected);
    const tasks = await projectWindow(client, user.id, settings.timezone, selected,
      week, addDays(week, 6), definitions, today >= week && today <= addDays(week, 6));
    const initial = today >= week && today <= addDays(week, 6)
      ? await readMissedPage(client, user.id, settings.timezone,
        { before: addDays(week, -1), offset: 0 }, definitions)
      : { tasks: [], cursor: null };
    return { kind: "ready", timezone: settings.timezone, today, selected,
      tasks, backlog: initial.tasks, backlogCursor: initial.cursor };
  } catch {
    // Provider messages may contain private details. Never substitute demo rows.
    return { kind: "error" };
  }
}
