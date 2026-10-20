# Ventus — Project Status

**Updated:** October 19, 2026, America/Phoenix (October 20 UTC).
**Current work:** Milestone 3 database foundation is applied; dashboard persistence integration remains unfinished.
**Overall:** Product Phase 1 is in progress. No public application deployment or release readiness is claimed.

## Implementation and verification

| Area | Implementation | Automated or structural evidence | Manual verification |
|---|---|---|---|
| Milestone 1: Interactive dashboard | Completed as an in-memory demo: Sunday–Saturday navigation, scheduled/anytime/overdue sections, create/edit modal, dated subtasks, completion/reopening, postponement, cancellation, deletion. Recent UI refinements and optional end time are present. Changes reset on reload. | Milestone committed as `2a66cac`; subsequent local lint/typecheck/build checks passed in the recorded database verification run. | Browser refinement requests are reflected in current code; no new UI verification performed for this documentation task. |
| Milestone 2: Authentication | Signup, login, logout, password-recovery implementation, SSR sessions/callbacks and server-protected `/` Dashboard exist. Recovery fixes are preserved. | All 16 authentication tests and lint/typecheck/build passed in the last recorded local verification run. Mocked recovery tests are not a successful emailed recovery flow. | Owner reported registration, login, logout and protected Dashboard access passed. **Password recovery awaits successful manual verification due to Supabase rate limiting; not passed.** |
| Milestone 3: Database foundation | Both hosted migrations succeeded. Five tables, integrity triggers, ownership RLS and nonrecurring RPCs exist. | **132 executable assertions passed locally**, zero failures. Hosted read-only structural checks passed for tables, functions, RLS, permissions, constraints, indexes, triggers and migration history. | **Hosted user-level database behavior has not been tested.** No hosted test users or task data were created during application/verification. |
| Persistent task application integration | **Unfinished.** Dashboard uses `useState(sampleTasks(today))`; no task storage calls or task Server Actions exist. | No integrated persistence tests yet. | No reload persistence or application-level two-user task isolation verification yet. |
| Later Phase 1 / Phase 2 | Recurrence, Calendar synchronization and release hardening remain unfinished; gamification is deferred. Settings UI is a placeholder. | No verification claimed for these features. | Pending. |

Evidence: [local results](supabase/tests/RESULTS.md), [test harness](supabase/tests/verify_local.py), [verification plan](supabase/tests/PLAN.md), existing code and Git history. The local database suite is prior runtime evidence. Finalization reruns documentation/static checks, lint, typecheck, build and authentication regressions; see the finalization results below. No SQL is executed during finalization.

## Git snapshot

