import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSiteUrl } from "@/lib/auth/site-url";

export const dynamic = "force-dynamic";

function failureNotice(error: { code?: string; name?: string } | null) {
  if (error?.code === "pkce_code_verifier_not_found" || error?.name === "AuthPKCECodeVerifierMissingError" || error?.code === "bad_code_verifier") return "link-verifier-missing";
  if (error?.code === "otp_expired" || error?.code === "flow_state_expired" || error?.code === "flow_state_not_found") return "link-expired";
  return "link-error";
}

export async function GET(request: NextRequest) {
  let origin: string;
  try {
    origin = getSiteUrl();
  } catch {
    return NextResponse.json({ error: "Authentication callback is not configured." }, { status: 503, headers: { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" } });
  }
  const params = request.nextUrl.searchParams;
  const code = params.get("code");
  const tokenHash = params.get("token_hash");
  const type = params.get("type");
  let destination = "/login?notice=link-error";

  try {
    const supabase = await createClient({ requireCookieWrites: true });
    // Only fixed local destinations are accepted. Never reflect next/error URLs.
    if (!params.has("error") && code && code.length <= 2048 && !tokenHash) {
      const { data, error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) destination = `/login?notice=${failureNotice(error)}`;
      else if (data.session) {
        // The SDK derives recovery intent from the PKCE verifier. It remains
        // available even if a template/redirect drops the optional next query.
        // The installed SDK returns this documented runtime field, but its
        // public response type omits it. Guard its presence instead of casting.
        const isRecovery = "redirectType" in data && data.redirectType === "recovery";
        destination = isRecovery || params.get("next") === "/reset-password" ? "/reset-password" : "/";
      }
    } else if (!params.has("error") && tokenHash && tokenHash.length <= 512 && !code && (type === "signup" || type === "recovery")) {
      const { data, error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
      if (error) destination = `/login?notice=${failureNotice(error)}`;
      else if (data.session) destination = type === "recovery" ? "/reset-password" : "/";
    } else if (params.has("error")) {
      destination = `/login?notice=${failureNotice({ code: params.get("error_code") ?? undefined })}`;
    }
  } catch {
    // Never include provider errors, codes, or tokens in the redirect or logs.
  }

  const response = NextResponse.redirect(new URL(destination, origin), 303);
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
