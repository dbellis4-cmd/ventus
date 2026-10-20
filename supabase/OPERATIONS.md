# Milestone 3 — atomic write contracts and account erasure

**Nonrecurring RPCs applied to hosted development after local verification.**
The 132-assertion local subset passed; hosted catalog checks passed separately.
See [local coverage](tests/RESULTS.md) and [hosted evidence](tests/HOSTED_RESULTS.md).
Hosted user-level behavior has not been tested. Application persistence is unfinished.
The second migration's filename includes settings/categories and six task RPCs;
no task HTTP endpoint or account-deletion interface is implemented.

## Common boundary

Normal future Next.js entry points verify the current user and CSRF/origin, then
call RPCs with the user's Supabase JWT. Database functions independently derive
the request UID through a private invoker-only, pre-parsed SQL delegation to
`auth.uid()`, enforce owner predicates/RLS and reject unauthenticated callers.
The helper avoids runtime managed-Auth-schema name resolution; it neither parses
JWTs itself nor runs with elevated privileges. Stored RLS still uses `auth.uid()`.
Never use a service key for normal task reads/writes. User-supplied owner, actor,
versions-to-write, original slots, snapshots, recording times, balances and arbitrary
row fields are unavailable. JSON objects use exact field allowlists; keys mentioning
recurrence/RRULE receive an explicit Milestone 4 unsupported error.

All public functions are SECURITY DEFINER owned by `ventus_writer`, empty search
path, row_security on and qualified static SQL. Only authenticated gets EXECUTE;
PUBLIC/anon/service_role grants are revoked explicitly. Private helpers are invoker
functions inaccessible to API roles. The sole privileged account-erasure trigger
exception is documented in SCHEMA.md; it is not a public RPC.

A task command is one transaction: lock the immutable hierarchy root, check target
versions, apply all state changes and append activity. Any validation, FK, history,
version or trigger error rolls everything back. Functions do not catch/ignore
errors or invoke external services. Missing/foreign targets use the same unavailable
response. Commands affecting one tree never acquire another tree's root lock.

Each state change increments definition and occurrence versions; history is unique
per occurrence/version. A child command also bumps root definition version once;
this is a concurrency marker, not another user action. Destructive tree operations
and mixed edits check the root version so unseen descendant edits cannot be lost.
The root lock also coordinates child insertion with deletion. No workspace-wide
lock is taken for task commands. Category rows are share-locked while assigned or
snapshotted; category mutation never locks task roots.

## Input shapes

A **schedule** object accepts exactly `date`, `timezone`, optional `start_time`,
`starts_at`, `end_date`, `end_time`, `ends_at`. Date strings use YYYY-MM-DD; local
times use 24-hour HH:MM with optional seconds/fractions. Instants use full ISO
YYYY-MM-DDTHH:MM:SS with Z or explicit ±HH:MM offset. Required local/instant pairs
must round-trip to the explicit zone. Anytime uses null/absent time fields. An end
requires all end fields and must follow start. Missing offsets, DST gaps, invalid
zones, incomplete ends and fake midnight anytime instants fail.

A **new task** accepts `title`, `category_id`, `schedule`, optional `location`,
`behavior_override` (fixed/flexible/deadline or null), `calendar_opt_in` (boolean)
and `subtasks` (array of the same new-task shape). Owner/UUID/parent occurrence,
original schedule, versions and timestamps are generated/derived. Category calendar
selection is the default if no override is supplied. All nested children are dated.
A **patch** accepts the same editable fields except `subtasks`; all are optional,
but an empty patch fails. A supplied schedule replaces the whole current slot.
Explicit null clears location/behavior override; title/category/calendar cannot
be null. Edits keep calendar selection unless explicitly changed.

Creation/mixed-edit payloads are at most 64 KiB, at most 100 changed task nodes per
command, and the stored hierarchy has at most ten parent edges. A postponement
schedule is at most 4 KiB. Text bounds: title 240, category 80, location 1000,
cancellation reason 500 characters. Oversized subtree deletion fails atomically;
no truncation. These are proposed operational bounds for review.

## Public RPC definitions

