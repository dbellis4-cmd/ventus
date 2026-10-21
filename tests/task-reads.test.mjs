import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import { test } from "node:test";
import ts from "typescript";

const requireModule = createRequire(import.meta.url);
function load(file, mocks = {}, env = {}) {
  const code = ts.transpileModule(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(code, {
    module: mod, exports: mod.exports, FormData, URL, Date, Intl, process: { env },
    require(name) {
      if (Object.hasOwn(mocks, name)) return mocks[name];
      if (name === "server-only") return {};
      if (name.startsWith("@/") || name.startsWith("./")) throw new Error(`Unmocked import ${name}`);
      return requireModule(name);
    },
  }, { filename: file });
  return mod.exports;
}
const dates = load("lib/tasks/dates.ts");
const deployedOrigin = load("lib/auth/site-url.ts", {}, { NODE_ENV: "production", SITE_URL: "https://ventus.example.test" });
const localOrigin = load("lib/auth/site-url.ts", {}, { NODE_ENV: "development" });
const projections = load("lib/tasks/projections.ts", { "./dates": dates });
const now = new Date("2026-10-20T00:30:00Z"); // Monday afternoon in Phoenix.
const category = { id: "category-a", name: "Renamed category", seed_key: "assignments", behavior: "deadline", calendar_default: true, archived_at: null };
function fixture(id, values = {}) {
  return {
    task: { id, parent_task_id: null, title: `Definition ${id}`, deleted_at: null },
    occurrence: {
      id: `occ-${id}`, task_id: id, scheduled_date: "2026-10-19", timezone: "America/Phoenix", start_time: null, starts_at: null,
      original_date: "2026-10-19", original_start_time: null, original_timezone: "America/Phoenix",
      status: "open", completed_at: null, deleted_at: null,
      definition_snapshot: { title: `Task ${id}`, category_id: category.id, category_name: "Historical category", behavior: "fixed" },
      ...values,
    },
  };
}
function project(fixtures, selected, timezone = "America/Phoenix", instant = now) {
  return projections.projectWorkspace(timezone, selected, [category], fixtures.map((item) => item.task), fixtures.map((item) => item.occurrence), instant);
}
const behavior = (value) => ({ ...fixture("x").occurrence.definition_snapshot, behavior: value });

test("account-zone Today, leap dates, Sunday weeks, and navigation ignore the host/browser zone", () => {
  assert.equal(project([]).today, "2026-10-19");
  assert.equal(project([], undefined, "Asia/Tokyo").today, "2026-10-20");
  assert.equal(dates.startOfWeek("2026-10-19"), "2026-10-18");
  assert.equal(dates.addDays("2026-10-19", -7), "2026-10-12");
  assert.equal(dates.addDays("2026-10-19", 7), "2026-10-26");
  assert.equal(dates.addDays("2028-02-28", 1), "2028-02-29");
  for (const invalid of ["2026-02-29", "2026-13-01", "garbage", ["2026-10-19"], "0000-01-01"]) {
    assert.equal(dates.validDate(invalid), false);
    assert.equal(project([], invalid).selected, "2026-10-19");
  }
  assert.equal(project([], "2026-10-22").selected, "2026-10-22");
  assert.equal(dates.validTimezone("America/New_York"), true);
  assert.equal(dates.validTimezone("UTC"), true);
  for (const zone of ["EST", "not/a-zone", "posix/America/Phoenix", null]) assert.equal(dates.validTimezone(zone), false);
});

test("scheduled ordering, independent anytime tasks, snapshots and off-week parent labels survive projection", () => {
  const parent = fixture("parent", { scheduled_date: "2026-11-30" });
  const child = fixture("child", { start_time: "09:00:00", starts_at: "2026-10-19T16:00:00Z" });
  child.task.parent_task_id = "parent";
  const later = fixture("later", { start_time: "14:00:00", starts_at: "2026-10-19T21:00:00Z" });
  const result = project([later, child, parent, fixture("anytime")]);
  assert.equal(result.tasks.map((item) => item.id).join(","), "anytime,child,later");
  assert.equal(result.tasks.find((item) => item.id === "child").parentTitle, "Task parent");
  assert.equal(result.tasks[0].categoryName, "Historical category");
  assert.equal(result.tasks[0].categoryStyle, "assignments");
  assert.equal(result.tasks[0].time, "");
});

test("deadline cutoffs use current slots, retain original deadlines and exclude canceled/future/on-time-completed tasks", () => {
  const old = fixture("old", { scheduled_date: "2026-10-01", original_date: "2026-09-30", definition_snapshot: behavior("deadline") });
  const anytimeToday = fixture("anytime", { definition_snapshot: behavior("deadline") });
  const timed = fixture("timed", { start_time: "17:00", starts_at: "2026-10-20T00:00:00Z", definition_snapshot: behavior("deadline") });
  const future = fixture("future", { start_time: "18:00", starts_at: "2026-10-20T01:00:00Z", definition_snapshot: behavior("deadline") });
  const canceled = fixture("canceled", { scheduled_date: "2026-10-01", status: "canceled", definition_snapshot: behavior("deadline") });
  const completed = fixture("late", { scheduled_date: "2026-10-01", status: "completed", completed_at: now.toISOString(), definition_snapshot: behavior("deadline") });
  const onTime = fixture("on-time", { status: "completed", completed_at: "2026-10-19T18:00:00Z", start_time: "17:00", starts_at: "2026-10-20T00:00:00Z", definition_snapshot: behavior("deadline") });
  const result = project([old, anytimeToday, timed, future, canceled, completed, onTime]);
  assert.equal(result.tasks.filter((item) => item.overdue).map((item) => item.id).sort().join(","), "late,old,timed");
  assert.equal(result.tasks.some((item) => item.id === "canceled"), false);
  assert.equal(result.tasks.some((item) => item.id === "on-time"), true);
  assert.equal(result.tasks.find((item) => item.id === "old").originalDate, "2026-09-30");
  // Today's card includes the same backlog when another day of this week is selected.
  assert.ok(project([old], "2026-10-20").tasks.some((item) => item.overdue));
  assert.equal(project([old], "2026-11-01").tasks.length, 0);
});

test("anytime deadline cutoff uses the occurrence zone, including DST midnight boundaries", () => {
  const deadline = fixture("ny", { timezone: "America/New_York", scheduled_date: "2026-11-01", definition_snapshot: behavior("deadline") });
  assert.equal(project([deadline], "2026-11-01", "America/New_York", new Date("2026-11-02T04:59:59Z")).tasks[0].overdue, false);
  assert.equal(project([deadline], "2026-11-02", "America/New_York", new Date("2026-11-02T05:00:00Z")).tasks[0].overdue, true);
});

test("flexible rollover is duplicate-free, leaves stored data intact, and preserves completed display after refresh", () => {
  const flexible = fixture("flexible", { scheduled_date: "2026-10-01", definition_snapshot: behavior("flexible") });
  const fixed = fixture("fixed", { scheduled_date: "2026-10-01" });
  const completed = fixture("completed", { scheduled_date: "2026-10-01", status: "completed", completed_at: now.toISOString(), definition_snapshot: behavior("flexible") });
  const before = JSON.stringify([flexible, fixed, completed]);
  const first = project([flexible, fixed, completed]);
  assert.equal(first.tasks.length, 2);
  assert.ok(first.tasks.every((item) => item.date === first.today && item.scheduledDate === "2026-10-01"));
  assert.equal(first.tasks[0].originalDate, "2026-10-19");
  assert.equal(JSON.stringify([flexible, fixed, completed]), before);
  assert.equal(JSON.stringify(first), JSON.stringify(project([flexible, fixed, completed])));
  assert.equal(project([flexible], "2026-10-26").tasks.length, 0);
});

test("soft-deleted definitions/occurrences disappear and custom/archived category snapshots remain usable", () => {
  const deleted = fixture("deleted"); deleted.task.deleted_at = now.toISOString();
  const tombstone = fixture("tombstone", { deleted_at: now.toISOString() });
  const custom = fixture("custom", { definition_snapshot: { ...behavior("fixed"), category_id: "custom" } });
  const result = project([deleted, tombstone, custom]);
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].categoryStyle, "custom");
});

