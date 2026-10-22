import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import { test } from "node:test";
import ts from "typescript";

const requireModule = createRequire(import.meta.url);
function load(file, mocks = {}, env = {}) {
  const code = ts.transpileModule(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(code, { module: mod, exports: mod.exports, Buffer, Date, Intl, URL, URLSearchParams,
    process: { env }, require(name) {
      if (Object.hasOwn(mocks, name)) return mocks[name];
      if (name === "server-only") return {};
      if (name.startsWith("@/") || name.startsWith("./")) throw new Error(`Unmocked import ${name}`);
      return requireModule(name);
    },
  }, { filename: file });
  return mod.exports;
}
const dates = load("lib/tasks/dates.ts");
const editor = load("lib/tasks/editor.ts");
const schedules = load("lib/tasks/schedules.ts", { "./dates": dates, "./editor": editor });
const mapping = load("lib/google/mapping.ts", { "@/lib/tasks/dates": dates, "@/lib/tasks/schedules": schedules });
const owner = "11111111-1111-4111-8111-111111111111";
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const today = dates.dateInZone(new Date(), "America/Phoenix");
const tomorrow = dates.addDays(today, 1);

test("event mapping preserves all-day dates, explicit instants, zones, and rejects unsupported edits", () => {
  const task = { taskId: id(1), recurrenceKey: "once", title: "Meeting", location: null,
    date: tomorrow, timezone: "America/Phoenix", time: null, startsAt: null,
    endDate: null, endTime: null, endsAt: null };
  const allDay = mapping.toGoogleEvent(task);
  assert.equal(allDay.start.date, tomorrow);
  assert.equal(allDay.end.date, dates.addDays(tomorrow, 1));
  assert.equal(mapping.fromGoogleEvent({ summary: "Moved", start: { date: tomorrow }, end: allDay.end }, task).title, "Moved");
  const timed = { ...task, time: "09:00:00", startsAt: `${tomorrow}T16:00:00Z` };
  const event = mapping.toGoogleEvent(timed);
  assert.equal(event.start.timeZone, "America/Phoenix");
  assert.equal(event.start.dateTime, `${tomorrow}T16:00:00.000Z`);
  assert.ok(mapping.mappedEqual(event, mapping.toGoogleEvent({ ...timed, startsAt: `${tomorrow}T09:00:00-07:00` })));
  assert.ok(mapping.mappedEqual(event, { end: { ...event.end }, start: { ...event.start }, location: null, summary: "Meeting" }));
  assert.equal(Date.parse(event.end.dateTime) - Date.parse(event.start.dateTime), 3_600_000);
  assert.equal(mapping.fromGoogleEvent({ ...event }, timed).schedule.end_time, null);
  assert.equal(mapping.fromGoogleEvent({ ...event }, task).schedule.end_time, "10:00:00");
  assert.throws(() => mapping.fromGoogleEvent({ summary: "Overnight", start: event.start,
    end: { dateTime: `${dates.addDays(tomorrow, 1)}T07:00:00Z`, timeZone: "America/Phoenix" } }, task), /Unsupported/);
  assert.throws(() => mapping.fromGoogleEvent({ ...event, recurrence: ["RRULE:FREQ=DAILY"] }, timed), /Unsupported/);
  assert.throws(() => mapping.fromGoogleEvent({ ...event, start: { ...event.start, timeZone: "UTC" } }, timed), /Unsupported/);
});

test("refresh tokens are authenticated ciphertext and the app-created scope is exact", () => {
  const secretKey = "sb_secret_fake_calendar_test_key";
  let privilegedClientKey;
  const server = load("lib/google/server.ts", {
    "@googleapis/calendar": { calendar: () => ({}) },
    "google-auth-library": { OAuth2Client: class {} },
    "@supabase/supabase-js": { createClient: (_url, key) => { privilegedClientKey = key; return {}; } },
    "@/lib/auth/site-url": { getSiteUrl: () => "https://ventus.example.test" },
    "@/lib/supabase/config": { requireSupabaseConfig: () => ({ url: "http://127.0.0.1" }) },
  }, { GOOGLE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"), SUPABASE_SECRET_KEY: secretKey });
  assert.equal(server.GOOGLE_SCOPE, "https://www.googleapis.com/auth/calendar.app.created");
  server.serviceClient();
  assert.equal(privilegedClientKey, secretKey);
  const encrypted = server.encryptToken("fake-secret-refresh-token");
  assert.ok(!encrypted.includes("fake-secret-refresh-token"));
  assert.equal(server.decryptToken(encrypted), "fake-secret-refresh-token");
  const parts = encrypted.split(":");
  parts[2] = Buffer.alloc(24, 8).toString("base64");
  assert.throws(() => server.decryptToken(parts.join(":")));
});

function fakeHarness({ recurring = true } = {}) {
  const state = {
    google_calendar_connections: [{ owner_id: owner, status: "connected", calendar_id: "calendar-a",
      refresh_token_ciphertext: "fake-refresh", sync_token: null, generation: 1,
      lease_id: null, lease_until: null, last_error: null }],
    tasks: [{ id: id(1), owner_id: owner, parent_task_id: null, title: "Task", location: null,
      calendar_opt_in: true, recurrence_enabled: recurring, deleted_at: null }],
    task_occurrences: recurring ? [] : [{ id: id(10), owner_id: owner, task_id: id(1), recurrence_key: "once",
      status: "open", deleted_at: null, scheduled_date: tomorrow, timezone: "America/Phoenix",
      start_time: null, starts_at: null, end_date: null, end_time: null, ends_at: null,
      definition_snapshot: { title: "Task", location: null, calendar_opt_in: true } }],
    google_calendar_links: [], google_calendar_dirty: [], task_recurrence_revisions: [],
  };
  const candidates = recurring ? [0, 1].map(offset => ({ task_id: id(1), recurrence_key: dates.addDays(tomorrow, offset),
    scheduled_date: dates.addDays(tomorrow, offset), timezone: "America/Phoenix", start_time: null,
    starts_at: null, end_date: null, end_time: null, ends_at: null,
    definition_snapshot: { title: "Task", location: null, calendar_opt_in: true } })) : [];
  const events = new Map();
  const listItems = [];
  const listErrors = [];
  const calls = [];
  class Query {
    constructor(table, mode = "read", value = null) { this.table = table; this.mode = mode; this.value = value; this.filters = []; this.max = Infinity; }
    select() { return this; }
    eq(key, value) { this.filters.push(row => row[key] === value); return this; }
    gt(key, value) { this.filters.push(row => row[key] > value); return this; }
    lte(key, value) { this.filters.push(row => row[key] <= value); return this; }
    or() { return this; }
    order() { return this; }
    limit(value) { this.max = value; return this; }
    update(value) { this.mode = "update"; this.value = value; return this; }
    insert(value) { this.mode = "insert"; this.value = value; return this; }
    delete() { this.mode = "delete"; return this; }
    execute() {
      const rows = state[this.table];
      let found = rows.filter(row => this.filters.every(check => check(row))).slice(0, this.max);
      if (this.mode === "update") for (const row of found) Object.assign(row, this.value);
      if (this.mode === "insert") {
        const row = { id: id(40 + rows.length), event_id: `v${String(rows.length + 1).padStart(32, "0")}`,
          state: "absent", override_opt_in: null, etag: null, mapped_snapshot: null, ...this.value };
        rows.push(row); found = [row];
      }
      if (this.mode === "delete") state[this.table] = rows.filter(row => !found.includes(row));
      return { data: found, error: null };
    }
    then(resolve, reject) { return Promise.resolve(this.execute()).then(resolve, reject); }
    async single() { const result = this.execute(); return { ...result, data: result.data[0] ?? null }; }
    async maybeSingle() { return this.single(); }
  }
  const db = { from: table => new Query(table), async rpc(name, args) {
    assert.equal(name, "google_calendar_candidates");
    assert.equal(args.p_owner_id, owner);
    return { data: candidates.filter(row => row.scheduled_date >= args.p_from && row.scheduled_date <= args.p_to), error: null };
  } };
  const userClient = { async rpc(name, args) {
    if (name === "fake_apply") {
      state.tasks[0].title = args.title;
      state.tasks[0].location = args.location;
      state.task_occurrences[0].scheduled_date = args.date;
      return { error: null };
    }
    calls.push([name, args]); return { error: null };
  } };
  const api = { events: {
    async list() {
      if (listErrors.length) throw listErrors.shift();
      return { data: { items: listItems.splice(0), nextSyncToken: "cursor-next" } };
    },
    async insert({ requestBody }) {
      calls.push(["insert", requestBody.id]);
      if (events.has(requestBody.id)) throw Object.assign(new Error("Already exists"), { code: 409 });
      const event = { ...requestBody, etag: `etag-${calls.length}` };
      events.set(event.id, event); return { data: event };
    },
    async get({ eventId }) {
      const event = events.get(eventId);
      if (!event) throw Object.assign(new Error("Gone"), { code: 404 });
      return { data: event };
    },
    async update({ eventId, requestBody }) {
      calls.push(["update", eventId]);
      const event = { ...requestBody, etag: `etag-${calls.length}` };
      events.set(eventId, event); return { data: event };
    },
    async delete({ eventId }) { calls.push(["delete", eventId]); events.delete(eventId); },
  } };
  let authFailure = null;
  const server = {
    serviceClient: () => db, calendarClient: () => api, decryptToken: value => value,
    encryptToken: value => value, oauthClient: () => ({ credentials: {}, setCredentials(value) { this.credentials = value; },
      async getAccessToken() { if (authFailure) throw authFailure; return "fake-access"; } }),
  };
  const sync = load("lib/google/sync.ts", {
    "@/lib/tasks/dates": dates, "@/lib/tasks/editor": editor,
    "@/lib/server/task-editor": { readTaskEditor: async () => {
      const task = state.tasks[0]; const occurrence = state.task_occurrences[0];
      return { taskId: task.id, rootId: task.id, rootVersion: 1, timezone: occurrence.timezone,
        categories: [{ id: id(90), calendar_default: true }], nodes: [{ id: task.id, parentId: null,
          taskVersion: 1, occurrenceVersion: 1, title: task.title, location: task.location ?? "",
          calendarOptIn: task.calendar_opt_in, status: "open", date: occurrence.scheduled_date,
          timezone: occurrence.timezone, time: occurrence.start_time ?? "", startsAt: occurrence.starts_at ?? "",
          endDate: occurrence.end_date ?? "", endTime: occurrence.end_time ?? "", endsAt: occurrence.ends_at ?? "",
          categoryId: id(90) }] };
    }, buildTaskWrite: command => ({ changed: true, rpc: "fake_apply",
      args: { title: command.draft.title, location: command.draft.location || null, date: command.draft.date } }) },
    "@/lib/server/workspace": { readSettings: async () => ({ timezone: "America/Phoenix" }),
      readOwnedRows: async (_db, table, _fields, user, activeOnly, filter) => state[table]
        .filter(row => row.owner_id === user && (!activeOnly || !row.deleted_at) &&
          (!filter || row[filter.key] === filter.value)) },
    "./server": server, "./mapping": mapping,
  });
  return { state, events, listItems, listErrors, calls, sync: () => sync.syncOwner(owner, userClient),
    failAuth(error) { authFailure = error; } };
}

test("fake Google API: duplicate-free recurring export and deletion suppresses only one occurrence", async () => {
  const fake = fakeHarness();
  assert.equal((await fake.sync()).synced, true);
  assert.equal(fake.calls.filter(call => call[0] === "insert").length, 2);
  assert.equal((await fake.sync()).synced, true);
  assert.equal(fake.calls.filter(call => call[0] === "insert").length, 2);
  const [first, second] = fake.state.google_calendar_links;
  fake.listItems.push({ id: first.event_id, status: "cancelled" }); // Google omits private metadata on tombstones.
  assert.equal((await fake.sync()).synced, true);
  assert.equal(first.state, "suppressed");
  assert.equal(first.override_opt_in, false);
  assert.equal(second.state, "active");
  assert.equal(fake.state.tasks[0].deleted_at, null);
});

test("fake Google API: a past recurring key postponed into the horizon is still exported", async () => {
  const fake = fakeHarness();
  const oldKey = dates.addDays(today, -1);
  fake.state.task_occurrences.push({ id: id(12), owner_id: owner, task_id: id(1), recurrence_key: oldKey,
    status: "open", deleted_at: null, scheduled_date: tomorrow, timezone: "America/Phoenix",
    start_time: null, starts_at: null, end_date: null, end_time: null, ends_at: null,
    definition_snapshot: { title: "Postponed", location: null, calendar_opt_in: true } });
  assert.equal((await fake.sync()).synced, true);
  assert.equal(fake.state.google_calendar_links.find(link => link.recurrence_key === oldKey)?.state, "active");
});

test("fake Google API: simultaneous edits keep Ventus fields and expired tokens stop sync", async () => {
  const fake = fakeHarness({ recurring: false });
  assert.equal((await fake.sync()).synced, true);
  const link = fake.state.google_calendar_links[0];
  fake.state.tasks[0].title = "Ventus edit";
  fake.listItems.push({ ...fake.events.get(link.event_id), summary: "Google edit" });
  assert.equal((await fake.sync()).synced, true);
  assert.equal(fake.events.get(link.event_id).summary, "Ventus edit");
  assert.equal(fake.calls.filter(call => call[0] === "update").length, 1);
  fake.failAuth(Object.assign(new Error("invalid grant"), { response: { status: 400, data: { error: "invalid_grant" } } }));
  assert.equal((await fake.sync()).reason, "reauthorize");
  assert.equal(fake.state.google_calendar_connections[0].status, "reauthorize");
  assert.equal(fake.state.google_calendar_connections[0].refresh_token_ciphertext, null);
});

test("fake Google API: a completed Ventus task keeps its title when the event changes", async () => {
  const fake = fakeHarness({ recurring: false });
  await fake.sync();
  const link = fake.state.google_calendar_links[0];
  fake.state.task_occurrences[0].status = "completed";
  fake.listItems.push({ ...fake.events.get(link.event_id), summary: "Google edit" });
  assert.equal((await fake.sync()).synced, true);
  assert.equal(fake.state.tasks[0].title, "Task");
  assert.equal(fake.events.get(link.event_id).summary, "Task");
});

test("fake Google API: inbound edits update Ventus; unsupported edits pause one link", async () => {
  const fake = fakeHarness({ recurring: false });
  assert.equal((await fake.sync()).synced, true);
  const link = fake.state.google_calendar_links[0];
  fake.listItems.push({ ...fake.events.get(link.event_id), summary: "Edited in Google" });
  assert.equal((await fake.sync()).synced, true);
  assert.equal(fake.state.tasks[0].title, "Edited in Google");
  assert.equal(fake.calls.filter(call => call[0] === "update").length, 0);
  fake.listItems.push({ ...fake.events.get(link.event_id), recurrence: ["RRULE:FREQ=DAILY"] });
  assert.equal((await fake.sync()).synced, true);
  assert.equal(link.state, "error");
  assert.equal(fake.calls.filter(call => call[0] === "update").length, 0);
});

test("fake Google API: unchecking deletes the event and rechecking creates a fresh identity", async () => {
  const fake = fakeHarness({ recurring: false });
  await fake.sync();
  const link = fake.state.google_calendar_links[0];
  const oldId = link.event_id;
  fake.state.tasks[0].calendar_opt_in = false;
  assert.equal((await fake.sync()).synced, true);
  assert.equal(link.state, "absent");
  assert.notEqual(link.event_id, oldId);
  assert.equal(fake.calls.filter(call => call[0] === "delete").length, 1);
  fake.state.tasks[0].calendar_opt_in = true;
  assert.equal((await fake.sync()).synced, true);
  assert.equal(fake.calls.filter(call => call[0] === "insert").length, 2);
});

test("fake Google API: uncertain insertion reuses its event ID and restores Ventus fields", async () => {
  const fake = fakeHarness({ recurring: false });
  await fake.sync();
  const link = fake.state.google_calendar_links[0];
  fake.events.get(link.event_id).summary = "Changed before retry";
  link.state = "absent"; link.mapped_snapshot = null;
  assert.equal((await fake.sync()).synced, true);
  assert.equal(fake.events.size, 1);
  assert.equal(fake.events.get(link.event_id).summary, "Task");
  assert.equal(link.state, "active");
});

test("fake Google API: expired sync cursor resets once and continues", async () => {
  const fake = fakeHarness({ recurring: false });
  await fake.sync();
  assert.equal(fake.state.google_calendar_connections[0].sync_token, "cursor-next");
  fake.listErrors.push(Object.assign(new Error("Expired cursor"), { code: 410 }));
  assert.equal((await fake.sync()).synced, true);
  assert.equal(fake.state.google_calendar_connections[0].sync_token, "cursor-next");
});

test("daily recovery rejects missing secrets and syncs only service-selected owners", async () => {
  const seen = [];
  class Response {
    constructor(_body, options = {}) { this.status = options.status ?? 200; }
    static json(body) { return { status: 200, body }; }
  }
  const route = load("app/api/google/recovery/route.ts", {
    "next/server": { NextResponse: Response },
    "@/lib/google/server": { serviceClient: () => ({ rpc: async () => {
      seen.push("owners"); return { data: [owner], error: null };
    } }) },
    "@/lib/google/sync": { syncOwner: async id => { seen.push(id); } },
  }, { CRON_SECRET: "fake-cron-secret" });
  assert.equal((await route.GET({ headers: { get: () => "Bearer wrong" } })).status, 401);
  assert.deepEqual(seen, []);
  const result = await route.GET({ headers: { get: () => "Bearer fake-cron-secret" } });
  assert.equal(result.body.processedOwners, 1);
  assert.deepEqual(seen, ["owners", owner]);
});

test("OAuth callback consumes its sealed state and refuses a different Ventus account", async () => {
  const calls = [];
  const cookie = { get: () => ({ value: "sealed" }), set: (...args) => calls.push(["cookie", ...args]) };
  const callback = load("app/api/google/callback/route.ts", {
    "next/headers": { cookies: async () => cookie },
    "next/server": { NextResponse: { redirect: (url, status) => ({ url, status,
      headers: { set() {} } }) } },
    "@/lib/supabase/server": { createClient: async () => ({ auth: { getUser: async () => ({
      data: { user: { id: id(2) } }, error: null }) } }) },
    "@/lib/auth/site-url": { getSiteUrl: () => "https://ventus.example.test" },
    "@/lib/google/server": { decryptToken: () => JSON.stringify({ state: "known-state", codeVerifier: "verifier", userId: owner }),
      oauthClient: () => ({ getToken: () => { calls.push(["token"]); } }),
      calendarClient: () => { throw new Error("Calendar must not be called"); },
      encryptToken: () => { throw new Error("No token storage"); },
      serviceClient: () => { throw new Error("No database access"); } },
    "@/lib/google/sync": { syncOwner: () => { throw new Error("No sync"); } },
  });
  const result = await callback.GET({ nextUrl: { searchParams: new URLSearchParams("code=fake&state=known-state") } });
  assert.equal(result.status, 303);
  assert.equal(result.url.searchParams.get("calendar"), "failed");
  assert.equal(calls[0][0], "cookie");
  assert.equal(calls.some(call => call[0] === "token"), false);
});

function connectionCallback({ currentOwner = id(2), subject = "google-sub-one", rows = [], barrier } = {}) {
  const calls = [];
  class Query {
    constructor() { this.filters = []; this.value = null; }
    select() { return this; }
    eq(key, value) { this.filters.push(row => row[key] === value); return this; }
    neq(key, value) { this.filters.push(row => row[key] !== value); return this; }
    upsert(value) { this.value = value; return this; }
    async maybeSingle() { return { data: rows.find(row => this.filters.every(filter => filter(row))) ?? null, error: null }; }
    async then(resolve) {
      const result = rows.find(row => row.google_sub === this.value.google_sub && row.owner_id !== this.value.owner_id)
        ? { error: { code: "23505" } } : { error: null };
      if (!result.error) {
        const prior = rows.find(row => row.owner_id === this.value.owner_id);
        if (prior) Object.assign(prior, this.value);
        else rows.push({ ...this.value });
      }
      return resolve(result);
    }
  }
  const db = { from: () => new Query() };
  const auth = { getToken: async () => ({ tokens: { refresh_token: "fake-refresh", id_token: "signed-id" } }),
    verifyIdToken: async ({ idToken, audience }) => {
      assert.equal(idToken, "signed-id"); assert.equal(audience, "fake-client-id");
      return { getPayload: () => ({ sub: subject }) };
    }, setCredentials() {}, revokeToken: () => { throw new Error("Rejected tokens must never be revoked"); } };
  const api = { calendars: {
    get: async () => ({}),
    insert: async () => {
      calls.push("create");
      if (barrier) await barrier();
      return { data: { id: `calendar-${currentOwner}` } };
    },
    delete: async ({ calendarId }) => { calls.push(["delete", calendarId]); },
  } };
  const route = load("app/api/google/callback/route.ts", {
    "next/headers": { cookies: async () => ({ get: () => ({ value: "sealed" }), set() {} }) },
    "next/server": { NextResponse: { redirect: (url, status) => ({ url, status, headers: { set() {} } }) } },
    "@/lib/supabase/server": { createClient: async () => ({ auth: { getUser: async () => ({
      data: { user: { id: currentOwner } }, error: null }) } }) },
    "@/lib/auth/site-url": { getSiteUrl: () => "https://ventus.example.test" },
    "@/lib/google/server": { decryptToken: () => JSON.stringify({ state: "known", codeVerifier: "pkce", userId: currentOwner }),
      oauthClient: () => auth, calendarClient: () => api, encryptToken: () => "encrypted-fake-refresh", serviceClient: () => db },
    "@/lib/google/sync": { syncOwner: async () => { calls.push("sync"); } },
  }, { GOOGLE_CLIENT_ID: "fake-client-id" });
  return { rows, calls, run: () => route.GET({ nextUrl: { searchParams: new URLSearchParams("code=fake&state=known") } }) };
}

test("duplicate Google subject is rejected without changing either connection or revoking a token", async () => {
  const original = { owner_id: owner, google_sub: "google-sub-one", status: "connected",
    calendar_id: "first-calendar", refresh_token_ciphertext: "first-encrypted-token", generation: 1 };
  const rows = [original];
  const second = connectionCallback({ rows });
  assert.equal((await second.run()).url.searchParams.get("calendar"), "already-connected");
  assert.deepEqual(rows, [original]);
  assert.deepEqual(second.calls, []);
  const switcher = connectionCallback({ currentOwner: owner, subject: "different-google-sub", rows });
  assert.equal((await switcher.run()).url.searchParams.get("calendar"), "switch-account");
  assert.deepEqual(rows, [original]);
});

test("concurrent Google callbacks leave one subject claim and remove the losing new calendar", async () => {
  const rows = [];
  let waiting = 0;
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  const barrier = () => { if (++waiting === 2) release(); return ready; };
  const first = connectionCallback({ currentOwner: owner, rows, barrier });
  const second = connectionCallback({ currentOwner: id(2), rows, barrier });
  const results = await Promise.all([first.run(), second.run()]);
  assert.deepEqual(results.map(result => result.url.searchParams.get("calendar")).sort(), ["already-connected", "connected"]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].google_sub, "google-sub-one");
  assert.equal([...first.calls, ...second.calls].filter(call => Array.isArray(call) && call[0] === "delete").length, 1);
  assert.equal([...first.calls, ...second.calls].filter(call => call === "sync").length, 1);
});

test("disconnect keeps the subject reserved through revocation, then releases it", async () => {
  const row = { owner_id: owner, status: "connected", google_sub: "google-sub-one",
    refresh_token_ciphertext: "encrypted", generation: 1, lease_until: null };
  const transitions = [];
  class Query {
    constructor() { this.patch = null; this.filters = []; }
    select() { return this; }
    eq(key, value) { this.filters.push(item => item[key] === value); return this; }
    or() { return this; }
    update(patch) { this.patch = patch; return this; }
    result() {
      if (!this.filters.every(filter => filter(row))) return { data: null, error: null };
      if (this.patch) { Object.assign(row, this.patch); transitions.push([row.status, row.google_sub]); }
      return { data: { ...row }, error: null };
    }
    async maybeSingle() { return this.result(); }
    then(resolve) { return Promise.resolve(this.result()).then(resolve); }
  }
  const actions = load("app/google-actions.ts", {
    "google-auth-library": { CodeChallengeMethod: { S256: "S256" } },
    "next/headers": { headers: async () => new Map([["origin", "https://ventus.example.test"],
      ["host", "ventus.example.test"]]) },
    "next/cache": { revalidatePath() {} },
    "@/lib/supabase/server": { createClient: async () => ({ auth: { getUser: async () => ({
      data: { user: { id: owner } }, error: null }) } }) },
    "@/lib/auth/site-url": { isValidActionOrigin: () => true },
    "@/lib/google/server": { serviceClient: () => ({ from: () => new Query() }), decryptToken: () => "fake-refresh",
      oauthClient: () => ({ revokeToken: async () => {
        assert.equal(row.status, "disconnecting");
        assert.equal(row.google_sub, "google-sub-one");
        transitions.push(["revoke", row.google_sub]);
      } }) },
    "@/lib/google/sync": { syncOwner: async () => {} },
  });
  assert.equal((await actions.disconnectGoogle()).ok, true);
  assert.deepEqual(transitions, [["disconnecting", "google-sub-one"], ["revoke", "google-sub-one"],
    ["disconnected", null]]);
  assert.equal(row.refresh_token_ciphertext, null);
});

test("Google authorization requests identity and app-created Calendar access with PKCE", async () => {
  let options;
  const actions = load("app/google-actions.ts", {
    "google-auth-library": { CodeChallengeMethod: { S256: "S256" } },
    "next/headers": { headers: async () => new Map([["origin", "https://ventus.example.test"],
      ["host", "ventus.example.test"]]), cookies: async () => ({ set() {} }) },
    "next/cache": { revalidatePath() {} },
    "@/lib/supabase/server": { createClient: async () => ({ auth: { getUser: async () => ({
      data: { user: { id: owner } }, error: null }) } }) },
    "@/lib/auth/site-url": { isValidActionOrigin: () => true, getSiteUrl: () => "https://ventus.example.test" },
    "@/lib/google/server": { GOOGLE_SCOPE: "https://www.googleapis.com/auth/calendar.app.created",
      encryptToken: () => "sealed", oauthClient: () => ({
        generateCodeVerifierAsync: async () => ({ codeVerifier: "verifier", codeChallenge: "challenge" }),
        generateAuthUrl: value => { options = value; return "https://accounts.google.test/authorize"; },
      }) },
    "@/lib/google/sync": { syncOwner: async () => {} },
  });
  assert.equal((await actions.startGoogleConnection()).ok, true);
  assert.deepEqual(Array.from(options.scope), ["openid", "https://www.googleapis.com/auth/calendar.app.created"]);
  assert.equal(options.code_challenge_method, "S256");
  assert.equal(options.access_type, "offline");
});
