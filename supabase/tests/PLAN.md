# Revised database verification plan — local subset executed

**132 assertions passed in a disposable local Supabase/PostgreSQL 17 environment.**
Both migrations were executed locally; no hosted project, production credentials
or real user data was accessed. See [RESULTS.md](RESULTS.md) and `verify_local.py`
for executable coverage. Cases beyond that suite remain pending, especially future
account-endpoint authorization, exhaustive boundaries, performance and backup restore.
Lexical checks alone still do not verify database behavior.

## Review and isolated application gate

1. Review both replacement drafts, SCHEMA.md and OPERATIONS.md; confirm the test
   database has no earlier six-table draft applied. These files are not upgrades.
2. Obtain explicit authorization for a disposable Supabase project/local equivalent.
   Never use the live Ventus database or production identities/data. Confirm PG
   version, exposed schemas, default grants, migration administrator CREATE ROLE,
   membership and function ownership capabilities, and Auth-admin deletion behavior.
3. Only in that authorized disposable environment, apply both migrations in order.
   Record revision/checksums, compile all functions and test clean rollback on failure.
   Verify exactly five core tables, ten public RPCs, no schedule/receipt/reward tables.
4. Create two synthetic test Auth users A/B with approved test credentials. Exercise
   the Data API using the publishable key and each real JWT, plus anonymous requests.
   Never log tokens/passwords; do not use an admin/service key for isolation assertions.
   A privileged observer may inspect metadata/fixture state, not stand in for callers.
5. Record sanitized SQLSTATE/HTTP outcome, row counts, versions and history before
   and after each operation. Ensure a fresh ordinary transaction per API request.
   Use a separate admin client only for the explicitly authorized test-account erase.

## Roles, RLS and protected fields

- Inspect ENABLE/FORCE RLS, owner SELECT policies on all five tables, writer-only
  INSERT/UPDATE policies and INSERT-only history. No authenticated/anon/service_role
  table DML/TRUNCATE/TRIGGER grants, DELETE policies or writer DELETE rights.
- Writer: NOLOGIN/NOINHERIT/NOBYPASSRLS, not a table owner, no API-role membership;
  postgres only explicit migration membership. Public RPC owners are writer,
  search_path empty, row_security on, no PUBLIC/anon/service-role EXECUTE grants.
- Private schema/helpers are inaccessible through API and direct role access.
  Inspect the sole postgres-owned definer history trigger: only Auth-owner absence
  permits DELETE, UPDATE always rejects, no public call or general purge path.
- Anon cannot read/count/write any table or invoke an RPC. Authenticated null UID,
  forged/expired JWT and missing settings fail closed.
- A can SELECT A records/history/tombstones; B can SELECT B. Cross-owner guessed
  UUIDs, joins, counts, filters and pagination never expose the other user's data.
- Both users' direct DML against own or foreign rows fails. Exercise every public
  RPC positively for A and B and negatively using each foreign category/task/parent
  occurrence/root UUID. Wrong-owner and nonexistent targets have equivalent errors.
- Try extra/protected JSON fields: owner, parent reassignment, id, status, versions
  to write, original slot/zone, timestamps, snapshot, seed key, history, XP/rewards.
  They must reject atomically, never silently populate a row. Recurrence/RRULE keys
  explicitly reject with unsupported-feature behavior, even if their value is null.
- A controlled disposable writer harness tests composite FK rejection at commit,
  immutable fields, timezone/original guards, unique keys and append-only history.
  Remove any harness immediately; never create an exposed production test function.

## Initialization, categories and scheduling

- Concurrent/repeated initialization yields one settings row and exactly: Classes,
  Meetings, Assignments, Professional Events, Social Events, Personal Tasks,
  Miscellaneous. Verify seed keys, PRD calendar defaults and review behavior mapping.
  Rename/archive defaults and retry; nothing resets or duplicates. Bad zone/failure
  rolls the entire initialization back and does not impair Auth registration.
- Create/rename custom categories; test blank/long names, case-insensitive active
  uniqueness, stale versions, archive and unarchive name collision. New assignment
  to archived categories fails; existing assigned tasks remain editable/completable.
  Renaming/archiving never rewrites existing occurrence or activity snapshots.
- Validate UTC, America/Phoenix, DST zone and non-hour offset. Reject abbreviations,
  POSIX/right variants, unknown/null zones, invalid dates, infinity and 24:00 local
  times. Settings timezone changes leave all original/current occurrence slots intact.
- Anytime date/zone has null times/instants, never UTC midnight. Timed starts/ends
  require matching explicit-offset instants, complete pairs and end after start.
  Test overnight dates, leap day, spring DST gaps, both fall-fold offsets, missing
  offset and local/UTC mismatch. A fold resolves only by an explicit chosen offset;
  the future UI must ask rather than silently choose. Repeat with a different DB
  session timezone to prove input interpretation does not depend on it.

## Task lifecycle and atomic history

- Create a root with nested, independently dated subtasks; verify exactly one
  definition/once occurrence/created event each, matching owned parent occurrences.
  Active-parent/depth checks reject cycles, reassignment, missing/deleted parents,
  depth >10 and cross-owner references. Completing all children never completes parent.
