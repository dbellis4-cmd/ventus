"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isValidActionOrigin } from "@/lib/auth/site-url";
import { buildTaskWrite, readTaskEditor } from "@/lib/server/task-editor";
import { readMissedPage, readSettings } from "@/lib/server/workspace";
import { TaskInputError, type EditorResult, type LifecycleResult, type SaveResult, type TaskFailure } from "@/lib/tasks/editor";
import { validId, validateLifecycleCommand, validateSaveCommand } from "@/lib/tasks/validation";
import { dateInZone, validDate } from "@/lib/tasks/dates";
import { makeSchedule } from "@/lib/tasks/schedules";
import type { BacklogCursor, ReadTask } from "@/lib/tasks/projections";
import { syncOwner } from "@/lib/google/sync";

function scheduleCalendarSync(userId: string) {
  // shortcut: after() is bounded by the hosting function lifetime; the dirty queue and daily recovery retry unfinished writes.
  try { after(async () => { try { await syncOwner(userId); } catch { /* Task writes remain saved for recovery. */ } }); }
  catch { /* Calendar scheduling cannot turn a committed task write into a failure. */ }
}

async function authorize() {
  const requestHeaders = await headers();
  if (!isValidActionOrigin(requestHeaders.get("origin"), requestHeaders.get("host"))) throw new TaskInputError("Invalid request origin. Reload the page and try again.", "unauthorized");
  const client = await createClient({ requireCookieWrites: true });
  const { data: { user }, error } = await client.auth.getUser();
  if (error || !user) throw new TaskInputError("Your session has expired. Sign in again.", "unauthorized");
  return { client, userId: user.id };
}

function failure(error: unknown, attemptedWrite = false): TaskFailure {
  if (error instanceof TaskInputError) return { ok: false, code: error.code, message: error.message };
  const code = (error as { code?: string } | null)?.code;
  if (code === "40001") return { ok: false, code: "conflict", message: "This task or a subtask changed elsewhere. Your draft is kept. Reload the saved task to review it." };
  if (code === "P0002" || code === "42501") return { ok: false, code: "unavailable", message: "Task or category unavailable. Refresh and try again." };
  if (code && /^(22|23|0A)/.test(code)) return { ok: false, code: "invalid", message: "The task could not be saved. Check the fields, active category, dates and task limits." };
  return attemptedWrite
    ? { ok: false, code: "uncertain", message: "The save outcome is unknown. Your draft is kept. Retry the same save before making further changes." }
    : { ok: false, code: "unavailable", message: "Task storage is temporarily unavailable. Your draft is kept. Please try again." };
}

export async function getTaskEditor(taskId: unknown = null, recurrenceKey?: unknown): Promise<EditorResult> {
  try {
    if (taskId !== null && !validId(taskId)) throw new TaskInputError("Invalid task reference.");
    if (recurrenceKey !== undefined && !(recurrenceKey === "once" || validDate(recurrenceKey))) throw new TaskInputError("Invalid occurrence reference.");
    const { client, userId } = await authorize();
    return { ok: true, editor: await readTaskEditor(client, userId, taskId, recurrenceKey as string | undefined) };
  } catch (error) { return failure(error); }
}

export async function getMissedPage(cursor: unknown): Promise<
  { ok: true; tasks: ReadTask[]; cursor: BacklogCursor | null } | TaskFailure> {
  try {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor) ||
        Object.keys(cursor).sort().join(",") !== "before,offset") throw new TaskInputError("Invalid backlog page.");
    const page = cursor as BacklogCursor;
    if (!validDate(page.before) || page.before < "0002-01-07" || page.before > "9998-12-31" ||
        !Number.isSafeInteger(page.offset) || page.offset < 0) {
      throw new TaskInputError("Invalid backlog page.");
    }
    const { client, userId } = await authorize();
    const settings = await readSettings(client, userId);
    if (!settings?.defaults_initialized_at) throw new TaskInputError("Workspace unavailable.", "unavailable");
    const today = dateInZone(new Date(), settings.timezone);
    if (page.before >= today) throw new TaskInputError("Backlog page must precede Today.");
    return { ok: true, ...await readMissedPage(client, userId, settings.timezone, page) };
  } catch (error) { return failure(error); }
}

export async function saveTask(input: unknown): Promise<SaveResult> {
  let attemptedWrite = false;
  let syncOwnerId: string | null = null;
  let result: Extract<SaveResult, { ok: true }>;
  try {
    const command = validateSaveCommand(input);
    const { client, userId } = await authorize();
    const editor = await readTaskEditor(client, userId, command.kind === "edit" ? command.taskId : null,
      command.kind === "edit" ? command.recurrenceKey : undefined);
    const write = buildTaskWrite(command, editor);
    let taskId = command.kind === "edit" ? command.taskId : "";
    if (write.changed) {
      // Exactly one RPC per submit. No direct DML, original-slot/history fields,
      // lifecycle operations, fresh-version retries or external side effects.
      attemptedWrite = true;
      const { data, error } = await client.rpc(write.rpc, write.args);
      if (error) throw error;
      if (write.rpc === "create_task" || write.rpc === "create_recurring_task") {
        if (!validId(data?.task_id)) return failure(null, true);
        taskId = data.task_id;
      }
      syncOwnerId = userId;
    }
    const target = editor.nodes.find((node) => node.id === editor.taskId);
    const behavior = !write.changed && target ? target.behavior : target?.behaviorOverride ?? editor.categories.find((category) => category.id === command.draft.categoryId)!.behavior;
    const today = dateInZone(new Date(), editor.timezone);
    result = { ok: true, taskId, date: behavior === "flexible" && command.draft.date < today ? today : command.draft.date };
  } catch (error) { return failure(error, attemptedWrite); }
  // A cache refresh failure cannot turn a committed write into a failed save.
  try { revalidatePath("/"); } catch { result.refreshFailed = true; }
  if (syncOwnerId) scheduleCalendarSync(syncOwnerId);
  return result;
}

