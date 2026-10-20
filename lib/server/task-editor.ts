import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { readOwnedRows, readSettings } from "@/lib/server/workspace";
import type { CategoryRow } from "@/lib/tasks/projections";
import { TaskInputError, type EditorNode, type TaskEditor, type SaveCommand } from "@/lib/tasks/editor";
import { makeSchedule } from "@/lib/tasks/schedules";
import { validVersion } from "@/lib/tasks/validation";

type Definition = { id: string; parent_task_id: string | null; title: string; category_id: string; location: string | null; calendar_opt_in: boolean; behavior_override: EditorNode["behaviorOverride"]; version: number };
type Occurrence = { id: string; task_id: string; version: number; status: EditorNode["status"]; scheduled_date: string; timezone: string; start_time: string | null; starts_at: string | null; end_date: string | null; end_time: string | null; ends_at: string | null; definition_snapshot: { behavior: EditorNode["behavior"] } };
const unavailable = () => new TaskInputError("Task or category unavailable. Refresh and try again.", "unavailable");

export async function readTaskEditor(client: SupabaseClient, userId: string, taskId: string | null): Promise<TaskEditor> {
  const settings = await readSettings(client, userId);
  if (!settings?.defaults_initialized_at) throw new TaskInputError("Confirm your workspace time zone before creating tasks.");
  const categories = await readOwnedRows<CategoryRow>(client, "categories", "id,name,seed_key,behavior,calendar_default,archived_at", userId, false);
  if (!taskId) return { taskId: null, rootId: null, rootVersion: null, timezone: settings.timezone, categories, nodes: [] };
  const definitions = await readOwnedRows<Definition>(client, "tasks", "id,parent_task_id,title,category_id,location,calendar_opt_in,behavior_override,version", userId, true);
  const byId = new Map(definitions.map((node) => [node.id, node]));
  function rootOf(id: string): string {
    const seen = new Set<string>();
    for (;;) {
      const node = byId.get(id);
      if (!node || seen.has(id) || seen.size > 10) throw unavailable();
      seen.add(id);
      if (!node.parent_task_id) return node.id;
      id = node.parent_task_id;
    }
  }
  const rootId = rootOf(taskId);
  const tree = definitions.filter((node) => rootOf(node.id) === rootId);
  const occurrences = await readOwnedRows<Occurrence>(client, "task_occurrences", "id,task_id,version,status,scheduled_date,timezone,start_time,starts_at,end_date,end_time,ends_at,definition_snapshot", userId, true);
  const byTask = new Map(occurrences.map((node) => [node.task_id, node]));
  const nodes = tree.map((node): EditorNode => {
    const occurrence = byTask.get(node.id);
    if (!occurrence || !validVersion(node.version) || !validVersion(occurrence.version)) throw unavailable();
    return {
      id: node.id, parentId: node.parent_task_id, taskVersion: node.version, occurrenceVersion: occurrence.version,
      title: node.title, categoryId: node.category_id, location: node.location ?? "", calendarOptIn: node.calendar_opt_in, status: occurrence.status,
      behavior: occurrence.definition_snapshot.behavior, behaviorOverride: node.behavior_override,
      date: occurrence.scheduled_date, timezone: occurrence.timezone, time: occurrence.start_time ?? "", startsAt: occurrence.starts_at ?? "",
      endDate: occurrence.end_date ?? "", endTime: occurrence.end_time ?? "", endsAt: occurrence.ends_at ?? "",
    };
  });
  const rootVersion = byId.get(rootId)!.version;
  // A child write also bumps the root. Check it again to detect a tree changing
  // between paginated definition and occurrence reads; never return a partial tree.
  const { data, error } = await client.from("tasks").select("version").eq("owner_id", userId).eq("id", rootId).is("deleted_at", null).maybeSingle();
  if (error) throw error;
  if (!data || data.version !== rootVersion) throw new TaskInputError("The task hierarchy changed while loading. Try opening it again.", "conflict");
  return { taskId, rootId, rootVersion, timezone: settings.timezone, categories, nodes };
}

