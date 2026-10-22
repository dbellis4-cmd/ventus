import "server-only";

import type { calendar_v3 } from "@googleapis/calendar";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { addDays, dateInZone } from "@/lib/tasks/dates";
import { initialDraft, type SaveCommand } from "@/lib/tasks/editor";
import { buildTaskWrite, readTaskEditor } from "@/lib/server/task-editor";
import { readOwnedRows, readSettings } from "@/lib/server/workspace";
import { calendarClient, decryptToken, encryptToken, oauthClient, serviceClient } from "./server";
import { fromGoogleEvent, mappedEqual, toGoogleEvent, type CalendarTask, type MappedEvent } from "./mapping";

type Connection = { owner_id: string; status: string; calendar_id: string | null; refresh_token_ciphertext: string | null;
  sync_token: string | null; generation: number; lease_id: string | null; lease_until: string | null };
type Link = { id: string; owner_id: string; task_id: string; recurrence_key: string; calendar_id: string | null; event_id: string;
  override_opt_in: boolean | null; state: string; etag: string | null; mapped_snapshot: MappedEvent | null };
type TaskRow = { id: string; parent_task_id: string | null; title: string; location: string | null;
  calendar_opt_in: boolean; recurrence_enabled: boolean; deleted_at: string | null };
type Occurrence = { id: string; task_id: string; recurrence_key: string; status: string; deleted_at: string | null;
  scheduled_date: string; timezone: string; start_time: string | null; starts_at: string | null;
  end_date: string | null; end_time: string | null; ends_at: string | null;
  definition_snapshot: { title: string; location: string | null; calendar_opt_in: boolean } };

function status(error: unknown): number {
  if (typeof error !== "object" || error === null) return 0;
  if ("code" in error && Number.isInteger(Number(error.code))) return Number(error.code);
  if ("response" in error && typeof error.response === "object" && error.response !== null &&
      "status" in error.response) return Number(error.response.status);
  return 0;
}
function authorizationExpired(error: unknown) {
  if (status(error) === 401) return true;
  if (typeof error !== "object" || error === null || !("response" in error) ||
      typeof error.response !== "object" || error.response === null || !("data" in error.response)) return false;
  const data = error.response.data;
  return typeof data === "object" && data !== null && "error" in data && data.error === "invalid_grant";
}
function retryAt(attempts: number) {
  return new Date(Date.now() + Math.min(60 * 60_000, 1000 * 2 ** Math.min(attempts, 10)) + Math.random() * 1000).toISOString();
}
function yearEnd(today: string) {
  const end = new Date(`${today}T12:00:00Z`);
  end.setUTCFullYear(end.getUTCFullYear() + 1);
  return addDays(end.toISOString().slice(0, 10), -1);
}

async function requireData<T>(query: PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await query;
  if (error || data === null) throw new Error(error?.message ?? "Calendar storage returned no data");
  return data;
}

function source(task: TaskRow, occurrence: Occurrence): CalendarTask {
  const snapshot = occurrence.definition_snapshot;
  return { taskId: task.id, recurrenceKey: occurrence.recurrence_key,
    title: occurrence.recurrence_key === "once" ? task.title : snapshot.title,
    location: occurrence.recurrence_key === "once" ? task.location : snapshot.location,
    date: occurrence.scheduled_date, timezone: occurrence.timezone, time: occurrence.start_time,
    startsAt: occurrence.starts_at, endDate: occurrence.end_date,
    endTime: occurrence.end_time, endsAt: occurrence.ends_at };
}

