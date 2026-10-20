"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export function SessionGuard({ userId, children }: { userId: string; children: React.ReactNode }) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    let checking = false;
    async function verify() {
      if (checking || controller.signal.aborted) return;
      checking = true;
      try {
        const response = await fetch("/auth/session", { cache: "no-store", signal: controller.signal });
        if (response.status === 401) {
          setVisible(false);
          window.location.replace("/login?notice=session-expired");
          return;
        }
        if (!response.ok) { setVisible(false); return; }
        const data = await response.json();
        if (data.userId !== userId) {
          setVisible(false);
          window.location.replace("/");
          return;
        }
        setVisible(true);
      } catch { if (!controller.signal.aborted) setVisible(false); }
      finally { checking = false; }
    }
    function visibility() {
      if (document.visibilityState === "hidden") setVisible(false);
      else void verify();
    }
    function storage(event: StorageEvent) {
      if (event.key === "ventus-auth-event") { setVisible(false); void verify(); }
    }
    function pageShow(event: PageTransitionEvent) {
      if (event.persisted) void verify();
    }
    function pageHide() { setVisible(false); }
    const supabase = createClient();
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") void verify();
    });
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("focus", verify);
    window.addEventListener("storage", storage);
    window.addEventListener("pageshow", pageShow);
    window.addEventListener("pagehide", pageHide);
    const interval = window.setInterval(() => { if (document.visibilityState === "visible") void verify(); }, 60_000);
    return () => {
      controller.abort();
      subscription.unsubscribe();
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("focus", verify);
      window.removeEventListener("storage", storage);
      window.removeEventListener("pageshow", pageShow);
      window.removeEventListener("pagehide", pageHide);
    };
  }, [userId]);

  return <><div hidden={!visible}>{children}</div>{!visible && <main className="loading-shell" role="status"><p>Verifying your session…</p><button className="button secondary" onClick={() => window.location.reload()}>Retry</button></main>}</>;
}
