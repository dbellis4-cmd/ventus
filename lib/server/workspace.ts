import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { projectWorkspace, type CategoryRow, type OccurrenceRow, type TaskRow, type Workspace } from "@/lib/tasks/projections";

// Explicit projections exclude ownership, retry fingerprints, history and tokens
// from browser props. RLS remains authoritative; filters add defense in depth.
const categoryFields = "id,name,seed_key,behavior,calendar_default,archived_at";
const taskFields = "id,parent_task_id,title,deleted_at";
const occurrenceFields = "id,task_id,scheduled_date,timezone,start_time,starts_at,original_date,original_start_time,original_timezone,status,completed_at,deleted_at,definition_snapshot";

export async function readSettings(client: SupabaseClient, userId: string) {
  const { data, error } = await client.from("user_settings").select("timezone,defaults_initialized_at").eq("user_id", userId).maybeSingle();
  if (error) throw error;
  return data as { timezone: string; defaults_initialized_at: string | null } | null;
}

// Keyset pagination avoids the Data API's default row limit silently hiding older
// deadlines or off-week parents. Stage 1 reads the active workspace; return only
// the requested week's projection. Windowed querying can replace this if needed.
export async function readOwnedRows<T extends { id: string }>(client: SupabaseClient, table: string, fields: string, userId: string, activeOnly: boolean): Promise<T[]> {
  const rows: T[] = [];
  let after: string | undefined;
  for (;;) {
    let query = client.from(table).select(fields).eq("owner_id", userId).order("id").limit(500);
    if (activeOnly) query = query.is("deleted_at", null);
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

export async function loadWorkspace(verifiedUserId: string, selectedDate?: unknown): Promise<Workspace | { kind: "signed-out" }> {
  try {
    const client = await createClient();
    const { data: { user }, error } = await client.auth.getUser();
    if (error || !user || user.id !== verifiedUserId) return { kind: "signed-out" };
    const settings = await readSettings(client, user.id);
    if (!settings?.defaults_initialized_at) return { kind: "setup" };
    const [categories, tasks, occurrences] = await Promise.all([
      readOwnedRows<CategoryRow>(client, "categories", categoryFields, user.id, false),
      readOwnedRows<TaskRow>(client, "tasks", taskFields, user.id, true),
      readOwnedRows<OccurrenceRow>(client, "task_occurrences", occurrenceFields, user.id, true),
    ]);
    return projectWorkspace(settings.timezone, selectedDate, categories, tasks, occurrences);
  } catch {
    // Provider messages may contain private details. Never substitute demo rows.
    return { kind: "error" };
  }
}