| RPC | Contract |
|---|---|
| `initialize_workspace(p_timezone text)` | Create settings and seven approved defaults atomically once. Settings-row lock only for initialization; later calls preserve renamed/archived defaults and timezone. |
| `update_settings(p_expected_version bigint, p_timezone text, p_appearance text)` | Version-checked owned preference update; returns version. Existing occurrences never move. Appearance: system/light/dark. |
| `create_category(p_name text, p_behavior text, p_calendar_default boolean)` | Create owned custom category; return UUID. Active names unique per owner ignoring case. No client seed key. |
| `update_category(p_category_id uuid, p_expected_version bigint, p_name text, p_behavior text, p_calendar_default boolean, p_archived boolean)` | Version-checked rename/configure/archive/unarchive; return version. Keep historical snapshots; no implicit task rewrite or hard deletion. |
| `create_task(p_creation_key uuid, p_task jsonb, p_parent_task_id uuid default null, p_expected_parent_version bigint default null, p_expected_parent_occurrence_version bigint default null)` | Create one definition/once occurrence/activity plus all nested dated subtasks atomically. Optional existing parent requires current parent versions and the same hierarchy-root lock. Return IDs/versions, root version and `created`. |
| `edit_task_tree(p_root_task_id uuid, p_expected_root_version bigint, p_edits jsonb, p_new_subtasks jsonb default [], p_delete_subtasks jsonb default [])` | Apply existing-record patches, create new dated subtrees and explicitly soft-delete subtrees together. One owned hierarchy only; check all preconditions before changes. Return root IDs/versions, new top-node IDs and changed node count. |
| `set_task_completion(p_task_id uuid, p_expected_task_version bigint, p_expected_occurrence_version bigint, p_completed boolean, p_actual_completed_at timestamptz default null)` | Open → completed, completed timestamp correction, or completed → open. Reject canceled/deleted targets and future/nonfinite actual times. Default actual time is server now on first completion; omitted time preserves an existing completion. Reopen cannot supply actual time. Same desired state/time is a no-op with current versions. Never infer parent completion. |
| `postpone_task(p_task_id uuid, p_expected_task_version bigint, p_expected_occurrence_version bigint, p_schedule jsonb)` | Open, active occurrence only. Replace current slot, retain original slot/identity/category snapshot and append before/after history. No replacement occurrence or revision table. |
| `cancel_task(p_task_id uuid, p_expected_task_version bigint, p_expected_occurrence_version bigint, p_reason text default null)` | Open → canceled, server cancellation time and optional bounded reason. No credit or implicit child cancellation. No uncancel transition in this milestone. |
| `soft_delete_task(p_task_id uuid, p_expected_task_version bigint, p_expected_occurrence_version bigint, p_expected_root_version bigint)` | Soft-delete selected definition and active descendant definitions/occurrences deepest first in one transaction. Root version guards all descendant changes. Preserve statuses, completion, original slots and history; no restore/hard delete. |

For `edit_task_tree`:

- Each `p_edits` item has exactly `task_id`, `task_version`, `occurrence_version`,
  `patch`. Definition/schedule edits require an open occurrence.
- Each `p_new_subtasks` item has exactly `parent_task_id`, `task` (new-task shape).
  Parent must already be an active member of this hierarchy; newly created nodes
  can have their own nested children in `task.subtasks`.
- Each `p_delete_subtasks` item has exactly `task_id`, `task_version`,
  `occurrence_version`. Root deletion uses `soft_delete_task` instead.
- Duplicate edits, overlapping removal branches, editing a removed descendant,
  and adding under a removed parent fail. Omitted children remain unchanged.
- The observed root version covers descendant changes even when a branch is
  deleted without listing every descendant version. Concurrent root/child writes
  invalidate the whole command; never silently overwrite.

## Creation retries and optimistic concurrency

A unique `(owner_id, creation_key)` claims a creation before descendants/history
are written. An immutable SHA-256 fingerprint covers the JSONB task input and
existing parent ID (not changing expected versions). Same-key/different-input
reuse fails. An identical retry returns the same task/occurrence IDs and **current**
versions, not a saved response; it does not reset edited values, restore tombstones
or recreate archived/deleted children. A concurrent retry is coordinated by the
unique constraint, with a second key lookup after waiting for an existing-parent
root lock. Missing archived categories may cause a concurrent creation retry to
fail validation; this still cannot duplicate data. The caller can refetch/retry
with the original key. A failed transaction reserves no key.

