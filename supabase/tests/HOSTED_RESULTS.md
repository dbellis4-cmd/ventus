# Milestone 3 — hosted database foundation verification

**Environment:** Ventus development project `dxplprepnfuvfpqmmslf`, branch `main`, PostgreSQL 17.11.
**Catalog evidence recorded:** 2026-10-20T03:53:32.949Z.
**Result:** both migrations succeeded; subsequent read-only structural checks passed with no recorded failures. No hosted user-level behavior was tested.

## Migration execution

The owner explicitly approved applying these exact files after isolated local verification and a read-only hosted compatibility review. They executed in the following order; each history entry committed atomically with its migration. No migration error or schema conflict was reported. No RLS/permission bypass was used to resolve an error.

| Version | Name | SHA-256 of tested and hosted-recorded source |
|---|---|---|
| `20261019000100` | `task_schema_and_rls` | `6333ac013e1937239aba80bc72d4b7fa9fa1eb5148572e98688841d3690e88c8` |
| `20261019000200` | `workspace_initialization` | `e85ae57dd75845770de7eb8b4a075294abe4ae24a9f3cdbd9a53a16af1f6d2f6` |

The previously absent `supabase_migrations.schema_migrations` ledger was initialized for standard version/name/statements bookkeeping. RLS was explicitly enabled and API privileges revoked. The stored migration source hashes matched the files above. Migration comments retain their original draft/never-hosted wording to preserve exact tested contents; that wording is historical. Do not reapply/reset these migrations or edit applied SQL; future changes require new reviewed migrations and applicable approval.

## Read-only structural results

| Catalog check | Verified result |
|---|---|
| Core relations | Exactly `user_settings`, `categories`, `tasks`, `task_occurrences`, `task_activity`; postgres-owned, ENABLE and FORCE RLS on all five. |
| Policies | 14 policies: UID-scoped SELECT for authenticated/writer, writer-only INSERT/UPDATE, history INSERT only; no DELETE policy. |
| Effective table rights | Authenticated SELECT only; anonymous and service roles have no table privileges. Writer has SELECT/INSERT, UPDATE except history, and no DELETE/TRUNCATE/REFERENCES/TRIGGER/MAINTAIN. |
| Restricted writer | NOLOGIN, NOINHERIT, NOBYPASSRLS, no superuser/CREATEROLE/CREATEDB, separate from table ownership, no public-schema CREATE. Membership restricted to postgres. |
| Public RPCs | Ten, owned by writer, SECURITY DEFINER, empty search path and row_security=on; authenticated EXECUTE, anonymous/service EXECUTE denied. |
| Private functions | 21; API execute/schema access denied. Invoker UID helper has a pre-parsed SQL body. Only the account-erasure history guard is a postgres-owned private definer. |
| Integrity | All catalog constraints validated, including five ownership cascade paths and deferred owner-matching references. Twenty indexes valid; seven integrity triggers enabled. |
| History | Exactly the two expected versions/names with matching source SHA-256; ledger protected from API access. |

This report transcribes the prior session's successful execution and read-only catalog checks, supported by its sanitized metadata artifact. Finalization inspected that local evidence and rechecked file hashes; it did not contact Supabase or execute SQL. It is not a claim of continuous monitoring or a new hosted verification run.

## Scope and remaining verification

- The separate [local report](RESULTS.md) records **132 executable assertions**, zero failures, against the final files in a disposable environment. It covers two-user isolation, task lifecycle, rollback/history, retries/concurrency, DST and test-account erasure.
- No hosted test users or task records were created, no task RPCs were invoked to test hosted behavior, and no hosted accounts were deleted. Catalog inspection does not establish hosted user-level behavior.
- Dashboard persistence, application endpoint authorization/origin checks, integrated two-user/reload tests, performance, backup restore and production release hardening remain unfinished/unverified.
- Password recovery remains **pending successful manual verification due to Supabase rate limiting**. No application deployment, commit or push was part of the database application session; repository finalization is recorded separately in PROJECT_STATUS.md/HANDOFF.md.