export async function changeTaskLifecycle(input: unknown): Promise<LifecycleResult> {
  let attemptedWrite = false;
  let syncOwnerId: string | null = null;
  let result: Extract<LifecycleResult, { ok: true }>;
  try {
    const command = validateLifecycleCommand(input);
    const { client, userId } = await authorize();
    syncOwnerId = userId;
    if (command.recurrenceKey) {
      const accountZone = command.kind === "postpone" ? null : (await readSettings(client, userId))?.timezone;
      let error: { code?: string } | null = null;
      if (command.kind === "delete" && command.scope === "future_series") {
        let from = command.recurrenceKey;
        if (from === "once") {
          const first = await client.from("task_recurrence_revisions").select("effective_from")
            .eq("owner_id", userId).eq("task_id", command.taskId).order("revision").limit(1).maybeSingle();
          if (first.error || !first.data) throw first.error ?? new TaskInputError("Series unavailable.", "unavailable");
          from = first.data.effective_from;
        }
        attemptedWrite = true;
        ({ error } = await client.rpc("change_recurring_series", {
          p_task_id: command.taskId, p_expected_series_version: command.rootVersion,
          p_from_date: from, p_stop: true,
        }));
      } else {
        const schedule = command.kind === "postpone"
          ? makeSchedule(command.date, command.time, command.endTime, command.timezone || "", command.startInstant,
              command.endInstant, command.endDate || command.date) : null;
        attemptedWrite = true;
        ({ error } = await client.rpc("mutate_recurring_occurrence", {
          p_task_id: command.taskId, p_recurrence_key: command.recurrenceKey,
          p_expected_series_version: command.rootVersion,
          p_expected_occurrence_version: command.occurrenceVersion,
          p_action: command.kind === "completion" ? command.completed ? "complete" : "reopen" : command.kind,
          p_schedule: schedule, p_reason: command.kind === "cancel" ? command.reason || null : null,
        }));
      }
      if (error) throw error;
      result = { ok: true, date: command.kind === "postpone" ? command.date : dateInZone(new Date(), accountZone || "UTC") };
      try { revalidatePath("/"); } catch { result.refreshFailed = true; }
      scheduleCalendarSync(userId);
      return result;
    }
    const editor = await readTaskEditor(client, userId, command.taskId);
    const target = editor.nodes.find((node) => node.id === command.taskId);
    if (!target) throw new TaskInputError("Task unavailable. Refresh and try again.", "unavailable");
    if ((command.kind === "delete" && editor.rootVersion !== command.rootVersion) || target.taskVersion !== command.taskVersion || target.occurrenceVersion !== command.occurrenceVersion) {
      throw new TaskInputError("This task changed elsewhere. Refresh and review it before trying again.", "conflict");
    }
    const versions = { p_task_id: target.id, p_expected_task_version: target.taskVersion, p_expected_occurrence_version: target.occurrenceVersion };
    let rpc: "set_task_completion" | "postpone_task" | "cancel_task" | "soft_delete_task";
    let args: Record<string, unknown>;
    if (command.kind === "completion") {
      if (target.status === "canceled") throw new TaskInputError("Canceled tasks cannot be completed or reopened.");
      rpc = "set_task_completion"; args = { ...versions, p_completed: command.completed };
    } else if (command.kind === "postpone") {
      if (target.status !== "open") throw new TaskInputError("Only open tasks can be postponed.");
      const schedule = makeSchedule(command.date, command.time, command.endTime, target.timezone, command.startInstant, command.endInstant, command.endDate || command.date);
      const sameInstant = (a: string | null, b: string) => !a && !b || !!a && !!b && Date.parse(a) === Date.parse(b);
      if (schedule.date === target.date && schedule.end_date === (target.endDate || null) && sameInstant(schedule.starts_at, target.startsAt) && sameInstant(schedule.ends_at, target.endsAt)) {
        throw new TaskInputError("Choose a different date or time to postpone this task.");
      }
      rpc = "postpone_task"; args = { ...versions, p_schedule: schedule };
    } else if (command.kind === "cancel") {
      if (target.status !== "open") throw new TaskInputError("Only open tasks can be canceled.");
      rpc = "cancel_task"; args = { ...versions, p_reason: command.reason || null };
    } else {
      rpc = "soft_delete_task"; args = { ...versions, p_expected_root_version: editor.rootVersion };
    }
    attemptedWrite = true;
    const { error } = await client.rpc(rpc, args);
    if (error) throw error;
    const today = dateInZone(new Date(), editor.timezone);
    const date = command.kind === "postpone" ? command.date : target.behavior === "flexible" && target.date < today ? today : target.date;
    result = { ok: true, date };
  } catch (error) {
    const failed = failure(error, attemptedWrite);
    return failed.code === "uncertain" ? { ...failed, message: "The outcome is unknown. Refresh the Dashboard before trying again." } : failed;
  }
  try { revalidatePath("/"); } catch { result.refreshFailed = true; }
  if (syncOwnerId) scheduleCalendarSync(syncOwnerId);
  return result;
}