async function loadSources(ownerId: string) {
  const db = serviceClient();
  const settings = await readSettings(db, ownerId);
  if (!settings) throw new Error("Calendar owner has no workspace settings");
  const today = dateInZone(new Date(), settings.timezone);
  const horizon = yearEnd(today);
  const tasks = (await readOwnedRows<TaskRow & { id: string }>(db, "tasks",
    "id,parent_task_id,title,location,calendar_opt_in,recurrence_enabled,deleted_at", ownerId, false))
    .filter((task) => !task.parent_task_id);
  const taskIds = new Set(tasks.map((task) => task.id));
  const definitions = new Map(tasks.map((task) => [task.id, task]));
  const stored = (await readOwnedRows<Occurrence & { id: string }>(db, "task_occurrences",
    "id,task_id,recurrence_key,status,deleted_at,scheduled_date,timezone,start_time,starts_at,end_date,end_time,ends_at,definition_snapshot", ownerId, false))
    .filter((row) => taskIds.has(row.task_id));
  if (tasks.some((task) => task.recurrence_enabled && !task.deleted_at)) {
    const storedKeys = new Set(stored.map((row) => `${row.task_id}:${row.recurrence_key}`));
    const candidates = new Set<string>();
    const { data, error } = await db.rpc("google_calendar_candidates", {
      p_owner_id: ownerId, p_from: today, p_to: horizon });
    if (error || !Array.isArray(data)) throw error ?? new Error("Missing calendar recurrence candidates");
    const virtual = data as Array<Pick<Occurrence, "task_id" | "recurrence_key" | "scheduled_date" | "timezone" |
      "start_time" | "starts_at" | "end_date" | "end_time" | "ends_at" | "definition_snapshot">>;
    for (const row of virtual) {
      const key = `${row.task_id}:${row.recurrence_key}`;
      candidates.add(key);
      if (taskIds.has(row.task_id) && !storedKeys.has(key)) stored.push({
        ...row, id: key, status: "open", deleted_at: null,
      });
    }
    const stops = await readOwnedRows<{ id: string; task_id: string; effective_from: string }>(db,
      "task_recurrence_revisions", "id,task_id,effective_from", ownerId, false, { key: "stopped", value: true });
    const stopDates = new Map(stops.map((stop) => [stop.task_id, stop.effective_from]));
    for (let index = stored.length - 1; index >= 0; index--) {
      const row = stored[index];
      const task = definitions.get(row.task_id);
      if (!task?.recurrence_enabled || row.recurrence_key === "once") continue;
      const stop = stopDates.get(row.task_id);
      if (row.status === "open" && stop && (row.recurrence_key >= stop || row.scheduled_date >= stop)) {
        stored.splice(index, 1);
      } else if (row.recurrence_key >= today && row.recurrence_key <= horizon &&
          row.scheduled_date >= today && row.scheduled_date <= horizon &&
          !candidates.has(`${row.task_id}:${row.recurrence_key}`)) stored.splice(index, 1);
    }
  }
  return { definitions, occurrences: stored, today, horizon };
}

async function applyGoogleEdit(userClient: SupabaseClient, ownerId: string, link: Link,
  event: calendar_v3.Schema$Event, current: CalendarTask) {
  const editor = await readTaskEditor(userClient, ownerId, link.task_id,
    link.recurrence_key === "once" ? undefined : link.recurrence_key);
  const draft = initialDraft(editor, current.date);
  const incoming = fromGoogleEvent(event, current);
  draft.title = incoming.title;
  draft.location = incoming.location;
  draft.date = incoming.schedule.date;
  draft.time = incoming.schedule.start_time ?? "";
  draft.endTime = incoming.schedule.end_time ?? "";
  draft.startInstant = incoming.schedule.starts_at ?? "";
  draft.endInstant = incoming.schedule.ends_at ?? "";
  const target = editor.nodes.find((node) => node.id === link.task_id);
  if (!target || target.status !== "open") throw new Error("Closed Ventus task cannot accept Google edits");
  const command: SaveCommand = { kind: "edit", taskId: link.task_id, rootId: editor.rootId!,
    rootVersion: editor.rootVersion!, taskVersion: target.taskVersion, occurrenceVersion: target.occurrenceVersion,
    draft, ...(link.recurrence_key === "once" ? {} : { recurrenceKey: link.recurrence_key, scope: "occurrence" as const }) };
  const write = buildTaskWrite(command, editor);
  if (write.changed) {
    const { error } = await userClient.rpc(write.rpc, write.args);
    if (error) throw error;
  }
}