// Application-boundary simulation only: this does not execute PostgreSQL/RLS.
function provider(userId, { initialized = true, failure, authError = false, maxRows = 1 } = {}) {
  const queries = [];
  const records = [];
  for (const owner of ["user-a", "user-b"]) {
    const f = fixture(`${owner}-task`);
    records.push({ owner, f });
  }
  const tables = {
    user_settings: ["user-a", "user-b"].map((id) => ({ user_id: id, timezone: "America/Phoenix", defaults_initialized_at: initialized ? now.toISOString() : null })),
    categories: ["user-a", "user-b"].map((id) => ({ ...category, id: `${id}-category`, owner_id: id })),
    tasks: records.map(({ owner, f }) => ({ ...f.task, owner_id: owner })),
    task_occurrences: records.map(({ owner, f }) => ({ ...f.occurrence, owner_id: owner })),
    task_recurrence_revisions: [],
  };
  const client = {
    auth: { getUser: async () => ({ data: { user: userId ? { id: userId } : null }, error: authError ? { message: "PRIVATE" } : null }) },
    from(table) {
      const q = { table, eq: [], is: [], in: null, deletedOnly: false, after: null, from: null, to: null, completedSince: null, fields: "", order: null }; queries.push(q);
      const query = {
        select(fields) { q.fields = fields; return query; },
        eq(key, value) { q.eq.push([key, value]); return query; },
        gte(key, value) { if (key === "completed_at") q.completedSince = value; else q.from = value; return query; },
        lte(_key, value) { q.to = value; return query; },
        is(key, value) { q.is.push([key, value]); return query; },
        in(key, values) { q.in = [key, values]; return query; },
        not() { q.deletedOnly = true; return query; },
        order(key, options) { q.order = [key, options?.ascending !== false]; return query; }, limit() { return query; },
        gt(_key, value) { q.after = value; return query; },
        maybeSingle() { return query.then((result) => ({ ...result, data: result.data?.[0] ?? null })); },
        then(resolve, reject) {
          if (failure === table) return Promise.resolve({ data: null, error: { message: "PRIVATE DATABASE DETAIL" } }).then(resolve, reject);
          const data = tables[table].filter((row) => (row.owner_id ?? row.user_id) === userId && q.eq.every(([key, value]) => row[key] === value) && q.is.every(([key, value]) => row[key] === value) && (!q.in || q.in[1].includes(q.in[0] === "definition_snapshot->>behavior" ? row.definition_snapshot?.behavior : row[q.in[0]] ?? "once")) && (!q.deletedOnly || row.deleted_at) && (!q.after || row.id > q.after) && (!q.from || row.scheduled_date >= q.from) && (!q.to || row.scheduled_date <= q.to) && (!q.completedSince || row.completed_at >= q.completedSince));
          if (q.order) data.sort((a, b) => String(a[q.order[0]]).localeCompare(String(b[q.order[0]])) * (q.order[1] ? 1 : -1));
          return Promise.resolve({ data: data.slice(0, maxRows), error: null }).then(resolve, reject);
        },
      };
      return query;
    },
    rpc(name) { assert.equal(name, "list_recurrence_candidates_page"); return Promise.resolve({ data: [], error: null }); },
  };
  return { client, queries, tables };
}
function reader(client) {
  return load("lib/server/workspace.ts", { "@/lib/supabase/server": { createClient: async () => client }, "@/lib/tasks/projections": projections, "@/lib/tasks/dates": dates });
}

