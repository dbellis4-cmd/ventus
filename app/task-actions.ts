"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { isValidActionOrigin } from "@/lib/auth/site-url";
import { buildTaskWrite, readTaskEditor } from "@/lib/server/task-editor";
import { TaskInputError, type EditorResult, type LifecycleResult, type SaveResult, type TaskFailure } from "@/lib/tasks/editor";
import { validId, validateLifecycleCommand, validateSaveCommand } from "@/lib/tasks/validation";
import { dateInZone } from "@/lib/tasks/dates";
import { makeSchedule } from "@/lib/tasks/schedules";

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

export async function getTaskEditor(taskId: unknown = null): Promise<EditorResult> {
  try {
    if (taskId !== null && !validId(taskId)) throw new TaskInputError("Invalid task reference.");
    const { client, userId } = await authorize();
    return { ok: true, editor: await readTaskEditor(client, userId, taskId) };
  } catch (error) { return failure(error); }
}

export async function saveTask(input: unknown): Promise<SaveResult> {
  let attemptedWrite = false;
  let result: Extract<SaveResult, { ok: true }>;
  try {
    const command = validateSaveCommand(input);
    const { client, userId } = await authorize();
    const editor = await readTaskEditor(client, userId, command.kind === "edit" ? command.taskId : null);
    const write = buildTaskWrite(command, editor);
    let taskId = command.kind === "edit" ? command.taskId : "";
    if (write.changed) {
      // Exactly one RPC per submit. No direct DML, original-slot/history fields,
      // lifecycle operations, fresh-version retries or external side effects.
      attemptedWrite = true;
      const { data, error } = await client.rpc(write.rpc, write.args);
      if (error) throw error;
      if (write.rpc === "create_task") {
        if (!validId(data?.task_id)) return failure(null, true);
        taskId = data.task_id;
      }
    }
    const target = editor.nodes.find((node) => node.id === editor.taskId);
    const behavior = !write.changed && target ? target.behavior : target?.behaviorOverride ?? editor.categories.find((category) => category.id === command.draft.categoryId)!.behavior;
    const today = dateInZone(new Date(), editor.timezone);
    result = { ok: true, taskId, date: behavior === "flexible" && command.draft.date < today ? today : command.draft.date };
  } catch (error) { return failure(error, attemptedWrite); }
  // A cache refresh failure cannot turn a committed write into a failed save.
  try { revalidatePath("/"); } catch { result.refreshFailed = true; }
  return result;
}

export async function changeTaskLifecycle(input: unknown): Promise<LifecycleResult> {
  let attemptedWrite = false;
  let result: Extract<LifecycleResult, { ok: true }>;
  try {
    const command = validateLifecycleCommand(input);
    const { client, userId } = await authorize();
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
  return result;
}
