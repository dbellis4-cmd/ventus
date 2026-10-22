"use server";

import { randomBytes } from "node:crypto";
import { CodeChallengeMethod } from "google-auth-library";
import { cookies, headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getSiteUrl, isValidActionOrigin } from "@/lib/auth/site-url";
import { GOOGLE_SCOPE, decryptToken, encryptToken, oauthClient, serviceClient } from "@/lib/google/server";
import { syncOwner } from "@/lib/google/sync";

async function authorized() {
  const request = await headers();
  if (!isValidActionOrigin(request.get("origin"), request.get("host"))) throw new Error("Invalid request origin");
  const client = await createClient({ requireCookieWrites: true });
  const { data: { user }, error } = await client.auth.getUser();
  if (error || !user) throw new Error("Sign in again");
  return { client, userId: user.id };
}

export async function startGoogleConnection() {
  try {
    const { userId } = await authorized();
    const auth = oauthClient();
    const { codeVerifier, codeChallenge } = await auth.generateCodeVerifierAsync();
    if (!codeVerifier || !codeChallenge) throw new Error("Google PKCE unavailable");
    const state = randomBytes(24).toString("base64url");
    (await cookies()).set("ventus-google-oauth", encryptToken(JSON.stringify({ state, codeVerifier, userId })), {
      httpOnly: true, secure: getSiteUrl().startsWith("https:"), sameSite: "lax", path: "/api/google/callback", maxAge: 600,
    });
    return { ok: true as const, url: auth.generateAuthUrl({ access_type: "offline", prompt: "consent",
      scope: ["openid", GOOGLE_SCOPE], state, code_challenge: codeChallenge, code_challenge_method: CodeChallengeMethod.S256 }) };
  } catch { return { ok: false as const, message: "Google Calendar connection is unavailable." }; }
}

export async function getGoogleStatus() {
  try {
    const { userId } = await authorized();
    const { data, error } = await serviceClient().from("google_calendar_connections")
      .select("status,last_synced_at,last_error").eq("owner_id", userId).maybeSingle();
    if (error) throw error;
    const { count, error: linkError } = await serviceClient().from("google_calendar_links")
      .select("id", { count: "exact", head: true }).eq("owner_id", userId).eq("state", "error");
    if (linkError) throw linkError;
    return { status: data?.status ?? "disconnected", lastSyncedAt: data?.last_synced_at ?? null,
      message: count ? `${count} Google event edit${count === 1 ? "" : "s"} need review in Google Calendar.` : data?.last_error ?? null };
  } catch { return { status: "unavailable", lastSyncedAt: null, message: "Calendar settings are unavailable." }; }
}

export async function syncGoogleNow() {
  try {
    const { client, userId } = await authorized();
    const result = await syncOwner(userId, client);
    if (result.synced) revalidatePath("/");
    return result;
  } catch { return { synced: false, reason: "unavailable" }; }
}

export async function disconnectGoogle() {
  try {
    const { userId } = await authorized();
    const db = serviceClient();
    const { data, error } = await db.from("google_calendar_connections")
      .select("refresh_token_ciphertext,lease_until,status,generation").eq("owner_id", userId).maybeSingle();
    if (error) throw error;
    if (!data || data.status === "disconnected") return { ok: true as const };
    if (data.status === "disconnecting") {
      const { data: finished, error: finishError } = await db.from("google_calendar_connections").update({
        status: "disconnected", google_sub: null, lease_id: null, lease_until: null,
      }).eq("owner_id", userId).eq("status", "disconnecting").select("owner_id").maybeSingle();
      if (finishError || !finished) throw finishError ?? new Error("Disconnect did not finish");
      revalidatePath("/");
      return { ok: true as const };
    }
    if (data.lease_until && Date.parse(data.lease_until) > Date.now()) return { ok: false as const, message: "Calendar sync is finishing. Try disconnecting again shortly." };
    const { data: updated, error: updateError } = await db.from("google_calendar_connections").update({
      status: "disconnecting", refresh_token_ciphertext: null, sync_token: null,
      lease_id: null, lease_until: null, last_error: null, generation: data.generation + 1,
    }).eq("owner_id", userId).eq("generation", data.generation)
      .or(`lease_until.is.null,lease_until.lt.${new Date().toISOString()}`)
      .select("owner_id").maybeSingle();
    if (updateError || !updated) throw updateError ?? new Error("Disconnect failed");
    if (data.refresh_token_ciphertext) {
      try { await oauthClient().revokeToken(decryptToken(data.refresh_token_ciphertext)); } catch { /* Local access is removed even if Google is unavailable. */ }
    }
    const { data: finished, error: finishError } = await db.from("google_calendar_connections").update({
      status: "disconnected", google_sub: null,
    }).eq("owner_id", userId).eq("generation", data.generation + 1).eq("status", "disconnecting")
      .select("owner_id").maybeSingle();
    if (finishError || !finished) throw finishError ?? new Error("Disconnect did not finish");
    revalidatePath("/");
    return { ok: true as const };
  } catch { return { ok: false as const, message: "Unable to disconnect Google Calendar." }; }
}