test("anonymous, revoked and mismatched users are denied before any table read", async () => {
  for (const [identity, authError, expected] of [[null, false, "user-a"], ["user-a", true, "user-a"], ["user-b", false, "user-a"]]) {
    const p = provider(identity, { authError });
    assert.equal((await reader(p.client).loadWorkspace(expected)).kind, "signed-out");
    assert.equal(p.queries.length, 0);
  }
});

test("owned reads, short-page pagination, repeated refresh and two-user filtering (mock provider)", async () => {
  for (const userId of ["user-a", "user-b"]) {
    const p = provider(userId);
    // A second task forces traversal beyond a short provider page.
    const extra = fixture(`${userId}-zz`);
    p.tables.tasks.push({ ...extra.task, owner_id: userId });
    p.tables.task_occurrences.push({ ...extra.occurrence, owner_id: userId });
    const read = reader(p.client);
    const result = await read.loadWorkspace(userId, "2026-10-19");
    assert.equal(result.kind, "ready");
    assert.equal(result.tasks.length, 2);
    assert.ok(result.tasks.every((task) => task.id.startsWith(userId)));
    assert.equal(JSON.stringify(result), JSON.stringify(await read.loadWorkspace(userId, "2026-10-19")));
    for (const q of p.queries) {
      assert.equal(q.eq[0][1], userId);
      assert.ok(!q.fields.includes("*"));
      if (q.table === "tasks" || q.table === "task_occurrences" && !q.deletedOnly && !q.in) assert.equal(q.is[0][0], "deleted_at");
    }
    assert.ok(!JSON.stringify(result).includes("owner_id"));
  }
});

test("real Supabase SDK sends owned SELECTs and handles short pages (mock Data API HTTP)", async () => {
  const { createClient } = requireModule("@supabase/supabase-js");
  for (const identity of ["user-a", "user-b"]) {
    const p = provider(identity);
    const extra = fixture(`${identity}-zz`);
    p.tables.tasks.push({ ...extra.task, owner_id: identity });
    p.tables.task_occurrences.push({ ...extra.occurrence, owner_id: identity });
    let requests = 0;
    const client = createClient("https://fixture.example.test", "sb_publishable_test_fixture", {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      global: { fetch: async (input, options) => {
        requests++;
        const url = new URL(input);
        assert.equal(url.origin, "https://fixture.example.test");
        if (url.pathname.includes("/rpc/list_recurrence_candidates")) {
          assert.equal(options.method, "POST");
          return Response.json([]);
        }
        assert.equal(options.method, "GET");
        const table = url.pathname.split("/").at(-1);
        const ownerKey = table === "user_settings" ? "user_id" : "owner_id";
        assert.equal(url.searchParams.get(ownerKey), `eq.${identity}`);
        assert.ok(!url.searchParams.get("select").includes("*"));
        const after = url.searchParams.get("id")?.slice(3);
        const fields = url.searchParams.get("select").split(",");
        const range = url.searchParams.getAll("scheduled_date");
        const from = range.find((part) => part.startsWith("gte."))?.slice(4);
        const to = range.find((part) => part.startsWith("lte."))?.slice(4);
        const deletedOnly = url.searchParams.get("deleted_at") === "not.is.null";
        const completedSince = url.searchParams.get("completed_at")?.slice(4);
        const status = url.searchParams.get("status")?.slice(3);
        const data = p.tables[table].filter((row) => row[ownerKey] === identity && (!after || row.id > after) && (!from || row.scheduled_date >= from) && (!to || row.scheduled_date <= to) && (!deletedOnly || row.deleted_at) && (!completedSince || row.completed_at >= completedSince) && (!status || row.status === status)).slice(0, 1).map((row) => Object.fromEntries(fields.map((field) => [field, row[field]])));
        // PostgREST singular reads permit object or array transport across SDK versions.
        return Response.json(data);
      } },
    });
    client.auth.getUser = p.client.auth.getUser;
    const result = await reader(client).loadWorkspace(identity, "2026-10-19");
    assert.equal(result.kind, "ready");
    assert.equal(result.tasks.length, 2);
    assert.ok(result.tasks.every((task) => task.id.startsWith(identity)));
    assert.ok(requests >= 8);
  }
});

