"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { disconnectGoogle, getGoogleStatus, startGoogleConnection, syncGoogleNow } from "@/app/google-actions";

type Status = Awaited<ReturnType<typeof getGoogleStatus>>;

export function CalendarSettings({ initialNotice }: { initialNotice?: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(initialNotice === "connected" ? "Google Calendar connected."
    : initialNotice === "busy" ? "Calendar sync is finishing. Try connecting again shortly."
    : initialNotice === "already-connected" ? "This Google account is already connected to another Ventus account. Please use a different Google account."
    : initialNotice === "switch-account" ? "Disconnect the current Google account before connecting a different one."
    : initialNotice ? "Google Calendar connection did not complete. Try again." : "");
  useEffect(() => { void getGoogleStatus().then(setStatus); }, []);
  async function connect() {
    setBusy(true); setNotice("");
    const result = await startGoogleConnection();
    if (result.ok) window.location.assign(result.url);
    else { setNotice(result.message); setBusy(false); }
  }
  async function disconnect() {
    setBusy(true); setNotice("");
    const result = await disconnectGoogle();
    setNotice(result.ok ? "Google Calendar disconnected. Existing events remain in Google Calendar." : result.message);
    setStatus(await getGoogleStatus()); setBusy(false); router.refresh();
  }
  async function sync() {
    setBusy(true); setNotice("");
    const result = await syncGoogleNow();
    setNotice(result.synced ? "Calendar sync completed." : result.reason === "reauthorize"
      ? "Reconnect Google Calendar to resume syncing." : "Calendar sync is pending. Try again shortly.");
    setStatus(await getGoogleStatus()); setBusy(false); router.refresh();
  }
  return <section className="placeholder-panel" aria-busy={busy}>
    <h2>Google Calendar</h2>
    <p>{status?.status === "connected" ? "Connected to a dedicated Ventus calendar."
      : status?.status === "disconnecting" ? "Google Calendar disconnect needs to finish. Select Disconnect again."
      : status?.status === "reauthorize" ? "Google authorization expired. Reconnect to resume syncing."
      : status?.status === "unavailable" ? status.message
      : status ? "Connect Google Calendar to sync selected tasks." : "Checking calendar connection…"}</p>
    {status?.lastSyncedAt && <p>Last sync: {new Date(status.lastSyncedAt).toLocaleString()}</p>}
    {status?.message && status.status === "connected" && <p role="alert">{status.message}</p>}
    {notice && <p role="status">{notice}</p>}
    {status?.status === "connected" || status?.status === "disconnecting" ? <div className="week-controls">
      {status.status === "connected" && <button className="button secondary" disabled={busy} onClick={() => void sync()}>Sync now</button>}
      <button className="button secondary" disabled={busy} onClick={() => void disconnect()}>Disconnect</button>
    </div> : <button className="button primary" disabled={busy || !status || status.status === "unavailable"}
      onClick={() => void connect()}>Connect Google Calendar</button>}
  </section>;
}
