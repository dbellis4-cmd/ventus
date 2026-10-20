"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { isValidActionOrigin } from "@/lib/auth/site-url";
import { validTimezone } from "@/lib/tasks/dates";

export type SetupState = { error?: string; success?: boolean };

// The only write enabled in Stage 1: explicit settings/default-category setup.
// No task lifecycle RPC is reachable through this action.
export async function confirmTimezone(_previous: SetupState, form: FormData): Promise<SetupState> {
  if (!(form instanceof FormData) || !validTimezone(form.get("timezone"))) {
    return { error: "Choose and confirm a supported IANA timezone." };
  }
  try {
    const requestHeaders = await headers();
    if (!isValidActionOrigin(requestHeaders.get("origin"), requestHeaders.get("host"))) return { error: "Invalid request origin. Reload the page and try again." };
    const client = await createClient({ requireCookieWrites: true });
    const { data: { user }, error: authError } = await client.auth.getUser();
    if (authError || !user) return { error: "Your session has expired. Sign in again." };
    const { error } = await client.rpc("initialize_workspace", { p_timezone: form.get("timezone") });
    if (error) return { error: "Unable to initialize your workspace. Check the timezone and try again." };
  } catch {
    return { error: "Workspace setup is temporarily unavailable. Please try again." };
  }
  revalidatePath("/");
  return { success: true };
}
