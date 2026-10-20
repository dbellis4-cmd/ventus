import "server-only";

import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseConfig, sessionCookieOptions } from "./config";

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });
  response.headers.set("Cache-Control", "private, no-store");
  const config = getSupabaseConfig();

  // Missing configuration never bypasses the page/action authorization checks.
  if (!config) return response;

  const supabase = createServerClient(config.url, config.publishableKey, {
    cookieOptions: sessionCookieOptions,
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        cookiesToSet.forEach(({ name, value }) => {
          request.cookies.set(name, value);
        });

        // Rebuild forwarded request cookies without losing earlier cookie writes
        // or cache headers if the SDK invokes setAll more than once.
        const previousResponse = response;
        response = NextResponse.next({ request });
        previousResponse.cookies.getAll().forEach((cookie) => {
          response.cookies.set(cookie);
        });
        for (const name of ["cache-control", "expires", "pragma"]) {
          const value = previousResponse.headers.get(name);
          if (value) response.headers.set(name, value);
        }

        cookiesToSet.forEach(({ name, value, options }) => {
          response.cookies.set(name, value, options);
        });
        Object.entries(headers).forEach(([name, value]) => {
          response.headers.set(name, value);
        });
      },
    },
  });

  // Verify the JWT and refresh when needed. Never authorize using getSession().
  // Protected operations must check identity themselves; getUser() is needed
  // where immediate server-side revocation/account-state checks matter.
  try {
    await supabase.auth.getClaims();
  } catch {
    // Protected pages/actions independently verify the user and fail closed.
    // Keep public login/recovery pages reachable during provider outages.
  }

  return response;
}