test("missing initialization shows setup without creating rows; read failures never become empty success or sample data", async () => {
  const fresh = provider("user-a", { initialized: false });
  assert.equal((await reader(fresh.client).loadWorkspace("user-a")).kind, "setup");
  assert.equal(fresh.queries.length, 1);
  for (const table of ["user_settings", "categories", "tasks", "task_occurrences"]) {
    assert.equal(JSON.stringify(await reader(provider("user-a", { failure: table }).client).loadWorkspace("user-a")), '{"kind":"error"}');
  }
});

test("bounded week reads still show an old flexible task completed today", async () => {
  const p = provider("user-a", { maxRows: 2 });
  const completed = fixture("user-a-completed", { scheduled_date: "2025-01-01", status: "completed",
    completed_at: new Date().toISOString(), definition_snapshot: behavior("flexible") });
  p.tables.tasks.push({ ...completed.task, owner_id: "user-a" });
  p.tables.task_occurrences.push({ ...completed.occurrence, owner_id: "user-a" });
  const workspace = await reader(p.client).loadWorkspace("user-a");
  assert.equal(workspace.kind, "ready");
  assert.ok(workspace.tasks.some((task) => task.id === "user-a-completed"));
});

test("missed recurrence pages cap results at 50 and keep a stable continuation offset", async () => {
  const before = dates.addDays(dates.dateInZone(new Date(), "America/Phoenix"), -1);
  const p = provider("user-a", { maxRows: 100 });
  p.tables.task_recurrence_revisions.push({ id: "rule", owner_id: "user-a",
    effective_from: before, stopped: false, definition_snapshot: behavior("deadline"), child_templates: [] });
  const candidates = Array.from({ length: 60 }, (_, index) => {
    const taskId = `recurring-${String(index).padStart(3, "0")}`;
    p.tables.tasks.push({ id: taskId, owner_id: "user-a", parent_task_id: null,
      title: taskId, version: 1, recurrence_enabled: true, deleted_at: null });
    return { task_id: taskId, recurrence_key: before, scheduled_date: before,
      timezone: "America/Phoenix", start_time: null, starts_at: null,
      end_date: null, end_time: null, ends_at: null,
      definition_snapshot: { title: taskId, category_id: category.id,
        category_name: category.name, behavior: "deadline" } };
  });
  p.client.rpc = async (name) => {
    assert.equal(name, "list_recurrence_candidates_page");
    return { data: candidates, error: null };
  };
  const read = reader(p.client);
  const first = await read.readMissedPage(p.client, "user-a", "America/Phoenix", { before, offset: 0 });
  assert.equal(first.tasks.length, 50);
  assert.equal(first.cursor.offset, 50);
  const second = await read.readMissedPage(p.client, "user-a", "America/Phoenix", first.cursor);
  assert.equal(second.tasks.length, 10);
  assert.equal(new Set([...first.tasks, ...second.tasks].map((task) => task.id)).size, 60);
});

test("recurrence pages and stored exceptions remain complete below a low provider row limit", async () => {
  const key = dates.addDays(dates.dateInZone(new Date(), "America/Phoenix"), -1);
  const p = provider("user-a", { maxRows: 2 });
  const candidates = Array.from({ length: 125 }, (_, index) => {
    const taskId = `series-${String(index).padStart(3, "0")}`;
    if (index < 75) {
      const stored = fixture(taskId, { id: `stored-${String(index).padStart(3, "0")}`,
        recurrence_key: key, scheduled_date: dates.addDays(key, 8) });
      p.tables.task_occurrences.push({ ...stored.occurrence, owner_id: "user-a" });
    }
    return { task_id: taskId, recurrence_key: key, scheduled_date: key,
      timezone: "America/Phoenix", start_time: null, starts_at: null,
      end_date: null, end_time: null, ends_at: null,
      definition_snapshot: { title: taskId, category_id: category.id,
        category_name: category.name, behavior: "deadline" } };
  });
  let pages = 0;
  p.client.rpc = async (name, args) => {
    assert.equal(name, "list_recurrence_candidates_page");
    pages++;
    const rows = candidates.filter((row) => !args.p_after_task_id ||
      row.task_id > args.p_after_task_id || row.task_id === args.p_after_task_id && row.recurrence_key > args.p_after_key);
    return { data: rows.slice(0, 100), error: null };
  };
  const generated = await reader(p.client).readRecurrenceCandidates(p.client, "user-a", key, key);
  assert.equal(pages, 2);
  assert.equal(generated.length, 50);
  assert.equal(new Set(generated.map((row) => `${row.task_id}:${row.recurrence_key}`)).size, 50);
  assert.ok(generated.every((row) => row.task_id >= "series-075"));
  assert.ok(p.queries.filter((query) => query.table === "task_occurrences" && query.in).length > 2);
});

