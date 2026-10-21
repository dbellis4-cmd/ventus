// Reads real disposable Supabase rows through the application projection.
// A two-row response cap exercises provider truncation without changing PostgREST.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";

const requireModule = createRequire(import.meta.url);
function load(file, mocks = {}) {
  const code = ts.transpileModule(readFileSync(new URL(`../../${file}`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(code, {
    module: mod, exports: mod.exports, Date, Intl,
    require(name) {
      if (Object.hasOwn(mocks, name)) return mocks[name];
      if (name === "server-only") return {};
      if (name.startsWith("@/") || name.startsWith("./")) throw new Error(`Unmocked import ${name}`);
      return requireModule(name);
    },
  }, { filename: file });
  return mod.exports;
}

const input = JSON.parse(readFileSync(0, "utf8"));
assert.match(input.base, /^http:\/\/127\.0\.0\.1:\d+$/);
const dates = load("lib/tasks/dates.ts");
const projections = load("lib/tasks/projections.ts", { "./dates": dates });
const reads = load("lib/server/workspace.ts", {
  "@/lib/supabase/server": { createClient: async () => client },
  "@/lib/tasks/projections": projections,
  "@/lib/tasks/dates": dates,
});
let cappedRequests = 0;
const client = requireModule("@supabase/supabase-js").createClient(input.base, input.key, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  global: {
    headers: { Authorization: `Bearer ${input.token}` },
    fetch: async (resource, init) => {
      const request = new Request(resource, init);
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname.startsWith("/rest/v1/") &&
          Number(url.searchParams.get("limit")) > 2) {
        url.searchParams.set("limit", "2");
        cappedRequests++;
        return fetch(new Request(url, request));
      }
      return fetch(request);
    },
  },
});

const fields = "id,task_id,recurrence_key,version,scheduled_date,timezone,start_time,starts_at,end_date,end_time,ends_at,original_date,original_start_time,original_timezone,status,completed_at,deleted_at,definition_snapshot";
const stored = await reads.readOwnedRows(client, "task_occurrences", fields, input.userId, false,
  { key: "recurrence_key", value: [input.keyDate] });
assert.equal(stored.length, input.storedIds.length);
assert.equal(new Set(stored.map((row) => row.task_id)).size, stored.length);
assert.equal(stored.map((row) => row.task_id).sort().join(), input.storedIds.sort().join());
const generated = await reads.readRecurrenceCandidates(client, input.userId, input.keyDate, input.keyDate);
assert.equal(generated.length, input.seriesIds.length - input.storedIds.length);
const all = [...stored, ...generated].map((row) => `${row.task_id}:${row.recurrence_key}`);
assert.equal(new Set(all).size, input.seriesIds.length);
assert.equal(new Set([...stored, ...generated].map((row) => row.task_id)).size, input.seriesIds.length);
assert.ok(cappedRequests >= 3, "real stored rows must cross the artificial provider cap");

const seen = new Set();
let cursor = { before: dates.addDays(dates.dateInZone(new Date(), "America/Phoenix"), -1), offset: 0 };
let emptyPages = 0;
for (let page = 0; page < 20 && cursor; page++) {
  const result = await reads.readMissedPage(client, input.userId, "America/Phoenix", cursor);
  if (!result.tasks.length && result.cursor) emptyPages++;
  for (const task of result.tasks) {
    assert.ok(input.pastIds.includes(task.id), "only expected unfinished tasks belong in the backlog");
    assert.ok(!seen.has(task.id), "backlog occurrence duplicated");
    seen.add(task.id);
  }
  cursor = result.cursor;
}
assert.equal(cursor, null, "sparse backlog must terminate");
assert.ok(emptyPages >= 2, "test must cross multiple empty eight-week scan blocks");
assert.equal([...seen].sort().join(), input.pastIds.sort().join());
console.log("PASS: real local Supabase exception pagination and sparse backlog, with two-row provider cap");
