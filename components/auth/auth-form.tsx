"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { authenticate } from "@/app/auth/actions";
import { type AuthMode, type AuthState } from "@/lib/auth/validation";

const copy = {
  login: { title: "Welcome back", description: "Log in to your Ventus workspace.", submit: "Log in", pending: "Logging in…" },
  signup: { title: "Create your account", description: "Sign up for your Ventus workspace.", submit: "Create account", pending: "Creating account…" },
  recovery: { title: "Reset your password", description: "Enter your email and we’ll send you a reset link.", submit: "Send reset link", pending: "Sending…" },
  reset: { title: "Choose a new password", description: "Set a secure password for your account.", submit: "Update password", pending: "Updating…" },
};

export function AuthForm({ mode, notice }: { mode: AuthMode; notice?: string }) {
  const [state, action, pending] = useActionState(authenticate.bind(null, mode), {} as AuthState);
  const [email, setEmail] = useState("");
  const content = copy[mode];
  const newPassword = mode === "signup" || mode === "reset";

  return <>
    <header className="auth-heading"><h1>{content.title}</h1><p>{content.description}</p></header>
    {notice && <p className="auth-notice" role="status">{notice}</p>}
    <form action={action} className="auth-form" aria-busy={pending}>
      {mode !== "reset" && <label className="field" htmlFor="auth-email">Email
        <input id="auth-email" name="email" type="email" autoComplete="email" autoCapitalize="none" spellCheck={false} required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} aria-invalid={!!state.fieldErrors?.email} aria-describedby={state.fieldErrors?.email ? "email-error" : undefined} />
        {state.fieldErrors?.email && <small className="auth-field-error" id="email-error">{state.fieldErrors.email}</small>}
      </label>}
      {mode !== "recovery" && <label className="field" htmlFor="auth-password">{mode === "reset" ? "New password" : "Password"}
        <input id="auth-password" name="password" type="password" autoComplete={newPassword ? "new-password" : "current-password"} required minLength={newPassword ? 12 : 1} maxLength={newPassword ? 128 : 1024} aria-invalid={!!state.fieldErrors?.password} aria-describedby={state.fieldErrors?.password ? "password-error" : newPassword ? "password-help" : undefined} />
        {newPassword && <small id="password-help" className="auth-help">Use at least 12 characters.</small>}
        {state.fieldErrors?.password && <small className="auth-field-error" id="password-error">{state.fieldErrors.password}</small>}
      </label>}
      {newPassword && <label className="field" htmlFor="auth-confirm">Confirm password
        <input id="auth-confirm" name="confirmPassword" type="password" autoComplete="new-password" required minLength={12} maxLength={128} aria-invalid={!!state.fieldErrors?.confirmPassword} aria-describedby={state.fieldErrors?.confirmPassword ? "confirm-error" : undefined} />
        {state.fieldErrors?.confirmPassword && <small className="auth-field-error" id="confirm-error">{state.fieldErrors.confirmPassword}</small>}
      </label>}
      {mode === "login" && <Link className="auth-forgot" href="/forgot-password">Forgot password?</Link>}
      {state.error && <p className="form-error" role="alert">{state.error}</p>}
      {state.fieldErrors && <p className="sr-only" role="alert">Please correct the highlighted fields.</p>}
      {state.message && <p className="auth-notice" role="status">{state.message}</p>}
      <button className="button primary auth-submit" type="submit" disabled={pending}>{pending ? content.pending : content.submit}</button>
    </form>
    <p className="auth-switch">{mode === "login" ? <>New to Ventus? <Link href="/signup">Create an account</Link></> : mode === "signup" ? <>Already have an account? <Link href="/login">Log in</Link></> : <Link href="/login">Back to login</Link>}</p>
  </>;
}
