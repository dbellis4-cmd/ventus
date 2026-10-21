import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import ts from "typescript";
const requireModule = createRequire(import.meta.url);
function load(file, mocks = {}, env = {}) {
  const code = ts.transpileModule(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const testModule = { exports: {} };
  vm.runInNewContext(code, { module: testModule, exports: testModule.exports, Date, Intl, TextEncoder, FormData, URL, process: { env }, crypto: { randomUUID },
    require(name) {
      if (Object.hasOwn(mocks, name)) return mocks[name];
      if (name === "server-only") return {};
      if (name.startsWith("@/") || name.startsWith("./")) throw new Error(`Unmocked import ${name}`);
      return requireModule(name);
    },
  }, { filename: file });
  return testModule.exports;
}
const dates = load("lib/tasks/dates.ts");
const deployedOrigin = load("lib/auth/site-url.ts", {}, { NODE_ENV: "production", SITE_URL: "https://ventus.example.test" });
const localOrigin = load("lib/auth/site-url.ts", {}, { NODE_ENV: "development" });
const editorTypes = load("lib/tasks/editor.ts");
const schedules = load("lib/tasks/schedules.ts", { "./dates": dates, "./editor": editorTypes });
const validation = load("lib/tasks/validation.ts", { "./dates": dates, "./editor": editorTypes, "./schedules": schedules });
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const category = { id: id(90), name: "Assignments", seed_key: "assignments", behavior: "deadline", calendar_default: true, archived_at: null };
function node(n, parentId = null) {
  return { id: id(n), parentId, taskVersion: 3, occurrenceVersion: 2, title: `Task ${n}`, categoryId: category.id, location: "Library", calendarOptIn: true, behavior: "deadline", behaviorOverride: null, status: "open", date: "2026-10-20", timezone: "America/Phoenix", time: "", startsAt: "", endDate: "", endTime: "", endsAt: "" };
}
function context() {
  return { taskId: id(1), rootId: id(1), rootVersion: 3, timezone: "America/Phoenix", categories: [{ ...category }], nodes: [node(1), node(2, id(1)), node(3, id(2)), node(4, id(1))] };
}
const serviceMocks = {
  "@/lib/server/workspace": {},
  "@/lib/tasks/editor": editorTypes, "@/lib/tasks/schedules": schedules,
  "@/lib/tasks/dates": dates, "@/lib/tasks/validation": validation,
};
const service = load("lib/server/task-editor.ts", serviceMocks);
const clean = value => JSON.parse(JSON.stringify(value));
function editCommand(editor = context()) {
  return { kind: "edit", taskId: editor.taskId, rootId: editor.rootId, rootVersion: editor.rootVersion, taskVersion: editor.nodes.find(n => n.id === editor.taskId).taskVersion, occurrenceVersion: editor.nodes.find(n => n.id === editor.taskId).occurrenceVersion, draft: editorTypes.initialDraft(editor, "2026-10-20") };
}
function createCommand() {
  const editor = { taskId: null, rootId: null, rootVersion: null, timezone: "America/Phoenix", categories: [category], nodes: [] };
  return { kind: "create", creationKey: id(80), draft: { ...editorTypes.initialDraft(editor, "2026-10-20"), title: "New task", categoryId: category.id } };
}
function newSub(title = "Independent subtask", date = "2026-10-23") { return { id: null, title, date, startInstant: "", endInstant: "" }; }
function lifecycleCommand(kind, editor = context(), values = {}) {
  const task = editor.nodes.find(node => node.id === editor.taskId);
  return { kind, taskId: task.id, rootVersion: editor.rootVersion, taskVersion: task.taskVersion, occurrenceVersion: task.occurrenceVersion, ...values };
}

test("schedule conversion round-trips selected zones; gaps reject and folds require explicit choices", () => {
  assert.equal(schedules.makeSchedule("2026-10-20", "09:30", "10:30", "America/Phoenix").starts_at, "2026-10-20T16:30:00Z");
  assert.equal(schedules.makeSchedule("2026-10-20", "09:30", "", "Asia/Kathmandu").starts_at, "2026-10-20T03:45:00Z");
  assert.equal(schedules.possibleInstants("2026-03-08", "02:30", "America/New_York").length, 0);
  assert.throws(() => schedules.makeSchedule("2026-03-08", "02:30", "", "America/New_York"), /does not exist/);
  const choices = schedules.possibleInstants("2026-11-01", "01:30", "America/New_York");
  assert.equal(choices.join(","), "2026-11-01T05:30:00Z,2026-11-01T06:30:00Z");
  assert.throws(() => schedules.makeSchedule("2026-11-01", "01:30", "", "America/New_York"), /explicit UTC instant/);
  assert.equal(schedules.makeSchedule("2026-11-01", "01:30", "", "America/New_York", choices[1]).starts_at, choices[1]);
  assert.throws(() => schedules.makeSchedule("2026-10-20", "09:30", "09:00", "America/Phoenix"), /after/);
  assert.throws(() => schedules.makeSchedule("2026-10-20", "", "", "America/Phoenix", choices[0]), /Anytime/);
  assert.throws(() => schedules.makeSchedule("2026-10-20", "09:30", "", "America/Phoenix", "2026-10-20T16:30:00"), /explicit UTC offset/);
  assert.equal(schedules.makeSchedule("2026-10-20", "09:30:00.123456", "", "UTC").starts_at, "2026-10-20T09:30:00.123456Z");
});

test("creation uses one key and atomic nested dated subtasks without client identities or protected fields", () => {
  const command = createCommand(); command.draft.subtasks.push(newSub());
  const write = service.buildTaskWrite(validation.validateSaveCommand(command), { ...context(), taskId: null, rootId: null, rootVersion: null, nodes: [] });
  assert.equal(write.rpc, "create_task");
  assert.equal(write.args.p_creation_key, command.creationKey);
  assert.equal(write.args.p_task.schedule.date, "2026-10-20");
  assert.equal(write.args.p_task.subtasks[0].schedule.date, "2026-10-23");
  assert.equal(write.args.p_task.subtasks[0].category_id, category.id);
  assert.equal(write.args.p_task.subtasks[0].calendar_opt_in, false);
  for (const field of ["owner_id", "id", "parentId", "version", "original_date", "recurrence", "RRULE"]) assert.ok(!Object.hasOwn(write.args.p_task, field));
  assert.equal(write.args.p_task.schedule.starts_at, null);
});

test("validation rejects malicious fields, recurrence/calendar/lifecycle writes, invalid dates, duplicate IDs and oversized requests", () => {
  for (const field of ["owner_id", "status", "recurrence", "calendar_opt_in", "original_date", "task_version"]) {
    const command = createCommand(); command.draft[field] = "tampered";
    assert.throws(() => validation.validateSaveCommand(command));
  }
  for (const patch of [{ date: "2026-02-30" }, { categoryId: "bad" }, { title: " " }, { time: "25:01" }, { location: "x".repeat(1001) }]) {
    const command = createCommand(); Object.assign(command.draft, patch);
    assert.throws(() => validation.validateSaveCommand(command));
  }
  const duplicate = editCommand(); duplicate.draft.subtasks.push(duplicate.draft.subtasks[0]);
  assert.throws(() => validation.validateSaveCommand(duplicate), /repeated/);
  const oversized = createCommand(); oversized.extra = "x".repeat(65536);
  assert.throws(() => validation.validateSaveCommand(oversized), /64 KiB/);
  const version = editCommand(); version.rootVersion = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(() => validation.validateSaveCommand(version), /version/);
});

test("editing keeps full tree references, independent schedules, immutable originals, unedited child state and expected versions", () => {
  const editor = context();
  editor.nodes[1] = { ...editor.nodes[1], timezone: "America/New_York", time: "10:00:00", startsAt: "2026-10-20T14:00:00+00:00", endDate: "2026-10-20", endTime: "11:00:00", endsAt: "2026-10-20T15:00:00+00:00" };
  const command = editCommand(editor);
  command.draft.title = "Edited parent";
  command.draft.subtasks[0] = { ...command.draft.subtasks[0], title: "Edited child", date: "2026-10-22", startInstant: "", endInstant: "" };
  command.draft.subtasks.push(newSub());
  const write = service.buildTaskWrite(validation.validateSaveCommand(command), editor);
  assert.equal(write.rpc, "edit_task_tree");
  assert.equal(write.args.p_root_task_id, id(1));
  assert.equal(write.args.p_expected_root_version, 3);
  assert.equal(write.args.p_edits.length, 2);
  const child = write.args.p_edits.find(edit => edit.task_id === id(2));
  assert.equal(child.task_version, 3); assert.equal(child.occurrence_version, 2);
  assert.equal(child.patch.schedule.date, "2026-10-22");
  assert.equal(child.patch.schedule.start_time, "10:00:00");
  assert.equal(child.patch.schedule.timezone, "America/New_York");
  assert.equal(child.patch.schedule.ends_at, "2026-10-22T15:00:00Z");
  assert.ok(!Object.hasOwn(child.patch, "category_id"));
  assert.ok(!JSON.stringify(write.args).includes("original_"));
  assert.equal(write.args.p_new_subtasks[0].parent_task_id, id(1));
  assert.equal(write.args.p_delete_subtasks.length, 0);
  assert.ok(!JSON.stringify(write.args).includes(id(3))); // Unedited grandchild stays untouched.
});

test("editing a subtask uses the actual hierarchy root and preserves all siblings/descendants", () => {
  const editor = context(); editor.taskId = id(2);
  const command = editCommand(editor); command.draft.title = "Child changed";
  const write = service.buildTaskWrite(validation.validateSaveCommand(command), editor);
  assert.equal(write.args.p_root_task_id, id(1));
  assert.equal(write.args.p_edits[0].task_id, id(2));
  assert.equal(write.args.p_edits.length, 1);
  assert.equal(write.args.p_new_subtasks.length, 0);
});

test("stale versions, foreign references, deletion and closed edits fail before writing; no-op edits do not create activity", () => {
  const command = editCommand(); command.draft.title = "My stale draft";
  const fresh = context(); fresh.rootVersion = 4;
  assert.throws(() => service.buildTaskWrite(command, fresh), error => error.code === "conflict");
  const removed = editCommand(); removed.draft.subtasks.pop();
  assert.throws(() => service.buildTaskWrite(removed, context()), /Delete saved subtasks from their task row/);
  const foreign = editCommand(); foreign.draft.subtasks.push({ ...newSub(), id: id(999) });
  assert.throws(() => service.buildTaskWrite(foreign, context()), /unavailable/);
  for (const status of ["completed", "canceled"]) {
    const editor = context(); editor.nodes[0].status = status;
    assert.throws(() => service.buildTaskWrite(editCommand(editor), editor), /cannot be edited|reopened/);
  }
  const editor = context(); editor.nodes[1].status = "completed";
  const keep = editCommand(editor); keep.draft.title = "Parent only";
  assert.equal(service.buildTaskWrite(keep, editor).args.p_edits.length, 1);
  keep.draft.subtasks[0].title = "Closed child";
  assert.throws(() => service.buildTaskWrite(keep, editor), /Completed or canceled/);
  assert.equal(service.buildTaskWrite(editCommand(), context()).changed, false);
});

test("unchanged overnight schedules and archived categories remain intact; schedule reinterpretation is rejected", () => {
  const editor = context();
  editor.categories[0].archived_at = "2026-10-01";
  editor.nodes[0] = { ...editor.nodes[0], time: "23:00:00", endTime: "01:00:00", startsAt: "2026-10-21T06:00:00Z", endsAt: "2026-10-21T08:00:00Z", endDate: "2026-10-21" };
  const command = editCommand(editor); command.draft.title = "Title only";
  assert.ok(!Object.hasOwn(service.buildTaskWrite(command, editor).args.p_edits[0].patch, "schedule"));
  command.draft.date = "2026-10-21";
  assert.throws(() => service.buildTaskWrite(command, editor), /Overnight/);
});

test("recurrence creates a series and routes virtual occurrence versus future series edits to distinct RPCs", () => {
  const create = createCommand();
  create.draft.recurrence = { frequency: "weekdays", weekdays: [1, 3], endDate: "", foldSide: "earlier" };
  const planned = service.buildTaskWrite(create, { taskId: null, rootId: null, rootVersion: null,
    timezone: "America/Phoenix", categories: [category], nodes: [] });
  assert.equal(planned.rpc, "create_recurring_task");
  assert.equal(planned.args.p_rule.frequency, "weekdays");

  const editor = { ...context(), recurrenceKey: "2026-10-21",
    seriesRule: { frequency: "daily", weekdays: [], endDate: "", foldSide: "earlier" },
    nodes: [node(1)] };
  editor.nodes[0].occurrenceVersion = 0;
  editor.nodes[0].date = "2026-10-21";
  const occurrence = editCommand(editor);
  occurrence.recurrenceKey = editor.recurrenceKey;
  occurrence.scope = "occurrence";
  occurrence.draft.title = "Only Wednesday";
  assert.equal(validation.validateSaveCommand(occurrence).occurrenceVersion, 0);
  const one = service.buildTaskWrite(occurrence, editor);
  assert.equal(one.rpc, "mutate_recurring_occurrence");
  assert.equal(one.args.p_recurrence_key, "2026-10-21");
  occurrence.scope = "series";
  const future = service.buildTaskWrite(occurrence, editor);
  assert.equal(future.rpc, "change_recurring_series");
  assert.equal(future.args.p_from_date, "2026-10-21");

  const child = node(2, id(1));
  child.occurrenceVersion = 0;
  child.date = "2026-10-22";
  const childEditor = { ...editor, taskId: id(2), nodes: [editor.nodes[0], child] };
  const childCommand = editCommand(childEditor);
  childCommand.recurrenceKey = "2026-10-21";
  childCommand.scope = "series";
  childCommand.draft.title = "Future child title";
  const childWrite = service.buildTaskWrite(childCommand, childEditor);
  assert.equal(childWrite.rpc, "change_recurring_child_series");
  assert.equal(childWrite.args.p_from_date, "2026-10-21");
});

test("parent date edits use atomic tree and occurrence RPCs with the original child references", () => {
  const once = context();
  const onceCommand = editCommand(once);
  onceCommand.draft.date = "2026-10-23";
  const onceWrite = service.buildTaskWrite(validation.validateSaveCommand(onceCommand), once);
  assert.equal(onceWrite.rpc, "edit_task_tree");
  assert.equal(onceWrite.args.p_edits.length, 1);
  assert.equal(onceWrite.args.p_edits[0].patch.schedule.date, "2026-10-23");
  assert.equal(onceWrite.args.p_new_subtasks.length, 0);

  const recurring = { ...context(), recurrenceKey: "2026-10-21",
    seriesRule: { frequency: "daily", weekdays: [], endDate: "", foldSide: "earlier" },
    nodes: [node(1), node(2, id(1))] };
  recurring.nodes[0].date = "2026-10-21";
  recurring.nodes[1].date = "2026-10-22";
  recurring.nodes[0].occurrenceVersion = 0;
  recurring.nodes[1].occurrenceVersion = 0;
  const recurringCommand = editCommand(recurring);
  recurringCommand.recurrenceKey = recurring.recurrenceKey;
  recurringCommand.scope = "occurrence";
  recurringCommand.draft.date = "2026-10-24";
  const recurringWrite = service.buildTaskWrite(validation.validateSaveCommand(recurringCommand), recurring);
  assert.equal(recurringWrite.rpc, "mutate_recurring_occurrence");
  assert.equal(recurringWrite.args.p_action, "edit");
  assert.equal(recurringWrite.args.p_schedule.date, "2026-10-24");
  assert.equal(recurringWrite.args.p_recurrence_key, "2026-10-21");
});

test("complete hierarchy reads include off-week parents, siblings and grandchildren, and detect inconsistent snapshots", async () => {
  const editor = context(); editor.nodes[2].date = "2027-01-01";
  const reads = [];
  const definitionRows = editor.nodes.map(node => ({ id: node.id, parent_task_id: node.parentId, title: node.title, category_id: node.categoryId, location: node.location, calendar_opt_in: true, version: node.taskVersion }));
  const occurrenceRows = editor.nodes.map(node => ({ id: id(100 + Number(node.id.slice(-2))), task_id: node.id, version: node.occurrenceVersion, status: node.status, scheduled_date: node.date, timezone: node.timezone, start_time: null, starts_at: null, end_date: null, end_time: null, ends_at: null, definition_snapshot: { behavior: node.behavior } }));
  const loader = load("lib/server/task-editor.ts", { ...serviceMocks, "@/lib/server/workspace": {
    readSettings: async (_client, user) => { assert.equal(user, "verified-user"); return { timezone: "America/Phoenix", defaults_initialized_at: "2026-10-20" }; },
    readOwnedRows: async (_client, table, _fields, user) => { reads.push([table, user]); return table === "categories" ? [category] : table === "tasks" ? definitionRows : occurrenceRows; },
  } });
  let rootVersion = 3;
  const filters = [];
  const query = { select() { return query; }, eq(key, value) { filters.push([key, value]); return query; }, is() { return query; }, maybeSingle: async () => ({ data: { version: rootVersion }, error: null }) };
  const client = { from: () => query };
  const loaded = await loader.readTaskEditor(client, "verified-user", id(2));
  assert.equal(loaded.rootId, id(1)); assert.equal(loaded.nodes.length, 4);
  assert.equal(loaded.nodes.find(node => node.id === id(3)).date, "2027-01-01");
  assert.ok(reads.every(([, user]) => user === "verified-user"));
  assert.ok(filters.some(([key, value]) => key === "owner_id" && value === "verified-user"));
  rootVersion = 4;
  await assert.rejects(loader.readTaskEditor(client, "verified-user", id(2)), error => error.code === "conflict");
  await assert.rejects(loader.readTaskEditor(client, "verified-user", id(999)), /unavailable/);
});

function actions({ identity = "verified-user", origin = "https://ventus.example.test", host = "ventus.example.test", originCheck = deployedOrigin, editor = context(), rpcError, rpcImpl, throwRpc = false, refreshError = false } = {}) {
  const calls = []; let initializedClient = 0;
  const client = {
    auth: { getUser: async () => ({ data: { user: identity ? { id: identity } : null }, error: null }) },
    rpc: async (name, args) => { calls.push({ name, args: clean(args) }); if (throwRpc) throw new Error("PRIVATE NETWORK DETAIL"); if (rpcImpl) return rpcImpl(name, args); return { data: { task_id: id(55) }, error: rpcError ?? null }; },
  };
  const taskActions = load("app/task-actions.ts", {
    "next/headers": { headers: async () => new Headers(origin ? { origin, host } : { host }) },
    "next/cache": { revalidatePath: () => { if (refreshError) throw new Error("Refresh failed"); } },
    "@/lib/supabase/server": { createClient: async () => { initializedClient++; return client; } },
    "@/lib/auth/site-url": originCheck,
    "@/lib/server/task-editor": {
      buildTaskWrite: service.buildTaskWrite,
      readTaskEditor: async (_client, userId, taskId) => { assert.equal(userId, identity); if (taskId && taskId !== editor.taskId) throw new editorTypes.TaskInputError("Task or category unavailable.", "unavailable"); return taskId ? editor : { ...editor, nodes: [], taskId: null, rootId: null, rootVersion: null }; },
    },
    "@/lib/server/workspace": { readSettings: async () => ({ timezone: "America/Phoenix" }) },
    "@/lib/tasks/editor": editorTypes, "@/lib/tasks/validation": validation, "@/lib/tasks/dates": dates, "@/lib/tasks/schedules": schedules,
  });
  return { ...taskActions, calls, get initializedClient() { return initializedClient; } };
}

test("Server Actions deny anonymous/cross-origin/malformed/foreign requests and never expose provider errors", async () => {
  for (const options of [{ identity: null }, { origin: "https://attacker.test" }, { origin: null }]) {
    const action = actions(options);
    assert.equal((await action.getTaskEditor(null)).ok, false);
    assert.equal((await action.saveTask(createCommand())).ok, false);
    assert.equal(action.calls.length, 0);
  }
  const action = actions();
  assert.equal((await action.saveTask({ owner_id: id(5) })).ok, false);
  assert.equal(action.initializedClient, 0);
  assert.equal((await action.getTaskEditor(id(999))).ok, false);
  assert.equal(action.calls.length, 0);
  const broken = actions({ rpcError: { code: "23514", message: "PRIVATE DATABASE DETAIL" } });
  assert.equal((await broken.saveTask(createCommand())).code, "invalid");
  assert.ok(!JSON.stringify(await broken.saveTask(createCommand())).includes("PRIVATE"));
});

test("task Server Actions accept the matching 127.0.0.1 development origin only", async () => {
  const local = actions({ origin: "http://127.0.0.1:3000", host: "127.0.0.1:3000", originCheck: localOrigin });
  assert.equal((await local.getTaskEditor(null)).ok, true);
  assert.equal((await local.saveTask(createCommand())).ok, true);
  assert.equal(local.calls.length, 1);
  const mismatch = actions({ origin: "http://127.0.0.1:3000", host: "localhost:3000", originCheck: localOrigin });
  assert.equal((await mismatch.getTaskEditor(null)).ok, false);
  assert.equal((await mismatch.saveTask(createCommand())).ok, false);
  assert.equal(mismatch.calls.length, 0);
});

test("completion and reopening use observed versions, affect only the selected node, and reject duplicate/stale submissions", async () => {
  const editor = context(); editor.taskId = id(2);
  const child = editor.nodes[1];
  const action = actions({ editor, rpcImpl: async () => { child.status = "completed"; child.taskVersion++; child.occurrenceVersion++; editor.rootVersion++; return { error: null }; } });
  const complete = lifecycleCommand("completion", editor, { completed: true });
  assert.equal((await action.changeTaskLifecycle(complete)).ok, true);
  assert.equal(action.calls[0].name, "set_task_completion");
  assert.equal(action.calls[0].args.p_task_id, id(2));
  assert.equal(action.calls[0].args.p_completed, true);
  assert.equal(editor.nodes[0].status, "open");
  assert.equal((await action.changeTaskLifecycle(complete)).code, "conflict");
  assert.equal(action.calls.length, 1);
  const reopen = lifecycleCommand("completion", editor, { completed: false });
  assert.equal((await action.changeTaskLifecycle(reopen)).ok, true);
  assert.equal(action.calls[1].args.p_completed, false);
  assert.ok(!Object.hasOwn(action.calls[1].args, "p_actual_completed_at"));
  const stale = actions({ rpcError: { code: "40001", message: "PRIVATE" } });
  assert.equal((await stale.changeTaskLifecycle(lifecycleCommand("completion", context(), { completed: true }))).code, "conflict");
});

test("sibling changes do not block target lifecycle writes; stale targets and subtree deletes still conflict", async () => {
  const cases = [
    ["completion", { completed: true }, "set_task_completion"],
    ["completion", { completed: false }, "set_task_completion"],
    ["postpone", { date: "2026-10-22", time: "", endDate: "", endTime: "", startInstant: "", endInstant: "" }, "postpone_task"],
    ["cancel", { reason: "" }, "cancel_task"],
  ];
  for (const [kind, values, rpc] of cases) {
    const editor = context(); editor.taskId = id(2);
    if (kind === "completion" && values.completed === false) editor.nodes[1].status = "completed";
    const command = lifecycleCommand(kind, editor, values);
    editor.rootVersion++; editor.nodes[3].taskVersion++;
    const action = actions({ editor });
    assert.equal((await action.changeTaskLifecycle(command)).ok, true, kind);
    assert.equal(action.calls[0].name, rpc);
    assert.ok(!Object.hasOwn(action.calls[0].args, "p_expected_root_version"));
    editor.nodes[1].occurrenceVersion++;
    assert.equal((await action.changeTaskLifecycle(command)).code, "conflict");
    assert.equal(action.calls.length, 1);
  }
  const editor = context(); editor.taskId = id(2);
  const command = lifecycleCommand("delete", editor);
  editor.rootVersion++;
  const deletion = actions({ editor });
  assert.equal((await deletion.changeTaskLifecycle(command)).code, "conflict");
  assert.equal(deletion.calls.length, 0);
});

test("postpone validates current-zone schedules and preserves the original slot in the RPC payload", async () => {
  const editor = context(); editor.nodes[0].timezone = "America/New_York";
  const action = actions({ editor });
  const base = lifecycleCommand("postpone", editor, { date: "2026-11-02", time: "09:00", endDate: "", endTime: "", startInstant: "", endInstant: "" });
  assert.equal((await action.changeTaskLifecycle(base)).ok, true);
  assert.equal(action.calls[0].name, "postpone_task");
  assert.equal(action.calls[0].args.p_schedule.timezone, "America/New_York");
  assert.equal(action.calls[0].args.p_schedule.starts_at, "2026-11-02T14:00:00Z");
  assert.ok(!Object.hasOwn(action.calls[0].args, "original_date"));
  for (const bad of [{ ...base, date: "2026-03-08", time: "02:30" }, { ...base, date: "2026-11-01", time: "01:30" }, { ...base, date: "2026-02-30" }, { ...base, time: "25:00" }]) {
    assert.equal((await action.changeTaskLifecycle(bad)).ok, false);
  }
  assert.equal(action.calls.length, 1);
  const same = lifecycleCommand("postpone", context(), { date: "2026-10-20", time: "", endDate: "", endTime: "", startInstant: "", endInstant: "" });
  assert.equal((await actions().changeTaskLifecycle(same)).code, "invalid");
  const timed = context(); timed.nodes[0].time = "09:00:00"; timed.nodes[0].startsAt = "2026-10-20T16:00:00+00:00";
  const sameTimed = lifecycleCommand("postpone", timed, { date: "2026-10-20", time: "09:00", endDate: "", endTime: "", startInstant: "", endInstant: "" });
  const unchanged = actions({ editor: timed });
  assert.equal((await unchanged.changeTaskLifecycle(sameTimed)).code, "invalid");
  assert.equal(unchanged.calls.length, 0);
});

test("cancellation, subtree deletion, unknown outcomes, and ownership checks use restricted RPCs only", async () => {
  const action = actions();
  assert.equal((await action.changeTaskLifecycle(lifecycleCommand("cancel", context(), { reason: "" }))).ok, true);
  assert.equal(action.calls[0].name, "cancel_task");
  assert.equal(action.calls[0].args.p_reason, null);
  assert.equal((await action.changeTaskLifecycle(lifecycleCommand("cancel", context(), { reason: "Travel" }))).ok, true);
  assert.equal(action.calls[1].args.p_reason, "Travel");
  assert.equal((await action.changeTaskLifecycle(lifecycleCommand("delete"))).ok, true);
  assert.equal(action.calls[2].name, "soft_delete_task");
  assert.equal(action.calls[2].args.p_expected_root_version, 3);
  assert.equal((await action.changeTaskLifecycle({ ...lifecycleCommand("delete"), owner_id: id(9) })).code, "invalid");
  assert.equal((await action.changeTaskLifecycle(lifecycleCommand("cancel", context(), { reason: "x".repeat(501) }))).code, "invalid");
  assert.equal(action.calls.length, 3);
  for (const options of [{ identity: null }, { origin: "https://attacker.test" }]) {
    const denied = actions(options);
    assert.equal((await denied.changeTaskLifecycle(lifecycleCommand("delete"))).ok, false);
    assert.equal(denied.calls.length, 0);
  }
  const foreign = actions();
  assert.equal((await foreign.changeTaskLifecycle({ ...lifecycleCommand("delete"), taskId: id(999) })).code, "unavailable");
  assert.equal(foreign.calls.length, 0);
  const uncertain = actions({ throwRpc: true });
  assert.equal((await uncertain.changeTaskLifecycle(lifecycleCommand("delete"))).code, "uncertain");
  assert.equal(uncertain.calls.length, 1);
});

test("duplicate/uncertain create submissions retain identical keys and payloads; no automatic retry occurs", async () => {
  const command = createCommand(); command.draft.subtasks.push(newSub());
  const action = actions();
  const first = await action.saveTask(command);
  const repeated = await action.saveTask(command);
  assert.equal(first.ok, true); assert.equal(first.taskId, repeated.taskId);
  assert.equal(action.calls.length, 2);
  assert.deepEqual(action.calls[0], action.calls[1]);
  const unknown = actions({ throwRpc: true });
  assert.equal((await unknown.saveTask(command)).code, "uncertain");
  assert.equal(unknown.calls.length, 1);
  assert.ok(!JSON.stringify(await unknown.saveTask(command)).includes("PRIVATE"));
  assert.deepEqual(unknown.calls[0], unknown.calls[1]);
});

test("stale edits preserve the submitted draft and never retry with a fresh root or occurrence version", async () => {
  const command = editCommand(); command.draft.title = "Keep this draft";
  const before = JSON.stringify(command);
  const fresh = context(); fresh.rootVersion = 4;
  const stale = actions({ editor: fresh });
  assert.equal((await stale.saveTask(command)).code, "conflict");
  assert.equal(stale.calls.length, 0);
  const concurrent = actions({ rpcError: { code: "40001", message: "PRIVATE" } });
  assert.equal((await concurrent.saveTask(command)).code, "conflict");
  assert.equal(concurrent.calls.length, 1);
  assert.equal(concurrent.calls[0].args.p_expected_root_version, 3);
  assert.equal(JSON.stringify(command), before);
  assert.equal(concurrent.calls[0].args.p_delete_subtasks.length, 0);
});

test("committed writes stay successful if refresh fails and no-op edits never invoke an RPC", async () => {
  const saved = actions({ refreshError: true });
  const result = await saved.saveTask(createCommand());
  assert.equal(result.ok, true); assert.equal(result.refreshFailed, true);
  assert.equal(saved.calls.length, 1);
  const noOp = actions();
  assert.equal((await noOp.saveTask(editCommand())).ok, true);
  assert.equal(noOp.calls.length, 0);
});

test("saving an old flexible task navigates to its Today projection without moving the stored slot", async () => {
  const editor = context(); editor.categories[0].behavior = "flexible";
  const command = createCommand(); command.draft.date = "2020-01-01";
  const action = actions({ editor });
  const result = await action.saveTask(command);
  assert.equal(result.ok, true);
  assert.equal(result.date, dates.dateInZone(new Date(), editor.timezone));
  assert.equal(action.calls[0].args.p_task.schedule.date, "2020-01-01");
  editor.nodes[0].date = "2020-01-01"; editor.nodes[0].behaviorOverride = "fixed";
  const fixed = actions({ editor }); const edit = editCommand(editor); edit.draft.title = "Edited fixed task";
  assert.equal((await fixed.saveTask(edit)).date, "2020-01-01");
});

const React = requireModule("react");
const { renderToStaticMarkup } = requireModule("react-dom/server");
function renderModal(editor, onDelete) {
  const { TaskModal } = load("components/dashboard/task-modal.tsx", {
    "@/app/task-actions": { getTaskEditor() { throw new Error("No read during render"); }, saveTask() { throw new Error("No write during render"); } },
    "@/lib/tasks/editor": editorTypes, "@/lib/tasks/schedules": schedules, "@/lib/tasks/validation": validation,
    "@/lib/tasks/dates": dates,
    "./icon": { Icon: () => null },
  });
  return renderToStaticMarkup(React.createElement(TaskModal, { editor, date: "2026-10-20", onSaved() {}, onClose() {}, onDelete }));
}

test("parent and creation modals retain full sections while subtask modal uses the same component with simplified content", () => {
  const parent = context();
  for (const editor of [parent, { ...parent, taskId: null, rootId: null, rootVersion: null, nodes: [] }]) {
    const html = renderModal(editor);
    for (const section of ["Recurrence", "Subtasks", "Add to Google Calendar"]) assert.ok(html.includes(section), section);
    assert.match(html, /<select required/);
    assert.ok(!html.includes("Part of:"));
  }
  const child = context(); child.taskId = id(2); child.nodes[0].title = "Paper <final>";
  const html = renderModal(child);
  assert.match(html, />Edit subtask<\/h2>/);
  assert.match(html, /Part of: Paper &lt;final&gt;/);
  for (const section of [">Recurrence", ">Subtasks", "Add subtask", "Add to Google Calendar"]) assert.ok(!html.includes(section), section);
  assert.match(html, /Category<input readOnly="" value="Assignments"/);
  for (const label of ["Title", "Date", "Start time", "Location", "Cancel", "Save changes"]) assert.ok(html.includes(label), label);
  assert.match(html, /class="delete-button" disabled/);
  assert.match(html, /Delete subtask/);
  assert.match(renderModal(child, () => {}), /class="delete-button"[^>]*>Delete subtask/);
});

test("canceled subtasks leave the parent's active form but remain in its unchanged edit command", () => {
  const parent = context(); parent.nodes[1].status = "canceled"; parent.nodes[1].title = "Canceled child";
  const html = renderModal(parent);
  assert.ok(!html.includes("Canceled child"));
  assert.match(html, /value="Task 4"/);
  assert.match(html, /Subtasks <span>1/);
  const command = editCommand(parent);
  assert.equal(command.draft.subtasks.length, 2);
  assert.equal(service.buildTaskWrite(command, parent).changed, false);
});

test("lifecycle confirmations show schedule fields, optional reason, and subtree impact", () => {
  const { LifecycleDialog } = load("components/dashboard/lifecycle-dialog.tsx", {
    "@/app/task-actions": { changeTaskLifecycle() { throw new Error("No write during render"); } },
    "@/lib/tasks/dates": dates,
    "./task-modal": { InstantChoice: () => null },
  });
  const render = mode => renderToStaticMarkup(React.createElement(LifecycleDialog, { editor: context(), mode, onSaved() {}, onClose() {} }));
  assert.match(render("postpone"), /New date/);
  assert.match(render("postpone"), /America\/Phoenix/);
  assert.match(render("cancel"), /Reason \(optional\)/);
  assert.match(render("cancel"), /does not cancel its subtasks/);
  assert.match(render("delete"), /also deletes 3 subtasks/);
  const mixed = context(); mixed.nodes[1].status = "canceled"; mixed.nodes[2].status = "canceled";
  assert.match(renderToStaticMarkup(React.createElement(LifecycleDialog, { editor: mixed, mode: "delete", onSaved() {}, onClose() {} })), /also deletes 3 subtasks \(1 active, 2 already canceled\)/);
  assert.match(render("delete"), /This cannot be undone here/);
});

test("subtask draft inherits the parent's category and excludes legacy nested children", () => {
  const editor = context(); editor.taskId = id(2); editor.nodes[1].categoryId = id(91);
  editor.categories.push({ ...category, id: id(91), name: "Old independent category" });
  const draft = editorTypes.initialDraft(editor, "2026-10-20");
  assert.equal(draft.categoryId, editor.nodes[0].categoryId);
  assert.equal(draft.subtasks.length, 0);
  const command = editCommand(editor);
  const write = service.buildTaskWrite(command, editor);
  assert.equal(write.args.p_edits[0].patch.category_id, category.id);
  assert.equal(write.args.p_edits[0].task_id, id(2));
  assert.ok(!JSON.stringify(write.args).includes(id(3))); // Legacy descendant is retained, not removed/reparented.
  assert.equal(write.args.p_delete_subtasks.length, 0);
});

test("subtasks cannot accept nested additions or independent owned categories through forged requests", () => {
  const editor = context(); editor.taskId = id(2);
  editor.categories.push({ ...category, id: id(91), name: "Other owned category" });
  const nested = editCommand(editor); nested.draft.subtasks.push(newSub());
  assert.throws(() => service.buildTaskWrite(validation.validateSaveCommand(nested), editor), /cannot contain nested/);
  const independent = editCommand(editor); independent.draft.categoryId = id(91);
  assert.throws(() => service.buildTaskWrite(validation.validateSaveCommand(independent), editor), /inherit/);
  const recursive = createCommand(); recursive.draft.subtasks.push({ ...newSub(), subtasks: [newSub()] });
  assert.throws(() => validation.validateSaveCommand(recursive), /protected task field/);
});

test("parent category changes synchronize all open direct subtasks in the same version-checked RPC", () => {
  const editor = context(); const other = { ...category, id: id(91), name: "Meetings" }; editor.categories.push(other);
  const command = editCommand(editor); command.draft.categoryId = other.id;
  const write = service.buildTaskWrite(validation.validateSaveCommand(command), editor);
  assert.equal(write.rpc, "edit_task_tree");
  assert.equal(write.args.p_expected_root_version, editor.rootVersion);
  assert.equal(write.args.p_edits.length, 3);
  assert.equal(write.args.p_edits.map(edit => edit.task_id).sort().join(","), [id(1), id(2), id(4)].join(","));
  for (const edit of write.args.p_edits) {
    assert.equal(edit.patch.category_id, other.id);
    assert.equal(Object.keys(edit.patch).join(","), "category_id");
    assert.equal(edit.task_version, 3); assert.equal(edit.occurrence_version, 2);
  }
  assert.equal(write.args.p_delete_subtasks.length, 0);
  assert.equal(write.args.p_new_subtasks.length, 0);
});

test("parent category changes leave canceled children and history untouched while updating active children", () => {
  const editor = context(); editor.nodes[1].status = "canceled";
  editor.categories.push({ ...category, id: id(91), name: "Meetings" });
  const command = editCommand(editor); command.draft.categoryId = id(91);
  const before = JSON.stringify(editor);
  const write = service.buildTaskWrite(validation.validateSaveCommand(command), editor);
  assert.deepEqual(Array.from(write.args.p_edits, edit => edit.task_id), [id(1), id(4)]);
  assert.ok(write.args.p_edits.every(edit => edit.patch.category_id === id(91)));
  assert.equal(write.args.p_delete_subtasks.length, 0);
  assert.equal(JSON.stringify(editor), before);
  const tampered = editCommand(editor); tampered.draft.categoryId = id(91); tampered.draft.subtasks[0].title = "Rewrite canceled";
  assert.throws(() => service.buildTaskWrite(tampered, editor), /cannot be edited/);
  editor.nodes[1].status = "completed";
  assert.throws(() => service.buildTaskWrite(command, editor), /historical categories/);
  // Existing title-only edits remain available if categories already match.
  command.draft.categoryId = category.id; command.draft.title = "Parent title only";
  assert.equal(service.buildTaskWrite(command, editor).args.p_edits.length, 1);
  const staleEditor = context(); staleEditor.taskId = id(2);
  const stale = editCommand(staleEditor); staleEditor.rootVersion++;
  assert.throws(() => service.buildTaskWrite(stale, staleEditor), error => error.code === "conflict");
});

test("subtask title/date/time/location changes use current parent category and preserve links and original slots", () => {
  const editor = context(); editor.taskId = id(2);
  const command = editCommand(editor);
  Object.assign(command.draft, { title: "Updated subtask", date: "2026-10-23", time: "09:15", endTime: "10:00", location: "Study room" });
  const write = service.buildTaskWrite(validation.validateSaveCommand(command), editor);
  assert.equal(write.args.p_edits.length, 1);
  const edit = write.args.p_edits[0];
  assert.equal(edit.task_id, id(2)); assert.equal(write.args.p_root_task_id, id(1));
  assert.equal(edit.patch.title, "Updated subtask"); assert.equal(edit.patch.location, "Study room");
  assert.equal(edit.patch.schedule.date, "2026-10-23"); assert.equal(edit.patch.schedule.starts_at, "2026-10-23T16:15:00Z");
  assert.ok(!Object.hasOwn(edit.patch, "parent_task_id")); assert.ok(!JSON.stringify(edit.patch).includes("original_"));
  assert.equal(write.args.p_new_subtasks.length, 0); assert.equal(write.args.p_delete_subtasks.length, 0);
});