test("sparse missed history jumps across years and terminates after the last unfinished task", async () => {
  const today = dates.dateInZone(new Date(), "America/Phoenix");
  const oldDay = dates.addDays(today, -365 * 5);
  const newerDay = dates.addDays(today, -365 * 2);
  const p = provider("user-a", { maxRows: 2 });
  const old = fixture("old-deadline", { scheduled_date: oldDay,
    definition_snapshot: { ...behavior("deadline"), title: "Old deadline" } });
  const newer = fixture("newer-deadline", { scheduled_date: newerDay,
    definition_snapshot: behavior("deadline") });
  p.tables.tasks.push({ ...old.task, owner_id: "user-a" }, { ...newer.task, owner_id: "user-a" });
  p.tables.task_occurrences.push({ ...old.occurrence, owner_id: "user-a" }, { ...newer.occurrence, owner_id: "user-a" });
  const read = reader(p.client);
  const result = await read.readMissedPage(p.client, "user-a", "America/Phoenix",
    { before: dates.addDays(today, -1), offset: 0 });
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].id, "newer-deadline");
  assert.ok(result.cursor);
  const second = await read.readMissedPage(p.client, "user-a", "America/Phoenix", result.cursor);
  assert.equal(second.tasks.map((task) => task.id).join(), "old-deadline");
  assert.equal(second.cursor, null);
  assert.equal(new Set(p.queries.filter((query) => query.table === "task_occurrences" && query.from)
    .map((query) => query.from)).size, 2);
});

test("years-old completed and fixed tasks do not offer backlog pagination", async () => {
  const today = dates.dateInZone(new Date(), "America/Phoenix");
  const p = provider("user-a", { maxRows: 2 });
  const completed = fixture("completed", { scheduled_date: dates.addDays(today, -365 * 6),
    status: "completed", completed_at: "2020-01-01T00:00:00Z", definition_snapshot: behavior("deadline") });
  p.tables.tasks.push({ ...completed.task, owner_id: "user-a" });
  p.tables.task_occurrences.push({ ...completed.occurrence, owner_id: "user-a" });
  const result = await reader(p.client).readMissedPage(p.client, "user-a", "America/Phoenix",
    { before: dates.addDays(today, -1), offset: 0 });
  assert.equal(result.tasks.length, 0);
  assert.equal(result.cursor, null);
  assert.equal(p.queries.filter((query) => query.table === "task_occurrences" && query.from).length, 0);
});

test("a stopped series keeps its missed virtual occurrence reachable across sparse pages", async () => {
  const today = dates.dateInZone(new Date(), "America/Phoenix");
  const missed = dates.addDays(today, -120);
  const stop = dates.addDays(today, -60);
  const p = provider("user-a", { maxRows: 2 });
  p.tables.tasks.push({ id: "series", owner_id: "user-a", parent_task_id: null,
    title: "Series", version: 2, recurrence_enabled: true, deleted_at: null });
  p.tables.task_recurrence_revisions.push(
    { id: "rule", task_id: "series", owner_id: "user-a", effective_from: missed,
      stopped: false, definition_snapshot: behavior("deadline"), child_templates: [] },
    { id: "stop", task_id: "series", owner_id: "user-a", effective_from: stop,
      stopped: true, definition_snapshot: behavior("deadline") },
  );
  let rpcCalls = 0;
  p.client.rpc = async (_name, args) => {
    rpcCalls++;
    return { data: args.p_from <= missed && missed <= args.p_to ? [{
      task_id: "series", recurrence_key: missed, scheduled_date: missed,
      timezone: "America/Phoenix", start_time: null, starts_at: null,
      end_date: null, end_time: null, ends_at: null,
      definition_snapshot: behavior("deadline"),
    }] : [], error: null };
  };
  const read = reader(p.client);
  let cursor = { before: dates.addDays(today, -1), offset: 0 };
  const seen = [];
  for (let request = 0; request < 4 && cursor; request++) {
    const calls = rpcCalls;
    const result = await read.readMissedPage(p.client, "user-a", "America/Phoenix", cursor);
    assert.ok(rpcCalls - calls <= 8, "one request scans at most eight weeks");
    seen.push(...result.tasks.map((task) => `${task.id}:${task.recurrenceKey}`));
    cursor = result.cursor;
  }
  assert.equal(seen.join(), `series:${missed}`);
  assert.equal(cursor, null);
});

test("a fixed recurring parent does not hide an overdue virtual child", async () => {
  const today = dates.dateInZone(new Date(), "America/Phoenix");
  const missed = dates.addDays(today, -10);
  const parentStart = dates.addDays(today, -3);
  const p = provider("user-a", { maxRows: 2 });
  p.tables.tasks.push(
    { id: "fixed-series", owner_id: "user-a", parent_task_id: null,
      title: "Fixed parent", version: 1, recurrence_enabled: true, deleted_at: null },
    { id: "deadline-child", owner_id: "user-a", parent_task_id: "fixed-series",
      title: "Deadline child", version: 1, recurrence_enabled: true, deleted_at: null },
  );
  p.tables.task_recurrence_revisions.push({ id: "fixed-rule", task_id: "fixed-series",
    owner_id: "user-a", effective_from: parentStart, stopped: false,
    definition_snapshot: behavior("fixed"), child_templates: [{ day_offset: -7, snapshot: behavior("deadline") }] });
  p.client.rpc = async (_name, args) => ({ data: args.p_from <= missed && missed <= args.p_to ? [{
    task_id: "deadline-child", recurrence_key: missed, scheduled_date: missed,
    timezone: "America/Phoenix", start_time: null, starts_at: null,
    end_date: null, end_time: null, ends_at: null,
    definition_snapshot: behavior("deadline"),
  }] : [], error: null });
  const result = await reader(p.client).readMissedPage(p.client, "user-a", "America/Phoenix",
    { before: dates.addDays(today, -1), offset: 0 });
  assert.equal(result.tasks.map((task) => task.id).join(), "deadline-child");
  assert.equal(result.cursor, null);
});

