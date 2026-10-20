"use client";

import { useActionState, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { confirmTimezone } from "@/app/workspace-actions";

const subscribe = () => () => {};
const suggestedZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function TimezoneSetup() {
  const suggestion = useSyncExternalStore(subscribe, suggestedZone, () => "");
  return <TimezoneForm key={suggestion} suggestion={suggestion} />;
}

function TimezoneForm({ suggestion }: { suggestion: string }) {
  const [state, action, pending] = useActionState(confirmTimezone, {});
  const [timezone, setTimezone] = useState(suggestion);
  return <section className="placeholder-panel timezone-setup" aria-labelledby="timezone-heading">
    <h2 id="timezone-heading">Choose Your Workspace Time Zone</h2>
    <form action={action} className="timezone-form">
      <label className="field">Time Zone<input name="timezone" required maxLength={100} value={timezone} onChange={(event) => setTimezone(event.target.value)} placeholder="America/Phoenix" disabled={pending} /></label>
      <button className="button primary" disabled={pending} aria-busy={pending}>Confirm Time Zone</button>
      {state.error && <p role="alert" className="form-error">{state.error}</p>}
      {state.success && <p role="status">Workspace initialized. <Link href="/">Open Dashboard</Link></p>}
    </form>
  </section>;
}
