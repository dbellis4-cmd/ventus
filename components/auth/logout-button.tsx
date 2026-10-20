"use client";

import { useActionState } from "react";
import { logout } from "@/app/auth/actions";
import { type AuthState } from "@/lib/auth/validation";

export function LogoutButton() {
  const [state, action, pending] = useActionState(async (): Promise<AuthState> => {
    const result = await logout();
    if (result.success) {
      try { localStorage.setItem("ventus-auth-event", crypto.randomUUID()); } catch { /* Storage may be disabled. */ }
      // A full navigation discards the client router cache and in-memory tasks.
      window.location.replace("/login?notice=signed-out");
    }
    return result;
  }, {});

  return <form action={action} className="logout-form"><button className="nav-item" type="submit" disabled={pending}>{pending ? "Signing out…" : "Sign out"}</button>{state.error && <p className="form-error" role="alert">{state.error}</p>}</form>;
}