export function buildTaskWrite(command: SaveCommand, editor: TaskEditor) {
  const { draft } = command;
  const target = editor.nodes.find((node) => node.id === editor.taskId);
  if (!editor.categories.some((category) => category.id === draft.categoryId)) throw unavailable();
  function newSubtask(sub: typeof draft.subtasks[number]) {
    if (sub.startInstant || sub.endInstant) throw new TaskInputError("New inline subtasks must be anytime tasks.");
    return { title: sub.title, category_id: draft.categoryId, schedule: makeSchedule(sub.date, "", "", draft.timezone), calendar_opt_in: false };
  }
  if (command.kind === "create") {
    const task = { title: draft.title, category_id: draft.categoryId, location: draft.location || null,
      schedule: makeSchedule(draft.date, draft.time, draft.endTime, draft.timezone, draft.startInstant, draft.endInstant),
      subtasks: draft.subtasks.map(newSubtask) };
    return { rpc: "create_task" as const, args: { p_creation_key: command.creationKey, p_task: task }, changed: true };
  }
  if (!target || editor.rootId !== command.rootId || editor.taskId !== command.taskId) throw unavailable();
  if (editor.rootVersion !== command.rootVersion || target.taskVersion !== command.taskVersion || target.occurrenceVersion !== command.occurrenceVersion) {
    throw new TaskInputError("This task or a subtask changed elsewhere. Your draft is kept. Reload the saved task to review the changes.", "conflict");
  }
  if (target.status !== "open") throw new TaskInputError("Completed tasks must be reopened before editing. Canceled tasks cannot be edited.");
  if (draft.timezone !== target.timezone) throw new TaskInputError("Editing must preserve the task's stored timezone.");
  if (target.parentId) {
    const parent = editor.nodes.find((node) => node.id === target.parentId);
    if (!parent) throw unavailable();
    if (draft.categoryId !== parent.categoryId) throw new TaskInputError("Subtasks must inherit their parent's category.");
    if (draft.subtasks.length) throw new TaskInputError("Subtasks cannot contain nested subtasks.");
  }
  // Legacy deeper relationships stay untouched. This editor can add children only
  // to a top-level task, regardless of the broader database hierarchy contract.
  const children = editor.nodes.filter((node) => !target.parentId && node.parentId === target.id);
  if (children.some((child) => !draft.subtasks.some((sub) => sub.id === child.id))) throw new TaskInputError("Delete saved subtasks from their task row.");
  type Patch = { title?: string; category_id?: string; location?: string | null; schedule?: ReturnType<typeof makeSchedule> };
  const edits: { task_id: string; task_version: number; occurrence_version: number; patch: Patch }[] = [];
  function addEdit(node: EditorNode, patch: Patch) {
    if (!Object.keys(patch).length) return;
    if (node.status !== "open" && patch.category_id) throw new TaskInputError("Category changes cannot update completed or canceled subtasks. Their historical categories must be preserved.");
    if (node.status !== "open") throw new TaskInputError("Completed or canceled subtasks cannot be edited until reopened.");
    edits.push({ task_id: node.id, task_version: node.taskVersion, occurrence_version: node.occurrenceVersion, patch });
  }
  function changedSchedule(node: EditorNode, date: string, time: string, endTime: string, start: string, end: string) {
    if (node.endTime && node.endDate !== node.date) throw new TaskInputError("Overnight schedule changes are unavailable. Other task fields can still be edited.");
    return makeSchedule(date, time, endTime, node.timezone, start, end);
  }
  const patch: Patch = {};
  if (draft.title !== target.title) patch.title = draft.title;
  if (draft.categoryId !== target.categoryId) patch.category_id = draft.categoryId;
  if (draft.location !== target.location) patch.location = draft.location || null;
  if (draft.date !== target.date || draft.time !== target.time || draft.endTime !== target.endTime || draft.startInstant !== target.startsAt || draft.endInstant !== target.endsAt) {
    patch.schedule = changedSchedule(target, draft.date, draft.time, draft.endTime, draft.startInstant, draft.endInstant);
  }
  addEdit(target, patch);
  const additions: { parent_task_id: string; task: ReturnType<typeof newSubtask> }[] = [];
  for (const sub of draft.subtasks) {
    if (!sub.id) { additions.push({ parent_task_id: target.id, task: newSubtask(sub) }); continue; }
    const child = children.find((node) => node.id === sub.id);
    if (!child) throw unavailable();
    const childPatch: Patch = {};
    if (child.status !== "canceled" && child.categoryId !== draft.categoryId) childPatch.category_id = draft.categoryId;
    if (sub.title !== child.title) childPatch.title = sub.title;
    if (sub.date !== child.date || sub.startInstant !== child.startsAt || sub.endInstant !== child.endsAt) {
      childPatch.schedule = changedSchedule(child, sub.date, child.time, child.endTime, sub.startInstant, sub.endInstant);
    }
    addEdit(child, childPatch);
  }
  if (edits.length + additions.length > 100) throw new TaskInputError("A command may change at most 100 tasks.");
  return { rpc: "edit_task_tree" as const, args: { p_root_task_id: command.rootId, p_expected_root_version: command.rootVersion,
    p_edits: edits, p_new_subtasks: additions, p_delete_subtasks: [] }, changed: edits.length + additions.length > 0 };
}
