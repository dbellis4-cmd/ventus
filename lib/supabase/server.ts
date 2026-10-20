import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { requireSupabaseConfig, sessionCookieOptions } from "./config";

// Create a new client for each request; never share user sessions globally.
export async function createClient({ requireCookieWrites = false }: { requireCookieWrites?: boolean } = {}) {
  const { url, publishableKey } = requireSupabaseConfig();
  const cookieStore = await cookies();

  return createServerClient(url, publishableKey, {
    cookieOptions: sessionCookieOptions,
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch (error) {
          // Auth actions/callbacks must not report success if session or PKCE
          // cookies were lost. Only read-only rendering may suppress this error.
          if (requireCookieWrites) throw error;
          // Server Components cannot write cookies. The proxy refreshes them
          // before rendering; Server Actions and Route Handlers can write here.
        }
      },
    },
  });
}