async function pullChanges(ownerId: string, userClient: SupabaseClient, connection: Connection,
  api: ReturnType<typeof calendarClient>, sources: Awaited<ReturnType<typeof loadSources>>,
  renewLease: () => Promise<void>) {
  const db = serviceClient();
  const existing = await readOwnedRows<Link & { id: string }>(db, "google_calendar_links",
    "id,owner_id,task_id,recurrence_key,calendar_id,event_id,override_opt_in,state,etag,mapped_snapshot", ownerId, false);
  const links = new Map(existing.filter((link) => link.calendar_id === connection.calendar_id).map((link) => [link.event_id, link]));
  const occurrences = new Map(sources.occurrences.map((row) => [`${row.task_id}:${row.recurrence_key}`, row]));
  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;
  let ventusChanged = false;
  for (;;) {
    await renewLease();
    let data: calendar_v3.Schema$Events;
    try {
      ({ data } = await api.events.list({ calendarId: connection.calendar_id!, syncToken: connection.sync_token ?? undefined,
        pageToken, maxResults: 250, showDeleted: true, singleEvents: false }));
    } catch (error) {
      if (status(error) === 410 && connection.sync_token) {
        await requireData(db.from("google_calendar_connections").update({ sync_token: null }).eq("owner_id", ownerId).eq("generation", connection.generation).select("owner_id").single());
        return pullChanges(ownerId, userClient, { ...connection, sync_token: null }, api, sources, renewLease);
      }
      throw error;
    }
    for (const event of data.items ?? []) {
      const link = event.id && links.get(event.id);
      if (!link || link.state === "suppressed" ||
          (event.status !== "cancelled" && event.extendedProperties?.private?.ventusLinkId !== link.id)) continue;
      if (event.status === "cancelled") {
        await requireData(db.from("google_calendar_links").update({ override_opt_in: false, state: "suppressed", etag: null,
          mapped_snapshot: null, updated_at: new Date().toISOString() }).eq("id", link.id).eq("owner_id", ownerId).select("id").single());
        continue;
      }
      const task = sources.definitions.get(link.task_id);
      const occurrence = occurrences.get(`${link.task_id}:${link.recurrence_key}`);
      if (!task || !occurrence || task.deleted_at || occurrence.deleted_at || occurrence.status === "canceled") continue;
      const current = source(task, occurrence);
      let google: ReturnType<typeof fromGoogleEvent>;
      try { google = fromGoogleEvent(event, current); }
      catch {
        await requireData(db.from("google_calendar_links").update({ state: "error",
          last_error: "Unsupported Google event edit", updated_at: new Date().toISOString() })
          .eq("id", link.id).eq("owner_id", ownerId).select("id").single());
        continue;
      }
      const candidate = toGoogleEvent({ ...current, title: google.title, location: google.location || null,
        date: google.schedule.date, timezone: google.schedule.timezone, time: google.schedule.start_time,
        startsAt: google.schedule.starts_at, endDate: google.schedule.end_date,
        endTime: google.schedule.end_time, endsAt: google.schedule.ends_at });
      if (!mappedEqual(candidate, link.mapped_snapshot ?? toGoogleEvent(current))) {
        if (occurrence.status === "open" && link.mapped_snapshot &&
            mappedEqual(toGoogleEvent(current), link.mapped_snapshot)) {
          await applyGoogleEdit(userClient, ownerId, link, event, current);
          ventusChanged = true;
        }
        // If both sides changed, Ventus wins on the next outbound pass.
      }
      await requireData(db.from("google_calendar_links").update({ etag: event.etag ?? null,
        mapped_snapshot: candidate, state: "active", last_error: null, updated_at: new Date().toISOString() })
        .eq("id", link.id).eq("owner_id", ownerId).select("id").single());
    }
    pageToken = data.nextPageToken ?? undefined;
    nextSyncToken = data.nextSyncToken ?? undefined;
    if (!pageToken) break;
  }
  if (nextSyncToken) await requireData(db.from("google_calendar_connections").update({ sync_token: nextSyncToken,
    last_synced_at: new Date().toISOString(), last_error: null })
    .eq("owner_id", ownerId).eq("generation", connection.generation).select("owner_id").single());
  return ventusChanged;
}

async function ensureLink(db: ReturnType<typeof serviceClient>, ownerId: string, calendarId: string,
  taskId: string, recurrenceKey: string) {
  const found = await db.from("google_calendar_links").select("id,owner_id,task_id,recurrence_key,calendar_id,event_id,override_opt_in,state,etag,mapped_snapshot")
    .eq("owner_id", ownerId).eq("task_id", taskId).eq("recurrence_key", recurrenceKey).maybeSingle();
  if (found.error) throw found.error;
  if (found.data && found.data.calendar_id !== calendarId) {
    return await requireData<Link>(db.from("google_calendar_links").update({ calendar_id: calendarId,
      event_id: `v${randomUUID().replaceAll("-", "")}`, state: found.data.state === "suppressed" ? "suppressed" : "absent",
      etag: null, mapped_snapshot: null })
      .eq("id", found.data.id).eq("owner_id", ownerId)
      .select("id,owner_id,task_id,recurrence_key,calendar_id,event_id,override_opt_in,state,etag,mapped_snapshot").single());
  }
  if (found.data) return found.data as Link;
  return await requireData<Link>(db.from("google_calendar_links").insert({ owner_id: ownerId, task_id: taskId,
    recurrence_key: recurrenceKey, calendar_id: calendarId }).select("id,owner_id,task_id,recurrence_key,calendar_id,event_id,override_opt_in,state,etag,mapped_snapshot").single());
}

