import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSiteUrl } from "@/lib/auth/site-url";
import { calendarClient, decryptToken, encryptToken, oauthClient, serviceClient } from "@/lib/google/server";
import { syncOwner } from "@/lib/google/sync";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const destination = (notice: string) => {
    const response = NextResponse.redirect(new URL(`/?calendar=${notice}`, getSiteUrl()), 303);
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  };
  const jar = await cookies();
  const saved = jar.get("ventus-google-oauth")?.value;
  jar.set("ventus-google-oauth", "", { path: "/api/google/callback", maxAge: 0 });
  try {
    if (!saved || request.nextUrl.searchParams.has("error")) return destination("failed");
    const pending = JSON.parse(decryptToken(saved)) as { state: string; codeVerifier: string; userId: string };
    const code = request.nextUrl.searchParams.get("code");
    if (!code || code.length > 2048 || request.nextUrl.searchParams.get("state") !== pending.state) return destination("failed");
    const userClient = await createClient({ requireCookieWrites: true });
    const { data: { user }, error } = await userClient.auth.getUser();
    if (error || !user || user.id !== pending.userId) return destination("failed");
    const auth = oauthClient();
    const token = await auth.getToken({ code, codeVerifier: pending.codeVerifier });
    const audience = process.env.GOOGLE_CLIENT_ID;
    if (!token.tokens.refresh_token || !token.tokens.id_token || !audience) return destination("failed");
    const identity = await auth.verifyIdToken({ idToken: token.tokens.id_token, audience });
    const googleSub = identity.getPayload()?.sub;
    if (!googleSub) return destination("failed");
    auth.setCredentials(token.tokens);
    const api = calendarClient(auth);
    const db = serviceClient();
    const prior = await db.from("google_calendar_connections").select("calendar_id,generation,lease_until,status,google_sub")
      .eq("owner_id", user.id).maybeSingle();
    if (prior.error) throw prior.error;
    if (prior.data?.status === "disconnecting" ||
      (prior.data?.lease_until && Date.parse(prior.data.lease_until) > Date.now())) return destination("busy");
    if (prior.data?.google_sub && prior.data.google_sub !== googleSub) return destination("switch-account");
    const claimed = await db.from("google_calendar_connections").select("owner_id")
      .eq("google_sub", googleSub).neq("owner_id", user.id).maybeSingle();
    if (claimed.error) throw claimed.error;
    if (claimed.data) return destination("already-connected");
    let calendarId = prior.data?.calendar_id ?? null;
    if (calendarId) {
      try { await api.calendars.get({ calendarId }); }
      catch (reason) {
        if (typeof reason !== "object" || reason === null || !("code" in reason) || Number(reason.code) !== 404) throw reason;
        calendarId = null;
      }
    }
    let createdCalendarId: string | null = null;
    if (!calendarId) {
      const created = await api.calendars.insert({ requestBody: { summary: "Ventus", timeZone: "UTC" } });
      calendarId = created.data.id ?? null;
      createdCalendarId = calendarId;
    }
    if (!calendarId) throw new Error("Google did not return a calendar ID");
    const { error: saveError } = await db.from("google_calendar_connections").upsert({ owner_id: user.id,
      status: "connected", google_sub: googleSub, calendar_id: calendarId,
      refresh_token_ciphertext: encryptToken(token.tokens.refresh_token),
      sync_token: null, generation: (prior.data?.generation ?? 0) + 1, lease_id: null, lease_until: null,
      last_error: null, updated_at: new Date().toISOString() });
    if (saveError) {
      if (saveError.code === "23505") {
        if (createdCalendarId) {
          try { await api.calendars.delete({ calendarId: createdCalendarId }); } catch { /* The orphan has no Ventus link. */ }
        }
        return destination("already-connected");
      }
      throw saveError;
    }
    await syncOwner(user.id, userClient);
    return destination("connected");
  } catch { return destination("failed"); }
}
