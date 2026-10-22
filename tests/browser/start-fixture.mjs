import http from "node:http";
import { spawn } from "node:child_process";

const appPort = 3173;
const apiPort = 3174;
const user = { id: "11111111-1111-4111-8111-111111111111", aud: "authenticated", role: "authenticated", email: "fixture@ventus.test", app_metadata: {}, user_metadata: {}, created_at: "2026-10-20T00:00:00Z" };
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const tokenPart = value => Buffer.from(JSON.stringify(value)).toString("base64url");
const accessToken = `${tokenPart({ alg: "HS256", typ: "JWT" })}.${tokenPart({ sub: user.id, aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 })}.fixture`;
const categories = [
  { id: uuid(90), name: "Assignments", seed_key: "assignments", behavior: "deadline", calendar_default: true, archived_at: null },
  { id: uuid(91), name: "Meetings", seed_key: "meetings", behavior: "fixed", calendar_default: true, archived_at: null },
];
let tasks;
let occurrences;
let activity;
let revisions;
let candidateReads;
function reset() {
  tasks = [
    { id: uuid(1), parent_task_id: null, title: "Research Paper", category_id: uuid(90), location: null, calendar_opt_in: true, behavior_override: null, version: 3, deleted_at: null },
    { id: uuid(2), parent_task_id: uuid(1), title: "Active research", category_id: uuid(90), location: null, calendar_opt_in: false, behavior_override: null, version: 3, deleted_at: null },
    { id: uuid(3), parent_task_id: uuid(1), title: "Canceled research", category_id: uuid(90), location: null, calendar_opt_in: false, behavior_override: null, version: 4, deleted_at: null },
  ];
  occurrences = tasks.map((task, index) => ({
    id: uuid(index + 20), task_id: task.id, version: index === 2 ? 3 : 2,
    status: index === 2 ? "canceled" : "open", scheduled_date: "2026-10-22", timezone: "America/Phoenix",
    start_time: null, starts_at: null, end_date: null, end_time: null, ends_at: null,
    original_date: "2026-10-22", original_start_time: null, original_timezone: "America/Phoenix", completed_at: null, deleted_at: null,
    definition_snapshot: { title: task.title, category_id: task.category_id, category_name: "Assignments", behavior: "deadline" },
  }));
  activity = [];
  revisions = [];
  candidateReads = 0;
}
reset();