async function removeLinkedEvent(ownerId: string, api: ReturnType<typeof calendarClient>, link: Link) {
  if (link.state === "suppressed" || link.state === "absent") return false;
  if (link.calendar_id && (link.state === "active" || link.state === "error")) {
    try { await api.events.delete({ calendarId: link.calendar_id, eventId: link.event_id },
      { headers: link.etag ? { "If-Match": link.etag } : undefined }); }
    catch (error) { if (status(error) !== 404 && status(error) !== 410) throw error; }
  }
  await requireData(serviceClient().from("google_calendar_links").update({ state: "absent", etag: null,
    mapped_snapshot: null, event_id: `v${randomUUID().replaceAll("-", "")}` })
    .eq("id", link.id).eq("owner_id", ownerId).select("id").single());
  return true;
}

async function pushOne(ownerId: string, connection: Connection, api: ReturnType<typeof calendarClient>,
  task: TaskRow, occurrence: Occurrence, existing?: Link) {
  const db = serviceClient();
  let link = existing;
  const desired = !task.deleted_at && !occurrence.deleted_at && occurrence.status !== "canceled" &&
    (link?.override_opt_in ?? (task.recurrence_enabled ? occurrence.definition_snapshot.calendar_opt_in : task.calendar_opt_in)) &&
    (!task.recurrence_enabled || occurrence.recurrence_key !== "once");
  if (!desired && !link) return false;
  if (desired && (!link || link.calendar_id !== connection.calendar_id)) link = await ensureLink(db, ownerId, connection.calendar_id!, task.id, occurrence.recurrence_key);
  if (!link || link.state === "suppressed") return false;
  if (!desired) return removeLinkedEvent(ownerId, api, link);
  if (link.state === "error") return false;
  const mapped = toGoogleEvent(source(task, occurrence));
  if (link.state === "active" && link.mapped_snapshot && mappedEqual(mapped, link.mapped_snapshot)) return false;
  let event: calendar_v3.Schema$Event;
  if (link.state === "absent") {
    try {
      ({ data: event } = await api.events.insert({ calendarId: link.calendar_id!,
        requestBody: { ...mapped, id: link.event_id, visibility: "private",
          extendedProperties: { private: { ventusLinkId: link.id } } } }));
    } catch (error) {
      if (status(error) !== 409) throw error;
      ({ data: event } = await api.events.get({ calendarId: link.calendar_id!, eventId: link.event_id }));
      if (event.extendedProperties?.private?.ventusLinkId !== link.id) throw new Error("Google event ID collision");
      ({ data: event } = await api.events.update({ calendarId: link.calendar_id!, eventId: link.event_id,
        requestBody: { ...event, ...mapped } }, { headers: { "If-Match": event.etag ?? "" } }));
    }
  } else {
    let current: calendar_v3.Schema$Event;
    try { ({ data: current } = await api.events.get({ calendarId: link.calendar_id!, eventId: link.event_id })); }
    catch (error) {
      if (status(error) !== 404) throw error;
      await requireData(db.from("google_calendar_links").update({ override_opt_in: false, state: "suppressed", etag: null,
        mapped_snapshot: null }).eq("id", link.id).eq("owner_id", ownerId).select("id").single());
      return true;
    }
    if (current.extendedProperties?.private?.ventusLinkId !== link.id) throw new Error("Linked Google event identity changed");
    try { ({ data: event } = await api.events.update({ calendarId: link.calendar_id!, eventId: link.event_id,
      requestBody: { ...current, ...mapped } }, { headers: { "If-Match": current.etag ?? "" } })); }
    catch (error) {
      if (status(error) !== 412) throw error;
      // Ventus wins mapped fields; a later retry re-reads the new Google version.
      throw error;
    }
  }
  await requireData(db.from("google_calendar_links").update({ state: "active", etag: event.etag ?? null,
    mapped_snapshot: mapped, last_error: null, updated_at: new Date().toISOString() })
    .eq("id", link.id).eq("owner_id", ownerId).select("id").single());
  return true;
}