- For every operation compare original date/local times/zone/UTC instants and
  immutable `once` identity; edits and postponement change only current fields.
- `edit_task_tree`: existing root/child patches plus new dated children and explicit
  removals all commit or all roll back. Omitted children persist. Reject duplicate
  edits, overlapping deletion branches, edits/additions inside removed branches,
  unrelated roots, closed definition edits and stale root/target versions.
- Exercise complete → correct actual timestamp → reopen → edit → complete on eligible
  fixtures. Retain every historical completion and correction. Recording time comes
  from DB; actual time may be earlier but never future/nonfinite. Closed snapshots
  remain fixed. Same desired completion state/time with current versions is a no-op.
- Postpone open tasks repeatedly without creating another occurrence or replacing
  original deadlines/zones. Cancel open tasks with/without a reason; retain slots
  and no completion credit. Reject completing/reopening canceled tasks and editing
  deleted tasks. No automatic child cancellation or parent completion.
- Soft-delete a subtree deepest first. Every active descendant is hidden together;
  completed/canceled state and history remain. Unrelated branches/users are intact.
  Oversized branches fail without truncation. The current draft has no restore API.
- Each target mutation advances definition and occurrence version and adds exactly
  one event for that occurrence/version. A descendant mutation advances root version
  once as metadata; it does not duplicate user activity. Unique event versions reject
  duplicate event insertion. No request/result receipt rows or root-event coupling.
- Inject a failure after each definition/occurrence/child write and before/after
  activity insertion. Failed create/edit/complete/postpone/cancel/delete never leaves
  partial rows, new versions, reserved creation keys or incomplete history.
- Enforce all field/payload/depth/100-node bounds; errors must not return private
  task text or raw database internals through future application error mapping.

## Retries and targeted concurrency (independent real transactions)

- Race identical creation keys for a new root and for the same existing parent.
  Exactly one tree/event set survives, retries return the same IDs/current versions.
  Include lost-response replay, retries after a later edit, and tombstoned targets.
- Same key with changed payload/parent fails without overwriting. Failed transaction
  releases the key. Different keys can legitimately create similar independent tasks.
  No promise of saved response replay. Test concurrent category archive/retry errors.
- Retry existing-record commands with original old versions: conflict/refetch, no
  additional transition or history. Never automatically retry with refreshed versions.
  New children in a mixed edit cannot be duplicated by repeating its old root version.
- Race two edits on the same occurrence: one succeeds, one conflicts. Race root edit
  versus child edit, completion correction versus reopen, and subtree deletion versus
  child insertion/edit. The common root lock plus versions must prevent lost changes
  or live descendants under deleted ancestors. Explicitly test nested subtree deletion.
- Different task roots of the same user, and two different users, must not acquire
  a shared workspace write lock. Initialization/settings/category updates must not
  force task-root serialization. Inspect locks and simulate archive/snapshot contention.
- Verify bounded lock waits/deadlock behavior. No public operation should acquire
  multiple tree roots; errors roll back. Future retry handling keeps original versions.

## Permanent account deletion (destructive fixtures only)

- Ordinary A/B/anon cannot hard-delete settings, tasks, occurrences or history,
  invoke a purge or delete another Auth user. History DELETE while its Auth row
  exists rejects, even in a controlled direct admin-delete-history test.
- With explicitly authorized synthetic A/B fixtures only, use permanent Auth Admin
  deletion for A. Confirm zero A rows in all five tables (including archived seeds,
  tombstones, snapshots, fingerprints and history), and B's rows/versions unchanged.
  Deferred owner-matching FKs must pass at commit regardless of cascade order.
- Verify the history guard sees Auth-owner absence during the actual Auth-admin
  cascade and does not block it. Auth-admin role/schema/function permissions and
  managed Auth cleanup must be tested, not inferred from a postgres-only SQL test.
- Race permanent deletion with creation, completion, edits and initialization.
  All committed personal records must disappear or writes fail; no orphan rows or
  partial erasure. Test rollback if the cascade fails and retry after lost response.
- Reuse A's previously issued unexpired JWT: it must expose no data, cannot recreate
  settings because Auth FK fails, and cannot modify B. Do not claim JWT itself was
  automatically revoked. Test actual Next.js reauthentication/session/origin rules
  when the account-deletion endpoint is later implemented; it does not exist now.
- Before exposing that future endpoint, test recent reauthentication/MFA, one-time
  session-bound confirmation, CSRF, target-UID tampering, replay, revoked sessions,
  rate limits, failure/retry and cache clearing. Add Storage/Google cleanup then.
- Before real-data reliance, test backup restore in isolation and define how expired
  backups/logs and erasure requests prevent restoration of erased personal data.
  Current migrations do not promise immediate deletion from provider backups.

## Evidence and release gate

After approved disposable tests pass, record database revision/environment and
results before marking any control Verified in SECURITY.md. Inspect query plans
for owner/day/original-deadline/history/parent lookups and rehearse recovery before
real data. No recurrence, Calendar or reward behavior is verified by these tests.
Password recovery remains **pending manual verification due to Supabase rate
limiting**; this design/test plan cannot close that item or approve deployment.