test("stopping a series hides postponed open exceptions while retaining closed history", async () => {
  const p = provider("user-a", { maxRows: 10 });
  const root = "stopped-series";
  p.tables.tasks.push({ id: root, owner_id: "user-a", parent_task_id: null,
    title: "Stopped", version: 4, recurrence_enabled: true, deleted_at: null });
  const open = fixture(root, { id: "open-instance", recurrence_key: "2026-10-21",
    scheduled_date: "2026-10-23", status: "open" }).occurrence;
  const closed = fixture(root, { id: "closed-instance", recurrence_key: "2026-10-20",
    scheduled_date: "2026-10-23", status: "completed", completed_at: now.toISOString() }).occurrence;
  p.tables.task_occurrences.push({ ...open, owner_id: "user-a" }, { ...closed, owner_id: "user-a" });
  p.tables.task_recurrence_revisions.push({ id: "stop", task_id: root, owner_id: "user-a",
    effective_from: "2026-10-22", stopped: true });
  const result = await reader(p.client).loadWorkspace("user-a", "2026-10-23");
  assert.equal(result.kind, "ready");
  assert.equal(result.tasks.filter((task) => task.id === root).length, 1);
  assert.equal(result.tasks.find((task) => task.id === root).status, "completed");
});

test("deleting a recurring parent occurrence hides its open stored child exception", async () => {
  const p = provider("user-a", { maxRows: 10 });
  const root = "deleted-parent";
  const child = "stored-child";
  p.tables.tasks.push(
    { id: root, owner_id: "user-a", parent_task_id: null, title: "Parent", version: 2,
      recurrence_enabled: true, deleted_at: null },
    { id: child, owner_id: "user-a", parent_task_id: root, title: "Child", version: 1,
      recurrence_enabled: true, deleted_at: null },
  );
  const deleted = fixture(root, { id: "parent-tombstone", recurrence_key: "2026-10-20",
    scheduled_date: "2026-10-25", deleted_at: now.toISOString() }).occurrence;
  const active = fixture(child, { id: "child-exception", recurrence_key: "2026-10-20",
    scheduled_date: "2026-10-22" }).occurrence;
  p.tables.task_occurrences.push({ ...deleted, owner_id: "user-a" }, { ...active, owner_id: "user-a" });
  const result = await reader(p.client).loadWorkspace("user-a", "2026-10-22");
  assert.equal(result.kind, "ready");
  assert.equal(result.tasks.some((task) => task.id === child), false);
});

function setupAction({ identity = "user-a", origin = "https://ventus.example.test", host = "ventus.example.test", originCheck = deployedOrigin, fail = false } = {}) {
  const calls = [];
  const action = load("app/workspace-actions.ts", {
    "next/headers": { headers: async () => new Headers({ origin, host }) },
    "next/cache": { revalidatePath: (path) => calls.push(["refresh", path]) },
    "@/lib/auth/site-url": originCheck,
    "@/lib/tasks/dates": dates,
    "@/lib/supabase/server": { createClient: async () => ({
      auth: { getUser: async () => ({ data: { user: identity ? { id: identity } : null }, error: null }) },
      rpc: async (name, args) => { calls.push([name, args]); return { error: fail ? { message: "PRIVATE" } : null }; },
    }) },
  });
  return { ...action, calls };
}
function form(values = { timezone: "America/Phoenix" }) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

test("initialization accepts a valid timezone without a checkbox, but requires verified identity and same origin", async () => {
  for (const data of [form({}), form({ timezone: "Invalid/Zone" }), {}]) {
    const action = setupAction();
    assert.ok((await action.confirmTimezone({}, data)).error);
    assert.equal(action.calls.length, 0);
  }
  for (const options of [{ identity: null }, { origin: "https://attacker.test" }]) {
    const action = setupAction(options);
    assert.ok((await action.confirmTimezone({}, form())).error);
    assert.equal(action.calls.length, 0);
  }
  const success = setupAction();
  assert.equal((await success.confirmTimezone({}, form())).success, true);
  assert.equal(success.calls[0][0], "initialize_workspace");
  assert.equal(success.calls[0][1].p_timezone, "America/Phoenix");
  assert.equal(success.calls.length, 2);
  const failure = setupAction({ fail: true });
  assert.ok((await failure.confirmTimezone({}, form())).error);
  assert.equal(failure.calls.length, 1);
});

test("initialization accepts the matching 127.0.0.1 development origin and rejects a mismatched host", async () => {
  const local = setupAction({ origin: "http://127.0.0.1:3000", host: "127.0.0.1:3000", originCheck: localOrigin });
  assert.equal((await local.confirmTimezone({}, form())).success, true);
  assert.equal(local.calls[0][0], "initialize_workspace");
  const mismatch = setupAction({ origin: "http://127.0.0.1:3000", host: "localhost:3000", originCheck: localOrigin });
  assert.match((await mismatch.confirmTimezone({}, form())).error, /Invalid request origin/);
  assert.equal(mismatch.calls.length, 0);
});