export async function syncOwner(ownerId: string, userClient?: SupabaseClient) {
  const db = serviceClient();
  const lease = randomUUID();
  const started = new Date().toISOString();
  const acquired = await db.from("google_calendar_connections").update({ lease_id: lease,
    lease_until: new Date(Date.now() + 5 * 60_000).toISOString() }).eq("owner_id", ownerId).eq("status", "connected")
    .or(`lease_until.is.null,lease_until.lt.${new Date().toISOString()}`)
    .select("owner_id,status,calendar_id,refresh_token_ciphertext,sync_token,generation,lease_id,lease_until").maybeSingle();
  if (acquired.error) throw acquired.error;
  if (!acquired.data) return { synced: false, reason: "busy-or-disconnected" };
  const connection = acquired.data as Connection;
  async function renewLease() {
    await requireData(db.from("google_calendar_connections").update({
      lease_until: new Date(Date.now() + 5 * 60_000).toISOString(),
    }).eq("owner_id", ownerId).eq("status", "connected").eq("generation", connection.generation)
      .eq("lease_id", lease).select("owner_id").single());
  }
  try {
    const auth = oauthClient();
    auth.setCredentials({ refresh_token: decryptToken(connection.refresh_token_ciphertext!) });
    await auth.getAccessToken();
    if (auth.credentials.refresh_token && auth.credentials.refresh_token !== decryptToken(connection.refresh_token_ciphertext!)) {
      await requireData(db.from("google_calendar_connections").update({ refresh_token_ciphertext: encryptToken(auth.credentials.refresh_token) })
        .eq("owner_id", ownerId).eq("lease_id", lease).select("owner_id").single());
    }
    const api = calendarClient(auth);
    let sources = await loadSources(ownerId);
    if (userClient) {
      if (await pullChanges(ownerId, userClient, connection, api, sources, renewLease)) sources = await loadSources(ownerId);
    }
    const links = await readOwnedRows<Link & { id: string }>(db, "google_calendar_links",
      "id,owner_id,task_id,recurrence_key,calendar_id,event_id,override_opt_in,state,etag,mapped_snapshot", ownerId, false);
    const byKey = new Map(links.map((link) => [`${link.task_id}:${link.recurrence_key}`, link]));
    const activeKeys = new Set<string>();
    let processed = 0;
    for (const occurrence of sources.occurrences) {
      const task = sources.definitions.get(occurrence.task_id);
      if (!task || processed >= 100) break;
      if (task.recurrence_enabled && (occurrence.scheduled_date < sources.today || occurrence.scheduled_date > sources.horizon)) continue;
      const key = `${task.id}:${occurrence.recurrence_key}`;
      activeKeys.add(key);
      const link = byKey.get(key);
      await renewLease();
      if (await pushOne(ownerId, connection, api, task, occurrence, link)) processed++;
    }
    for (const [key, link] of byKey) {
      if (processed >= 100) break;
      const task = sources.definitions.get(link.task_id);
      if (!activeKeys.has(key) && link.calendar_id === connection.calendar_id &&
          (task?.deleted_at || link.recurrence_key === "once" ||
            (link.recurrence_key >= sources.today && link.recurrence_key <= sources.horizon))) {
        await renewLease();
        if (await removeLinkedEvent(ownerId, api, link)) processed++;
      }
    }
    if (processed < 100) await db.from("google_calendar_dirty").delete()
      .eq("owner_id", ownerId).lte("queued_at", started);
    await requireData(db.from("google_calendar_connections").update({ last_error: null,
      last_synced_at: new Date().toISOString() })
      .eq("owner_id", ownerId).eq("lease_id", lease).select("owner_id").single());
    return { synced: true, processed };
  } catch (error) {
    const expired = authorizationExpired(error);
    await db.from("google_calendar_connections").update({ status: expired ? "reauthorize" : "connected",
      ...(expired ? { refresh_token_ciphertext: null } : {}),
      last_error: expired ? "Reconnect Google Calendar" : "Calendar sync will retry" })
      .eq("owner_id", ownerId).eq("lease_id", lease);
    if (expired) return { synced: false, reason: "reauthorize" };
    const dirty = await db.from("google_calendar_dirty").select("task_id,attempts").eq("owner_id", ownerId);
    for (const job of dirty.data ?? []) await db.from("google_calendar_dirty").update({
      attempts: job.attempts + 1, next_attempt_at: retryAt(job.attempts + 1) })
      .eq("owner_id", ownerId).eq("task_id", job.task_id);
    return { synced: false, reason: "retry" };
  } finally {
    await db.from("google_calendar_connections").update({ lease_id: null, lease_until: null })
      .eq("owner_id", ownerId).eq("lease_id", lease);
  }
}
