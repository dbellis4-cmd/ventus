import "server-only";

import { createClient } from "@/lib/supabase/server";

export async function getVerifiedUser() {
  try {
    const supabase = await createClient();
    // Check with Auth, including server-side session revocation; cookie contents
    // or locally verified claims alone are insufficient for this boundary.
    const { data, error } = await supabase.auth.getUser();
    return error ? null : data.user;
  } catch {
    // Missing configuration or provider outages must never grant access.
    return null;
  }
}