For all other writes, retain original expected versions on retry. A committed
write makes a repeated old-version request fail with SQLSTATE `40001`; refetch
and show the current state. Do not automatically reuse the new version to repeat
the old intention. Existing-record retries do not promise response replay. New
children inside a mixed edit are protected by that root version precondition.
Occurrence uniqueness and unique occurrence/version history prevent duplication.
There are no command receipt rows, indexes, stored response payloads or generic
replay protocol. Future Calendar jobs must design their own durable external-effect
idempotency when introduced.

## Proposed permanent account-deletion workflow (no interface implemented)

1. A future protected POST/Server Action verifies the user with Supabase Auth,
   requires explicit destructive confirmation and recent password reauthentication
   (and MFA when configured). Set a freshness threshold and bind any confirmation
   to the same session/UID, with expiry and one-time use. Apply origin/CSRF checks
   and rate limits. A valid older JWT alone is insufficient.
2. Derive the target UID exclusively from that verified identity. Never accept an
   arbitrary browser target UID, admin credential or confirmation flag as proof
   of authorization. Protect against cross-user deletion, replay and revoked sessions.
3. Revoke refresh sessions and clear local cookies. Before Auth erasure, perform
   any required Google grant/token and Storage cleanup if those features exist.
   They are absent now; future tables must join this erasure design. Supabase
   Storage ownership can block Auth deletion and must be covered then.
4. A server-only admin client calls Supabase Auth Admin `deleteUser` with permanent
   deletion (`shouldSoftDelete=false`). No application-user SQL deletion function
   is exposed. The Auth user's deletion cascades to settings and all owned rows;
   deferred composite references are satisfied at commit. The private history
   guard permits deletion only when the Auth owner is absent in that transaction.
   It never permits an ordinary history purge while the account exists.
5. Verify success through the trusted server. On timeout, retry/check the same
   verified target server-side; do not claim erasure or re-create the account.
   On failure, retain data consistently and report an actionable safe error.
   Session revocation and Auth deletion are separate service operations: no claim
   of distributed atomicity. A failed deletion may leave the user signed out.
6. An unexpired JWT can remain cryptographically valid after Auth deletion. Owned
   rows are gone; RLS cannot expose another user's rows, and settings' Auth FK
   prevents orphan reinitialization. Still test direct API attempts and clear all
   application/private cache state. Never claim deletion automatically revokes JWTs.
7. Document provider backup/log expiration and a restoration procedure that does
   not resurrect erased accounts/data. Online row erasure is not immediate removal
   from existing backups or external systems. Pick retention, verification and
   privacy-preserving erasure-request tracking before exposing the workflow; no
   retention system is introduced here. Do not store deleted private task content
   in application logs or a new permanent deletion audit.

## Deferred behavior and documentary alignment

All RPCs operate on `once` occurrences. JSON recurrence keys are rejected, no RRULE
columns exist, and a DB CHECK prevents another recurrence identity. Milestone 4
must approve expansion/series edits, subtask recurrence, missed-task collision and
overdue cutoff rules before changing this boundary. Schedule revisions and complex
retry-response replay remain deferred; no gamification infrastructure is added.

The existing standard SSR session configuration is unchanged. RLS scopes the UID;
it does not itself prove immediate session revocation. Next.js protected operations
must verify sessions; direct API access with an unexpired JWT follows Supabase's
expiry semantics. Password recovery remains pending manual verification due to
Supabase rate limiting. Root architecture/security documents now reflect the applied five-table foundation; later feature and release decisions remain open.

References: [Supabase functions](https://supabase.com/docs/guides/database/functions),
[Auth deletion and JWT caveat](https://supabase.com/docs/guides/auth/managing-user-data#deleting-users),
[Admin deleteUser](https://supabase.com/docs/reference/javascript/auth-admin-deleteuser),
[PostgreSQL constraints](https://www.postgresql.org/docs/current/ddl-constraints.html).
