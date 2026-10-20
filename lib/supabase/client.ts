import { createBrowserClient } from "@supabase/ssr";
import { requireSupabaseConfig, sessionCookieOptions } from "./config";

export function createClient() {
  const { url, publishableKey } = requireSupabaseConfig();

  return createBrowserClient(url, publishableKey, {
    cookieOptions: sessionCookieOptions,
  });
}
