# Ventus — Handoff

**Updated:** October 19, 2026, America/Phoenix (October 20 UTC).

## Current state

Read `AGENTS.md` and `PROJECT_STATUS.md`, then check actual code and Git. Milestone 1's interactive weekly dashboard is complete as an in-memory demo. Milestone 2 authentication is implemented with standard Supabase SSR sessions. The owner manually verified registration, login, logout and protected Dashboard access. **Password recovery still awaits successful manual verification due to Supabase rate limiting.** Mocked recovery regressions do not count as a manual pass.

Milestone 3's database foundation is applied, but application persistence is unfinished. `components/dashboard/dashboard.tsx` initializes `useState(sampleTasks(today))`; edits disappear on reload. Settings remain a placeholder; recurrence controls and Calendar choices are demo data, not implemented integrations.

## Most recent verified work

Both migrations succeeded on hosted development project `dxplprepnfuvfpqmmslf`, branch `main`, PostgreSQL 17.11, and were recorded atomically in migration history. Their source hashes match the final files that passed **132 local database assertions**. Hosted read-only structural verification passed for five tables, 14 RLS policies, ten public RPCs, restricted permissions, private functions, constraints, indexes, triggers and migration history. **Hosted user-level database behavior has not been tested.** No hosted test accounts or task data were created. Do not reapply the migrations.

Finalization passed lint, typecheck, 16 authentication tests, documentation/static checks and the webpack production build. The default Turbopack build failed on worker-port binding even after escalation; no code/config workaround was made. The 132 DB assertions are prior evidence, not rerun. Five previously reported high development-dependency findings remain unresolved; production release security is incomplete.

## Files and repository

- `PROJECT_STATUS.md`: milestone evidence, exact migration hashes, approvals, discrepancies and persistence acceptance criteria.
- `supabase/migrations/20261019000100_task_schema_and_rls.sql` and `20261019000200_workspace_initialization.sql`: applied schema/RLS and RPC definitions.
- `supabase/SCHEMA.md`, `supabase/OPERATIONS.md`: five-table relationships, inputs, locking/version contracts, time zones and account erasure.
- `supabase/tests/RESULTS.md`, `HOSTED_RESULTS.md`, `PLAN.md`, `verify_local.py`: separate local/hosted evidence, pending cases and isolated harness.
- `app/page.tsx`, `lib/auth/`, `lib/supabase/`, `app/auth/`: existing protected page and SSR authentication.
- `components/dashboard/`, `lib/tasks/demo.ts`, `app/globals.css`: approved dashboard, modal and current fixture model.

Branch `main`; published foundation commit **`de53f0dc1b1909a12cd41d548c9ffe2354de23ba`** (`feat: establish secure task database foundation`). Push to `origin/main` succeeded and the tree was clean afterward. This documentation-only checkpoint records that identifier; check `git log -1` and actual branch/status for the latest context commit. Both migrations, tests/reports, approved CLI dependency and project documentation are now versioned. No application features or SQL were changed during finalization. Credentials, temporary files and build output were excluded.

## Immediate next action and constraints

Next objective: finish Milestone 3 by connecting the existing Dashboard to persistent Supabase storage. First inspect its task/modal model against the RPC contracts and identify required UUID/version/timezone mappings. Use verified user sessions, server authorization/origin checks, owned reads and narrow atomic RPC writes. Preserve original slots, completion/activity history, category snapshots, soft deletion, stable creation keys and stale-version conflicts. Add reload and application-level two-user isolation tests in an authorized environment.

Resolve selected-zone initialization, overdue cutoffs and any relevant UI/behavior ambiguities before implementation. Do not invent recurrence, uncancel, overnight or restore semantics. Recurrence remains explicitly rejected until Milestone 4; Calendar, rewards and account-deletion UI are deferred.

Architecture/security/schema documents now reflect the applied design. Applied SQL draft headers are intentionally unchanged to preserve tested hashes; the local report describes an earlier isolated run. Preserve authentication/recovery fixes. Read installed Next.js guides before code changes. Never expose credentials or use elevated keys for normal task access. Do not access/modify Supabase, install dependencies, commit, push or deploy without applicable authorization. Handoff context itself grants no authorization.