const React = requireModule("react");
const { renderToStaticMarkup } = requireModule("react-dom/server");
function render(workspace) {
  const { Dashboard } = load("components/dashboard/dashboard.tsx", {
    "next/navigation": { useRouter: () => ({ push() {}, refresh() {} }) },
    "@/lib/tasks/dates": dates,
    "./icon": { Icon: () => null },
    "./timezone-setup": { TimezoneSetup: () => React.createElement("p", null, "Confirm timezone") },
    "./task-modal": { TaskModal: () => null },
    "./lifecycle-dialog": { LifecycleDialog: () => null },
    "@/app/task-actions": { getTaskEditor: async () => { throw new Error("No editor read during render"); }, changeTaskLifecycle: async () => { throw new Error("No write during render"); } },
    "@/components/auth/logout-button": { LogoutButton: () => null },
  });
  return renderToStaticMarkup(React.createElement(Dashboard, { workspace }));
}

function section(text, id) {
  const start = text.indexOf(`id="${id}-heading"`);
  assert.ok(start >= 0, `${id} section exists`);
  return text.slice(start, text.indexOf("</section>", start));
}

test("rendered Dashboard preserves empty/error/setup states and enables lifecycle controls", () => {
  const empty = render(project([]));
  assert.match(empty, /No scheduled tasks for this day/);
  assert.match(empty, /No anytime tasks for this day/);
  assert.match(empty, /Sunday, October 18/);
  assert.match(empty, /Saturday, October 24/);
  assert.ok(!empty.includes("Sample data"));
  assert.match(render({ kind: "error" }), /Unable to load your workspace/);
  assert.ok(!render({ kind: "error" }).includes("No scheduled tasks"));
  assert.match(render({ kind: "setup" }), /Confirm timezone/);
  const text = render(project([fixture("visible")]));
  for (const label of ["Postpone", "Cancel task", "Delete"]) assert.ok(new RegExp(`<button(?![^>]*disabled)[^>]*>${label}</button>`).test(text), label);
  for (const label of ["Add task", "Add another task", "Task visible"]) assert.ok(new RegExp(`<button(?![^>]*disabled)[^>]*>${label}</button>`).test(text), label);
  assert.match(text, /type="checkbox"(?![^>]*disabled)/);
});

test("overdue tasks render once on Today with original date, parents and escaped user content", () => {
  const parent = fixture("parent", { scheduled_date: "2026-12-01" });
  const child = fixture("child", { scheduled_date: "2026-10-01", original_date: "2026-09-30", definition_snapshot: { ...behavior("deadline"), title: '<img src=x onerror="alert(1)">' } });
  child.task.parent_task_id = "parent";
  const text = render(project([parent, child]));
  assert.match(text, /class="overdue-panel"/);
  assert.match(text, /Sep 30/);
  assert.match(text, /Subtask of Task parent/);
  assert.ok(!text.includes("<img"));
  assert.match(text, /&lt;img/);
  assert.equal((text.match(/class="task-row open"/g) ?? []).length, 1);
});

test("an overdue subtask remains visible when its same-date parent is not in Today's sections", () => {
  const parent = fixture("parent", { scheduled_date: "2026-10-18" });
  const child = fixture("child", { scheduled_date: "2026-10-18", definition_snapshot: { ...behavior("deadline"), title: "Task child" } });
  child.task.parent_task_id = "parent";
  const text = render(project([parent, child]));
  assert.match(text, /class="overdue-panel"/);
  assert.match(text, /Task child<\/button>/);
  assert.match(text, /Subtask of Task parent/);
  assert.ok(!text.includes("Task parent</button>"));
  assert.equal((text.match(/title="Edit task">Task child<\/button>/g) ?? []).length, 1);
});

test("an overdue parent brings its same-date child into the same section and day count", () => {
  const parent = fixture("parent", { scheduled_date: "2026-10-18",
    definition_snapshot: { ...behavior("deadline"), title: "Task parent" } });
  const child = fixture("child", { scheduled_date: "2026-10-18" });
  child.task.parent_task_id = "parent";
  const text = render(project([child, parent]));
  const overdue = text.slice(text.indexOf('class="overdue-list"'), text.indexOf("</ul>", text.indexOf('class="overdue-list"')));
  assert.ok(overdue.indexOf("Task parent</button>") < overdue.indexOf("Task child</button>"));
  assert.match(text, /Monday, October 19, 2 tasks, today/);
  assert.equal((text.match(/title="Edit task">Task child<\/button>/g) ?? []).length, 1);
});

test("day/week selections produce the appropriate task sections and chronological rows", () => {
  const morning = fixture("morning", { start_time: "08:00", starts_at: "2026-10-19T15:00:00Z" });
  const afternoon = fixture("afternoon", { start_time: "14:00", starts_at: "2026-10-19T21:00:00Z" });
  const tomorrow = fixture("tomorrow", { scheduled_date: "2026-10-20" });
  const nextWeek = fixture("next-week", { scheduled_date: "2026-10-26" });
  const fixtures = [afternoon, morning, tomorrow, nextWeek];
  const today = render(project(fixtures));
  assert.ok(today.indexOf('title="Edit task">Task morning') < today.indexOf('title="Edit task">Task afternoon'));
  assert.ok(!today.includes(">Task tomorrow</button>"));
  const next = render(project(fixtures, "2026-10-20"));
  assert.match(next, />Task tomorrow<\/button>/);
  assert.ok(!next.includes(">Task morning</button>"));
  const week = render(project(fixtures, "2026-10-26"));
  assert.match(week, />Task next-week<\/button>/);
  assert.match(week, /Sunday, October 25/);
});