function send(res, status, value, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(value));
}
function error(res, status, code, message) { send(res, status, { code, message }); }
function authorized(req) { return req.headers.authorization === `Bearer ${accessToken}`; }
function rows(table) {
  return table === "user_settings" ? [{ user_id: user.id, timezone: "America/Phoenix", defaults_initialized_at: "2026-10-20T00:00:00Z" }]
    : table === "categories" ? categories : table === "tasks" ? tasks : table === "task_occurrences" ? occurrences
      : table === "task_recurrence_revisions" ? revisions : [];
}
const api = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${apiPort}`);
    if (url.pathname === "/__reset") { reset(); return send(res, 200, { ok: true }); }
    if (url.pathname === "/__sparse-backlog") {
      revisions = [{ id: uuid(50), task_id: tasks[0].id, owner_id: user.id,
        effective_from: "2021-01-01", stopped: false,
        definition_snapshot: { behavior: "deadline" }, child_templates: [] }];
      candidateReads = 0;
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/__state") return send(res, 200, { tasks, occurrences, activity, candidateReads });
    if (url.pathname === "/auth/v1/token" && req.method === "POST") return send(res, 200, { access_token: accessToken, refresh_token: "fixture-refresh", token_type: "bearer", expires_in: 3600, user });
    if (url.pathname === "/auth/v1/user") return authorized(req) ? send(res, 200, user) : error(res, 403, "session_not_found", "Fixture session unavailable");
    if (url.pathname === "/auth/v1/logout") return send(res, 200, {});
    if (!authorized(req)) return error(res, 401, "42501", "Fixture authorization required");
    if (url.pathname.startsWith("/rest/v1/") && req.method === "GET") {
      const table = url.pathname.split("/")[3];
      let data = rows(table).filter(row => {
        const deleted = url.searchParams.get("deleted_at");
        return deleted === "is.null" ? row.deleted_at === null : deleted === "not.is.null" ? !!row.deleted_at : true;
      });
      for (const key of ["id", "user_id", "owner_id"]) {
        const filter = url.searchParams.get(key);
        if (filter && key !== "owner_id") data = data.filter(row => row[key] === filter.slice(3));
      }
      const after = url.searchParams.get("id");
      if (after?.startsWith("gt.")) data = data.filter(row => row.id > after.slice(3));
      for (const range of url.searchParams.getAll("scheduled_date")) {
        if (range.startsWith("gte.")) data = data.filter(row => row.scheduled_date >= range.slice(4));
        if (range.startsWith("lte.")) data = data.filter(row => row.scheduled_date <= range.slice(4));
      }
      const completedSince = url.searchParams.get("completed_at")?.slice(4);
      if (completedSince) data = data.filter(row => row.completed_at >= completedSince);
      const status = url.searchParams.get("status")?.slice(3);
      if (status) data = data.filter(row => row.status === status);
      const recurrenceKeys = url.searchParams.get("recurrence_key");
      if (recurrenceKeys?.startsWith("in.")) {
        const keys = recurrenceKeys.slice(3).replace(/[()]/g, "").split(",");
        data = data.filter(row => keys.includes(row.recurrence_key ?? "once"));
      }
      if (url.searchParams.get("stopped") === "eq.true") data = data.filter(row => row.stopped);
      if (url.searchParams.get("stopped") === "eq.false") data = data.filter(row => !row.stopped);
      const behaviors = url.searchParams.get("definition_snapshot->>behavior");
      if (behaviors?.startsWith("in.")) {
        const values = behaviors.slice(3).replace(/[()]/g, "").split(",");
        data = data.filter(row => values.includes(row.definition_snapshot?.behavior));
      }
      const order = url.searchParams.get("order");
      if (order?.startsWith("scheduled_date.asc")) data.sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date));
      if (order?.startsWith("scheduled_date.desc")) data.sort((a, b) => b.scheduled_date.localeCompare(a.scheduled_date));
      if (order?.startsWith("effective_from.asc")) data.sort((a, b) => a.effective_from.localeCompare(b.effective_from));
      const limit = Number(url.searchParams.get("limit"));
      if (Number.isInteger(limit) && limit > 0) data = data.slice(0, limit);
      data = data.map(row => Object.fromEntries((url.searchParams.get("select") ?? "*").split(",").map(key => [key, row[key] ?? null])));
      return req.headers.accept?.includes("vnd.pgrst.object") ? send(res, data.length ? 200 : 406, data[0] ?? { code: "PGRST116", message: "No rows" }) : send(res, 200, data);
    }
    if (url.pathname === "/rest/v1/rpc/list_recurrence_candidates_page" && req.method === "POST") {
      candidateReads++;
      return send(res, 200, []);
    }
    if (url.pathname === "/rest/v1/rpc/edit_task_tree" && req.method === "POST") {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const root = tasks.find(task => task.id === body.p_root_task_id);
      if (!root || root.version !== body.p_expected_root_version) return error(res, 409, "40001", "Stale root");
      for (const edit of body.p_edits) {
        const task = tasks.find(item => item.id === edit.task_id);
        const occurrence = occurrences.find(item => item.task_id === edit.task_id);
        if (!task || !occurrence || occurrence.status !== "open" || task.version !== edit.task_version || occurrence.version !== edit.occurrence_version) return error(res, 409, "40001", "Stale target");
      }
      for (const edit of body.p_edits) {
        const task = tasks.find(item => item.id === edit.task_id);
        const occurrence = occurrences.find(item => item.task_id === edit.task_id);
        if (edit.patch.title) task.title = edit.patch.title;
        if (edit.patch.category_id) task.category_id = edit.patch.category_id;
        if (Object.hasOwn(edit.patch, "location")) task.location = edit.patch.location;
        if (Object.hasOwn(edit.patch, "calendar_opt_in")) task.calendar_opt_in = edit.patch.calendar_opt_in;
        if (edit.patch.schedule) occurrence.scheduled_date = edit.patch.schedule.date;
        occurrence.definition_snapshot = { ...occurrence.definition_snapshot, title: task.title, category_id: task.category_id,
          category_name: categories.find(category => category.id === task.category_id)?.name ?? "Unknown" };
        task.version++; occurrence.version++;
        activity.push({ task_id: task.id, kind: "edit" });
      }
      if (!body.p_edits.some(edit => edit.task_id === root.id)) root.version++;
      return send(res, 200, { task_id: root.id });
    }
    return error(res, 404, "PGRST404", `Unexpected fixture route: ${url.pathname}`);
  } catch (cause) { error(res, 500, "FIXTURE", String(cause)); }
});
api.listen(apiPort, "127.0.0.1");
const app = spawn("node", ["node_modules/next/dist/bin/next", "dev", "--webpack", "-p", String(appPort)], {
  stdio: "inherit", env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${apiPort}`,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_browser_fixture", SITE_URL: `http://127.0.0.1:${appPort}`, VENTUS_BROWSER_TEST: "1" },
});
function stop() { app.kill("SIGTERM"); api.close(); }
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
app.on("exit", code => { api.close(); process.exit(code ?? 0); });
