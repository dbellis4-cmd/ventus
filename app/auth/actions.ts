"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSiteUrl } from "@/lib/auth/site-url";
import { authErrorMessage, validateAuthForm, type AuthMode, type AuthState } from "@/lib/auth/validation";

export async function authenticate(mode: AuthMode, _previous: AuthState, form: FormData): Promise<AuthState> {
  if (!["login", "signup", "recovery", "reset"].includes(mode) || !(form instanceof FormData)) return { error: "Invalid authentication request." };
  const { email, password, fieldErrors, valid } = validateAuthForm(mode, form);
  if (!valid) return { fieldErrors };

  try {
    const supabase = await createClient({ requireCookieWrites: true });
    if (mode === "login") {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error || !data.session) return { error: authErrorMessage(error?.code, mode) };
    } else if (mode === "signup") {
      const { data, error } = await supabase.auth.signUp({
        email, password,
        options: { emailRedirectTo: `${getSiteUrl()}/auth/callback` },
      });
      if (error && error.code !== "user_already_exists") return { error: authErrorMessage(error.code, mode) };
      if (!data.session) return { message: "If this address can be registered, check your inbox for a confirmation link. If you already have an account, log in instead." };
    } else if (mode === "recovery") {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${getSiteUrl()}/auth/callback?next=/reset-password`,
      });
      if (error && error.code !== "user_not_found") return { error: authErrorMessage(error.code, mode) };
      return { message: "If an account exists for that email address, you’ll receive a password reset link. Check your inbox and spam folder." };
    } else {
      // Every password mutation verifies identity again, independently of the page.
      const { data, error: userError } = await supabase.auth.getUser();
      if (userError || !data.user) return { error: "Your recovery session has expired. Request a new password reset link." };
      const { error } = await supabase.auth.updateUser({ password });
      if (error) return { error: authErrorMessage(error.code, mode) };
      const { error: signOutError } = await supabase.auth.signOut({ scope: "local" });
      if (signOutError) return { error: "Your password was updated, but sign-out failed. Please sign out before logging in with your new password." };
    }
  } catch {
    return { error: "Authentication is temporarily unavailable. Please try again shortly." };
  }

  // Redirect throws internally; keep it outside the provider error handler.
  revalidatePath("/", "layout");
  redirect(mode === "reset" ? "/login?notice=password-updated" : "/");
}

export async function logout(): Promise<AuthState> {
  try {
    const supabase = await createClient({ requireCookieWrites: true });
    const { error } = await supabase.auth.signOut({ scope: "local" });
    if (error) return { error: "Unable to sign out. Please try again; your session has not been cleared." };
  } catch {
    return { error: "Unable to sign out. Check your connection and try again." };
  }
  revalidatePath("/", "layout");
  return { success: true };
}