test("Dashboard keeps chronological parent groups with indented subtasks directly below their parent", () => {
  const early = fixture("early", { start_time: "08:00", starts_at: "2026-10-19T15:00:00Z" });
  const parent = fixture("parent", { start_time: "09:00", starts_at: "2026-10-19T16:00:00Z" });
  const child = fixture("child", { start_time: "09:00", starts_at: "2026-10-19T16:00:00Z" });
  child.task.parent_task_id = "parent";
  const other = fixture("other", { start_time: "10:00", starts_at: "2026-10-19T17:00:00Z" });
  const text = render(project([child, other, parent, early]));
  const titles = [...text.matchAll(/title="Edit task">Task (early|parent|child|other)<\/button>/g)].map((match) => match[1]);
  assert.deepEqual(titles, ["early", "parent", "child", "other"]);
  assert.match(text, /class="task-row open" data-subtask=""[^>]*>[\s\S]*?Task child/);
  assert.equal((text.match(/data-subtask=""/g) ?? []).length, 1);
  assert.match(text, /Subtask of Task parent/);
  assert.equal((text.match(/type="checkbox"/g) ?? []).length, 4);
});

test("untimed subtasks follow a timed parent's Scheduled section without losing their own time", () => {
  const parent = fixture("parent", { start_time: "06:00", starts_at: "2026-10-19T13:00:00Z" });
  const child = fixture("child");
  child.task.parent_task_id = "parent";
  const later = fixture("later", { start_time: "07:00", starts_at: "2026-10-19T14:00:00Z" });
  const workspace = project([child, later, fixture("independent"), parent]);
  workspace.backlog = [workspace.tasks.find((task) => task.id === "child")];
  const text = render(workspace);
  const scheduled = section(text, "scheduled");
  const anytime = section(text, "anytime");
  assert.deepEqual([...scheduled.matchAll(/title="Edit task">Task (parent|child|later)<\/button>/g)].map((match) => match[1]),
    ["parent", "child", "later"]);
  assert.match(scheduled, /data-subtask=""[^>]*>[\s\S]*?class="anytime-dash"[^>]*>—[\s\S]*?Task child/);
  assert.deepEqual([...anytime.matchAll(/title="Edit task">Task ([^<]+)<\/button>/g)].map((match) => match[1]), ["independent"]);
  assert.equal((text.match(/title="Edit task">Task child<\/button>/g) ?? []).length, 1);
});

test("Dashboard groups recurring children with their matching parent occurrence", () => {
  const parent = (key, label, time) => {
    const item = fixture("parent", { id: `parent-${key}`, recurrence_key: key, start_time: time,
      definition_snapshot: { ...behavior("fixed"), title: `Parent ${label}` } });
    item.task.recurrence_enabled = true;
    return item;
  };
  const child = (key, label) => {
    const item = fixture("child", { id: `child-${key}`, recurrence_key: key,
      definition_snapshot: { ...behavior("fixed"), title: `Child ${label}` } });
    item.task.parent_task_id = "parent";
    item.task.recurrence_enabled = true;
    return item;
  };
  const text = render(project([child("2026-10-18", "first"), parent("2026-10-18", "first", "06:00"),
    child("2026-10-19", "second"), parent("2026-10-19", "second", "07:00")]));
  const titles = [...section(text, "scheduled").matchAll(/title="Edit task">(Parent|Child) (first|second)<\/button>/g)]
    .map((match) => `${match[1]} ${match[2]}`);
  assert.deepEqual(titles, ["Parent first", "Child first", "Parent second", "Child second"]);
  assert.ok(!section(text, "anytime").includes("Child first"));
  assert.equal((text.match(/title="Edit task">Child (first|second)<\/button>/g) ?? []).length, 2);
});

test("cross-date subtasks stay on their own date and section with a parent reference", () => {
  const parent = fixture("parent", { start_time: "06:00", starts_at: "2026-10-19T13:00:00Z" });
  const untimed = fixture("untimed", { scheduled_date: "2026-10-20" });
  untimed.task.parent_task_id = "parent";
  const timed = fixture("timed", { scheduled_date: "2026-10-20", start_time: "08:00", starts_at: "2026-10-20T15:00:00Z" });
  timed.task.parent_task_id = "parent";
  const fixtures = [untimed, parent, timed];
  const firstDay = render(project(fixtures));
  assert.match(section(firstDay, "scheduled"), /Task parent<\/button>/);
  assert.ok(!firstDay.includes("Task untimed</button>"));
  assert.ok(!firstDay.includes("Task timed</button>"));
  const nextDay = render(project(fixtures, "2026-10-20"));
  assert.match(section(nextDay, "scheduled"), /Task timed<\/button>/);
  assert.match(section(nextDay, "anytime"), /Task untimed<\/button>/);
  assert.ok(!nextDay.includes("Task parent</button>"));
  assert.equal((nextDay.match(/Subtask of Task parent/g) ?? []).length, 2);
  assert.equal((nextDay.match(/title="Edit task">Task (untimed|timed)<\/button>/g) ?? []).length, 2);
});