- Branch: `main`; foundation commit **`de53f0dc1b1909a12cd41d548c9ffe2354de23ba`** — `feat: establish secure task database foundation`.
- The foundation commit was pushed successfully to [origin/main](https://github.com/dbellis4-cmd/ventus). The working tree was clean immediately after that push; a documentation-only follow-up records this identifier and finalization results in the context files. Check actual HEAD/Git status rather than assuming this foundation identifier is the latest documentation commit.
- Prior milestones: `9f0e2cc` — authentication; `2a66cac` — interactive dashboard; `77612b1` — initial application.
- The foundation commit includes both unchanged migrations, the isolated verification harness/reports, schema/operation/test documentation, security/architecture/context updates and the previously approved Supabase CLI development dependency/lockfile. The database foundation is now preserved in Git; no application feature changes are included.
- `.env.local` exists and remains ignored; credentials, temporary CLI/status files, fixture data, dependencies and build artifacts were excluded. Required public configuration names: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.
- Finalization performed no SQL, Supabase settings changes, dependency installation or deployment. Synchronization of the subsequent documentation checkpoint is verified before ending the conversation.

## Hosted database record

Target: Ventus development project `dxplprepnfuvfpqmmslf`, branch `main`, PostgreSQL 17.11. Application was explicitly approved in the preceding conversation. **Do not reapply or reset these migrations.** No Supabase access occurred for this status update.

| Applied order / version | File | SHA-256 of locally tested and hosted-recorded source |
|---|---|---|
| 1 / `20261019000100` | `supabase/migrations/20261019000100_task_schema_and_rls.sql` | `6333ac013e1937239aba80bc72d4b7fa9fa1eb5148572e98688841d3690e88c8` |
| 2 / `20261019000200` | `supabase/migrations/20261019000200_workspace_initialization.sql` | `e85ae57dd75845770de7eb8b4a075294abe4ae24a9f3cdbd9a53a16af1f6d2f6` |

Both history entries committed atomically with their respective migration. Standard `supabase_migrations.schema_migrations` metadata was initialized with API access revoked and RLS enabled. Stored source hashes matched both unchanged local files.

Hosted catalog verification recorded at **2026-10-20T03:53:32.949Z** found no failures: five tables with ENABLE/FORCE RLS, 14 ownership policies, ten public RPCs, 21 private functions, 20 valid indexes and seven enabled integrity triggers. The NOLOGIN/NOINHERIT/NOBYPASSRLS writer is separate from table ownership; API roles have no writer membership. Authenticated users have owner-filtered SELECT and restricted public RPC execution, with no direct table mutation rights. Private helpers and the migration ledger are inaccessible to API roles. Constraints were validated, including account cascades and occurrence/history uniqueness.

These are **hosted structural results**, not hosted behavioral tests. The local suite separately exercised anonymous/two-user isolation, lifecycle RPCs, rollback, history, duplicate prevention, concurrency, DST and disposable account erasure. Its temporary stack and fixture data were discarded. The durable [hosted report](supabase/tests/HOSTED_RESULTS.md) records the prior-session catalog findings without credentials or task data. Temporary evidence artifacts are not committed.

## Approved decisions to preserve

- Five core tables: `user_settings`, `categories`, `tasks`, `task_occurrences`, `task_activity`. Owner-matching relationships and strict RLS isolate users.
- Restricted writer role and narrow authorized RPCs perform atomic task/subtask writes with append-only history. Targeted hierarchy-root/occurrence locks and expected versions protect concurrency. Creation keys/fingerprints and occurrence uniqueness prevent repeated effects; no command-receipt replay framework.
- Original and current scheduling live on stable occurrences. Actual completion timestamps and recording timestamps remain distinct; reopening/corrections preserve prior events. Completing subtasks never automatically completes their parent.
- Default category names: Classes, Meetings, Assignments, Professional Events, Social Events, Personal Tasks, Miscellaneous. Custom categories can be created/renamed/archived; snapshots preserve historical category information. Lazy `initialize_workspace(timezone)` initializes settings/defaults once.
- Individual task deletion is soft deletion. Permanent account deletion must securely erase associated personal data through a future explicit server-only workflow; database cascades are implemented, but no deletion interface/endpoint exists.
- User-selected IANA zones; anytime tasks are local dates without fake midnight instants. Preserve original slots; account-zone changes do not move existing schedules. Reject DST gaps and explicitly resolve ambiguous offsets.
- Standard Supabase SSR sessions permit browser-side user-session tokens. Privileged credentials and Google OAuth tokens stay server-only. Normal task requests must use the verified user's session, never an elevated key.
- Recurrence operations are explicitly rejected until Milestone 4. Separate schedule revisions, complex response replay and gamification infrastructure are deferred.

## Outstanding issues and pending decisions

- Password recovery still needs successful manual verification; expiry/refresh, revocation, multi-tab/cache behavior and production session security require further evidence.
- Last recorded audit: five high development-chain package findings; production-only audit reported zero. This is dated evidence, not a fresh audit or proof of safety. Compatible remediation remains unresolved.
- Rate limiting/bot protection, production headers/HTTPS verification, monitoring/incident response, backup retention/recovery targets and restore rehearsal remain release gates. No public release approval exists.
- Review category behavior defaults (fixed/deadline/flexible) and operational bounds: 64 KiB creation/edit payloads, 100 changed nodes, ten hierarchy edges. These implemented database limits are not new product approvals.
- Decide anytime overdue cutoffs, flexible-task rollover/collisions, recurrence/series/subtask semantics, cancellation reversal, overnight scheduling UI/duration and account-erasure reauthentication/retention details before exposing those behaviors. Current RPCs do not support uncancel or soft-delete restoration.
- Demo category IDs/labels, browser-local dates, mutable task shape and destructive in-memory deletion do not match persistent UUIDs, selected zones, immutable originals and soft-deletion contracts. The modal offers recurrence and only same-day ends; do not silently persist unsupported recurrence or reinterpret times.
- Calendar scopes/mapping/conflicts/freshness, hosting budget and Phase 2 scoring remain separate later decisions.

## Next objective: complete Milestone 3 application persistence

Connect the existing Dashboard to persistent Supabase task storage while preserving the approved UI, isolation and history. This completes the persistence portion of Milestone 3; it does **not** begin Milestone 4 recurrence.

Acceptance criteria for that work:

1. Verify the server session, initialize owned settings/default categories idempotently with an explicit selected zone, and load authorized day/week task projections. Show a real empty state rather than inserting demo fixtures.
2. Map persistent UUIDs, categories, occurrence/root versions and schedules into the existing UI. Support nonrecurring create/edit, dated subtasks, completion/reopening/correction, postponement, cancellation and subtree soft deletion through the approved RPCs.
3. Enforce server validation and origin/CSRF checks; reject protected fields and unsupported recurrence. Preserve form input on failures and show safe authorization, validation and conflict errors.
4. Preserve original deadlines, occurrence identities, category snapshots and append-only completion/activity history. Atomic failures leave no partial tree/history; stale writes require refetch, never automatic retries with fresh versions. Reuse creation keys for uncertain retries.
5. Show saved changes after reload and a fresh session. Verify anonymous denial and two-user isolation through the application, including tampered references, logout/caching, retry/concurrency and rollback cases. Record the environment and distinguish local tests from any separately authorized hosted tests.
6. Test selected-zone date boundaries and explicit DST handling; preserve dashboard design/accessibility. Resolve relevant product ambiguities rather than invent behavior. Run lint, typecheck, build, auth regressions and new persistence tests; update status/handoff with actual results.

## Documentation alignment and finalization

- `ARCHITECTURE.md`, `SECURITY.md`, `supabase/SCHEMA.md` and `supabase/OPERATIONS.md` now reflect the approved five-table foundation and hosted application. Local behavior and hosted structural evidence remain separate; security release gates remain open.
- [Hosted results](supabase/tests/HOSTED_RESULTS.md) preserve the previous session's catalog findings in the repository. No Supabase access or SQL execution is part of this finalization.
- Applied migration comments still say draft/never hosted. They are historical and deliberately unchanged to preserve tested source hashes; do not infer a need to apply them again.
- The local report's hosted-untouched statements describe that earlier isolated run; a new cross-reference points to the subsequent hosted results. The verification plan includes future cases beyond the passing local subset.
- PRD category names remain illustrative; later approved exact defaults above govern initialization. The existing fixture UI differs from persistent contracts as noted under outstanding issues.

Finalization checks (October 19 America/Phoenix / October 20 UTC):

- Documentation whitespace, local links and source consistency checks passed; Python AST parsing and dependency-free SQL lexical/security inventory passed. These execute no SQL.
- `npm run lint`, `npm run typecheck` and all 16 `npm run test:auth` tests passed.
- `npm run build` failed on Turbopack worker-port binding (`Operation not permitted`), including an escalated retry. `npm run build -- --webpack` passed. Builds used a clean inherited environment, disabled telemetry and loopback Supabase placeholders; no application/config workaround was committed. The default build is not marked passed for this finalization.
- Migration hashes still match both local runtime evidence and hosted-recorded source. The 132 database assertions are prior evidence, not rerun; no SQL or Supabase operation occurred.
- Limited credential-pattern scan of all 52 then-tracked/pending source files passed. Ignore checks exclude `.env.local`, dependencies/build output, secret paths, bytecode and CLI caches. No temporary evidence, generated data, credentials or application-feature changes are included.
- Lockfile review: 15 added development-only package entries for the approved Supabase CLI; existing package entries unchanged. No new install or dependency remediation was performed.
- Fresh `git fetch origin main` succeeded; pre-finalization HEAD matched the fetched branch. Foundation commit `de53f0dc1b1909a12cd41d548c9ffe2354de23ba` then pushed successfully; the context-only checkpoint records that published identifier without changing migrations or application files.

Unresolved default Turbopack environment failure, password recovery, hosted user-level tests, application persistence and all other release gates above remain open.
