# Ventus — Handoff

**Updated:** October 21, 2026, America/Phoenix.

## Current state

Milestone 4 recurrence and scheduling is complete in the application and database. The three forward-only Milestone 4 migrations (`20261020000100`, `20261021000100`, `20261022000100`) have already been applied to hosted Supabase project `dxplprepnfuvfpqmmslf`, branch `main`. Their source hashes match the reviewed, tested, and hosted-recorded versions. Milestone 4 source and tests are finalized on Git `main`; the application has **not** been deployed. Do not reapply the migrations.

## What Milestone 4 delivers

- Bounded daily, weekly, monthly, yearly, and selected-weekday recurrence generation; versioned series rules; stable occurrence keys; persisted exceptions and activity history; future-series and individual-occurrence actions. No `rrule.js` dependency.
- Repeated dated subtask templates, category inheritance, DST gap/fold validation, authenticated ownership checks, restricted RPCs, RLS, root locks, version checks, and rollback on rejected writes.
- Parent postponement and date edits shift open child schedules atomically. Closed children retain historical dates; recurring changes affect the selected occurrence unless a future-series action is chosen.
- The Dashboard groups same-date subtasks under their parent, retains cross-date parent references, and reads generated and stored occurrences through bounded pages. The Today backlog skips sparse one-time history and makes one bounded server request per click.

## Verification and limits

Final local checks passed: lint, typecheck, 17 Auth tests, 58 task tests, six isolated Playwright tests, the disposable local Supabase recurrence/security suite, and the Webpack production build. The browser fixture uses mock Supabase responses; the database suite uses a disposable local stack. The pre-Milestone 4 132-assertion suite passed against its original five-table schema; it is not compatible with the added revision table. Populated local upgrade checks preserved existing Auth and task data.

Hosted migration postflight previously matched all five migration entries, affected RPCs, forced RLS/policies, permissions, constraints, and unchanged Auth/application row fingerprints. Authenticated read-only hosted queries returned unique owner-visible occurrences across bounded pages. A private pre-migration backup outside Git passed isolated restore and count/fingerprint comparison. The scoped archive omits ownership/grants; full Supabase service recovery remains unverified. No hosted task data or schema was changed during finalization, and no hosted end-to-end browser verification is claimed for the undeployed application.

A fully closed recurring series can still offer bounded empty backlog pages. An exact virtual-occurrence eligibility query may be worthwhile if this becomes noticeable in use. Default Turbopack remains blocked by local worker-port permissions; Webpack builds pass. Password recovery still awaits owner verification.

## Next milestone

Milestone 5 is Google Calendar outbound synchronization planning and implementation, subject to separate scope and approval. Resolve Calendar event mapping, deletion, conflict, and authentication decisions before changing code or external services. Do not begin it as part of Milestone 4 finalization. Keep credentials, private backups, disposable fixtures, and generated output out of Git.
