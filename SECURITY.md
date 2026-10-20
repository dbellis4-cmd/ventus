# Ventus — Security Implementation Checklist

**Reviewed:** October 19, 2026

**Scope:** Implementation checklist and security release standard

**Current readiness:** Not ready for public application deployment

## How to use this checklist

These are security development phases, distinct from the product phases in `PRD.md`. Authentication, database, and Google Calendar controls are required for the first product release. Reward controls apply only when product Phase 2 is explicitly authorized.

Implement each control before its stated trigger. A later security phase does not permit exposing an earlier feature without its required protection. This document does not authorize dependency installation, external configuration, deployment, or Git history changes.

| Status | Meaning |
|---|---|
| Not Started | No implementation evidence for the full control. |
| In Progress | Some evidence exists; required work or verification remains. |
| Implemented | Control exists, but its verification is incomplete. |
| Verified | Required checks passed; record the date, revision/environment, and evidence. |
| Not Applicable | Feature is absent or outside scope; record why and reassess if scope changes. |

Provider documentation describes capabilities, not proof that Ventus has configured them. Keep evidence redacted; never include credentials or private user data in this public file.

## Current evidence and limitations

- Milestone 2 implements email/password signup/login/recovery, SSR callbacks, current-session logout, and server-protected Dashboard access. Sixteen automated tests cover validation, safe errors/redirects, anonymous/revoked denial, the real SSR SDK cookie lifecycle with mocked Auth HTTP, and refresh cache headers. Recovery regressions additionally verify PKCE cookie persistence, SDK recovery intent without `next`, strict mutation/callback cookie writes, missing-verifier denial, and token-hash session creation/replay rejection. Production HTTP checks verify anonymous redirects, no-store headers, and cross-origin Server Action rejection. Lint, typecheck, build, and all authentication tests pass at finalization. Five application tables and ownership RLS are now applied in hosted development; see the separate database evidence below. Application persistence remains unfinished.
- **Manual verification reported by the project owner on October 19, 2026:** registration, login, logout, and protected Dashboard access passed. **Password recovery is pending manual verification due to Supabase rate limiting; it has not passed.** Automated/mocked recovery checks do not close this item. Live expiry/refresh, Back/multiple-tab behavior, deployed cache isolation, and project abuse controls remain separate verification requirements. This is local milestone evidence, not public-release approval.
- Current code includes authentication and an interactive in-memory Dashboard. Applied database RPCs are not yet connected to that Dashboard. Google Calendar integration and production release verification remain absent.
- `.gitignore` excludes `.env*` except `.env.example`, common credential/key files, dependencies, and build output. Representative paths passed `git check-ignore`. Any example environment file must contain placeholders only.
- The baseline credential-pattern scan at `77612b1` is historical, not a scan of later revisions. Finalization separately reviews pending/staged files and ignore rules; limited pattern checks are not an exhaustive secret audit or client-bundle inspection.
- `npm audit --json --ignore-scripts` reported **five high-severity package findings** in the development-only chain: `braces`, `micromatch`, `fast-glob`, `@next/eslint-plugin-next`, and `eslint-config-next`. These include propagated findings, not five independent confirmed exploits. `npm audit --omit=dev --json --ignore-scripts` reported **zero known findings**. This is not proof that dependencies are vulnerability-free.
- The lockfile marks those five packages as development dependencies. npm suggests downgrading `eslint-config-next` to 14.2.35; compatibility and actual exposure need review before any change. No fixes were applied.
- `next.config.ts` is empty; no application-defined security headers are configured. No production deployment evidence was reviewed. A passing build does not establish security readiness.

## Milestone 3 database evidence

The isolated local PostgreSQL 17 suite passed **132 assertions**, zero failures,
covering five-table RLS, anonymous/two-user Data API isolation, protected writes,
nonrecurring RPCs, history/rollback, retry/concurrent-update behavior, explicit DST
handling and disposable Auth-account cascades. Its fixtures/stack were discarded.
[Local evidence](supabase/tests/RESULTS.md) records hashes and the UID-helper
correction without broadening Auth permissions.

Both unchanged migrations subsequently succeeded on hosted development project
`dxplprepnfuvfpqmmslf`, branch `main`, PostgreSQL 17.11. Both versions are recorded
in migration history with matching source hashes. Read-only hosted checks passed
for five tables with ENABLE/FORCE RLS, 14 owner policies, ten restricted public
RPCs, 21 private functions, permissions, constraints, 20 indexes, seven integrity
triggers and migration history. The history ledger has RLS and no API access.
See [hosted evidence](supabase/tests/HOSTED_RESULTS.md).

**Hosted user-level database behavior has not been tested.** Hosted catalog checks
are structural evidence, not user isolation/lifecycle execution. Application task
integration, exhaustive boundaries, backup restore, monitoring and release checks
remain pending. Password recovery remains pending manual verification due to
Supabase rate limiting. No public application deployment is authorized.

## Phase 1 — Application Foundation

### 1. Classify and protect API keys and secrets

- **Objective:** Publishable identifiers may be public; database passwords, secret/service-role keys, OAuth client secrets, and Google access/refresh tokens must remain confidential. Use server-only configuration and modules. Never put confidential values in `NEXT_PUBLIC_*`, rendered props, logs, or source. [Supabase key guidance](https://supabase.com/docs/guides/getting-started/api-keys), [Next.js data security](https://nextjs.org/docs/app/guides/data-security).
- **When:** From now; inventory each credential before adding an integration.
- **Verify:** Review configuration and server/client boundaries; inspect generated browser bundles, responses, and redacted logs for confidential values before release and after integration changes.
- **Status:** In Progress — repository review found no apparent credentials; integration configuration and bundle verification are pending.

### 2. Keep secrets out of Git and respond to exposure

- **Objective:** Retain ignore rules and review staged files and history before publishing. `.gitignore` does not remove tracked files or old commits. If exposure occurs: revoke the credential immediately; issue and securely deploy a replacement; invalidate affected grants/sessions as appropriate; review access logs; remove it from current files. With explicit owner authorization, follow GitHub's history-removal procedure using `git-filter-repo`, coordinate affected branches/tags and clones, and request GitHub cache/PR-reference cleanup where needed. Re-scan all affected references. Rotation comes before cleanup; copies in forks may persist. [GitHub guidance](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository).
- **When:** Now, before every commit/push, and immediately after suspected exposure.
- **Verify:** Check representative ignored paths, tracked/staged files, and history; confirm revoked credentials fail and replacements work. Do not expose values in verification output.
- **Status:** In Progress — ignore rules verified and limited committed-file scan passed; continuous secret detection and incident-procedure verification are not established. No known exposure requiring rotation was identified.

### 3. Use only Supabase publishable keys in frontend code

- **Objective:** Use the current publishable key for frontend Supabase access. Never ship secret keys or legacy service-role keys. A publishable key identifies the application, not the user, and does not replace authorization or RLS. [Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys).
- **When:** Before adding a frontend Supabase client.
- **Verify:** Inspect client initialization and production bundles; test anonymous and authenticated access against policies using the publishable key.
- **Status:** In Progress — client factories accept only publishable-key configuration and reject other key prefixes. The owner reports successful registration/login in the local application. Privileged-key exclusion and future database-policy/bundle verification remain required before release.

### 4. Enable Row Level Security

- **Objective:** Enable RLS on all exposed user-data tables, including tables created through SQL migrations. Define explicit policies and least-privilege grants; deny access without a matching authorization policy. Review views, functions, and privileged paths for bypasses. [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security).
- **When:** With the first database migration, before exposing any user data.
- **Verify:** Inspect migrations and deployed table/policy metadata; test anonymous and two-user SELECT, INSERT, UPDATE, and DELETE directly through the Data API, not only through the UI.
- **Status:** In Progress — all five tables have enabled/forced RLS and ownership policies verified locally and structurally on hosted development. Hosted user-level, application integration and release verification remain pending.

### 5. Encrypt sensitive data in transit and at rest

- **Objective:** Require TLS for provider APIs and database connections, with certificate/hostname validation. Confirm encryption of database storage, backups, and secret storage on selected providers. Store Google OAuth tokens encrypted under restricted server access; document key custody and rotation. Do not invent cryptography. [Supabase database TLS](https://supabase.com/docs/guides/platform/ssl-enforcement), [Google OAuth](https://developers.google.com/identity/protocols/oauth2/web-server).
- **When:** Before storing real user data or provider tokens; production transport verification before release.
- **Verify:** Record provider encryption guarantees and actual settings, reject insecure database connections, and test that ordinary users cannot read token records. Verify token decryption is limited to authorized server operations.
- **Status:** Not Started — storage providers, token encryption, and deployed transport are unverified.

### 6. Enforce server-side authentication and authorization

- **Objective:** Validate sessions on the server and authorize every protected read/write, Route Handler, and Server Action. Never trust UI gating, client user IDs, or unvalidated cookie contents. Prevent unauthorized requests from reaching privileged operations. [Next.js data security](https://nextjs.org/docs/app/guides/data-security).
- **When:** With the first protected operation.
- **Verify:** Test absent, forged, expired, and signed-out sessions against each protected entry point. Define and test immediate logout/revocation behavior; a locally valid JWT alone may outlive the session that issued it. [Supabase session guidance](https://supabase.com/docs/guides/auth/server-side/advanced-guide).
- **Status:** In Progress — Dashboard, session endpoint, and password mutation verify users via Supabase `getUser()`. Automated anonymous/forged/revoked/outage denial and production anonymous HTTP checks pass. The owner reports manual login, logout, and protected Dashboard access passed. Live password recovery is pending due to Supabase rate limiting; per-record authorization awaits Milestone 3.

### 7. Restrict records to authorized users

- **Objective:** Isolate tasks, occurrences, subtasks, categories, settings, and calendar connections by authenticated owner. Enforce ownership for nested references, queries, subscriptions, and jobs. Do not use an RLS-bypassing key for ordinary user requests. [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security).
- **When:** With each user-owned table and operation.
- **Verify:** Run automated two-user tests against application endpoints and database APIs, including guessed IDs, foreign parent IDs, filters, and mutations. User A must neither read nor change user B's records.
- **Status:** In Progress — anonymous and two-user direct Data API/RPC tests passed locally, including owner-matching references and denied cross-user writes. Hosted structural ownership/permission checks passed; hosted user-level and integrated application verification remain pending.

### 8. Protect ownership and system-controlled fields

- **Objective:** Derive ownership from the validated session; reject unauthorized owner changes and mass assignment. Restrict privileged columns/functions as well as rows. Future reward balances, XP, and season records must be computed through authorized server operations; approved task-point overrides are separate from balance manipulation. [OWASP API controls](https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html).
- **When:** With the first write operation; reward-specific enforcement before product Phase 2.
- **Verify:** Submit tampered ownership, system fields, and foreign references through both API and direct database requests; assert rejection and unchanged protected records.
- **Status:** In Progress — protected task fields, restricted writer/RPC permissions, original deadlines and history were tested locally. Hosted structural checks confirmed restricted grants, integrity triggers and RPC configuration. Application integration and hosted tampering tests are pending; reward infrastructure remains deferred.

### 9. Secure cookies and session lifecycle

- **Objective:** Use a maintained session solution; require production `Secure` cookies, appropriate `SameSite`, narrow scope, expiration, and `HttpOnly` for server-only session cookies. Protect cookie-authenticated mutations against CSRF and validate origins. Define refresh, rotation, logout, revocation, and cache isolation. Do not cache private responses across users. Preserve the approved standard SSR token architecture below. [OWASP sessions](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html), [Supabase SSR](https://supabase.com/docs/guides/auth/server-side/advanced-guide).
- **When:** Before introducing login or protected pages.
- **Verify:** Inspect cookie flags; test refresh/expiry, replay after logout under the approved policy, cross-site mutations, and sequential requests by different users through deployed caches.
- **Status:** In Progress — approved SSR cookies use production Secure, SameSite=Lax, host-only scope, and no-store response headers. Logout revokes the current session and discards client navigation state; the owner reports manual logout passed. Real SDK cookie clearing/revoked replay with mocked Auth, refresh forwarding, and production cross-origin rejection pass. Live password recovery is pending due to Supabase rate limiting. Expiry/refresh, multiple-tab/back behavior, and deployed cache isolation remain pending.

### 10. Delegate password storage to Supabase Auth

- **Objective:** Use Supabase Auth's managed password hashing; never store plaintext, reversible passwords, or custom password hashes in Ventus tables or logs. Supabase documents salted bcrypt hashing. Review password policy and reset/reauthentication behavior. [Supabase password security](https://supabase.com/docs/guides/auth/password-security).
- **When:** Before password registration, login, or reset is enabled.
- **Verify:** Confirm all password operations use Auth; inspect application tables/logging for prohibited storage; test registration, reset, and unauthorized password-change rejection.
- **Status:** In Progress — all password operations delegate to Supabase Auth; no custom password storage or credential logging is added. Registration/login passed manual verification reported by the owner. New-password length/confirmation and authenticated update checks pass automated tests. Password recovery remains pending manual verification due to Supabase rate limiting; reset/reauthentication and provider policy verification are not marked passed.

## Phase 2 — Authentication, Backend, and Integrations

### 11. Rate-limit authentication operations

- **Objective:** Limit automated login, signup, recovery, and verification attempts. Review provider limits and enforce limits on application-owned endpoints without enabling trivial account lockout attacks. [Supabase rate limits](https://supabase.com/docs/guides/auth/rate-limits).
- **When:** Before publicly exposing authentication endpoints.
- **Verify:** Test repeated requests, throttling and recovery, direct provider access, and proxy/IP handling; document selected thresholds and evidence.
- **Status:** In Progress — requests use Supabase Auth and map provider throttling errors to safe feedback. Provider thresholds, server IP/proxy effects, distributed application limits, and live throttling behavior remain unverified; required before public registration.

### 12. Protect public registration from bots

- **Objective:** Assess automated signup abuse; apply provider-supported CAPTCHA or equivalent justified controls where appropriate. Validate challenges on the server and preserve accessible self-service signup. [Supabase bot protection](https://supabase.com/docs/guides/auth/auth-captcha).
- **When:** Before opening public registration; reassess with observed abuse.
- **Verify:** Test missing, invalid, expired, and replayed challenges where enabled; check that bypassing frontend validation does not create an account. Record any alternative control and rationale.
- **Status:** Not Started — signup UI is implemented locally, but no bot-control assessment or challenge integration exists. Resolve before public release.

### 13. Parameterize database queries

- **Objective:** Bind query values using supported clients/parameterized statements; never concatenate untrusted values into SQL. Allowlist dynamic identifiers and sort fields, including inside RPC/database functions. [OWASP SQL injection prevention](https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html).
- **When:** With each database query or function.
- **Verify:** Review query construction and test injection payloads in searches, filters, IDs, and RPC inputs; confirm authorization remains enforced.
- **Status:** In Progress — applied RPC SQL uses qualified static statements and bound inputs with no dynamic SQL; local database verification passed. Future application queries and injection-specific release tests remain pending.

### 14. Validate all untrusted input on the server

- **Objective:** Constrain types, lengths, ranges, body sizes, dates, recurrence complexity, identifiers, and allowed fields. Treat Google payloads and job messages as untrusted. Validate ownership of references independently. Client validation is only a convenience. [OWASP input validation](https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html).
- **When:** With each server input boundary.
- **Verify:** Test malformed/oversized bodies, unexpected fields, invalid dates, recurrence limits, and unauthorized parent/event references; reject safely without losing valid persisted data.
- **Status:** In Progress — local RPC tests cover exact input allowlists, protected fields, dates/zones and invalid references. Next.js task endpoints and exhaustive boundary/release checks remain pending.

### 15. Prevent cross-site scripting

- **Objective:** Render task titles, categories, locations, and imported calendar text as escaped text. Avoid raw HTML rendering; sanitize if rich content is explicitly introduced. Validate URL schemes before using user-provided links. CSP is additional defense, not a substitute. [OWASP XSS prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html).
- **When:** Before displaying any user-generated or imported content.
- **Verify:** Test script, attribute, HTML, and unsafe-URL payloads in every relevant display/edit path, including Google imports; verify no script executes.
- **Status:** In Progress — React renders editable demo task content as text. Persistent/imported-content XSS tests and deployed CSP verification remain pending.

### 16. Restrict file uploads if introduced

- **Objective:** Allowlist types, validate actual content, cap sizes, authorize access, use generated names and private storage outside executable/public paths, and assess malware scanning needs. [OWASP file uploads](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html).
- **When:** Before adding any upload endpoint or storage bucket.
- **Verify:** Test unauthorized upload/download, oversized files, spoofed types, executable content, and storage access policies.
- **Status:** Not Applicable — uploads are absent and outside the current MVP. Reassess before introducing them.

### 17. Minimize API and rendered response data

- **Objective:** Return explicit authorized fields; exclude tokens, private connection details, password-related data, and internal errors. Apply this to JSON, rendered props, Server Action results, and cache entries. [Next.js data security](https://nextjs.org/docs/app/guides/data-security).
- **When:** With each data-returning operation.
- **Verify:** Inspect success/error responses and rendered payloads for anonymous and two-user requests; verify field allowlists and private-response cache behavior.
- **Status:** In Progress — Auth/session responses and owned database RPC results exist; application task view models are unfinished. Integrated field-minimization, error and cross-user payload checks remain required.

## Phase 3 — Public Deployment and Ongoing Maintenance

### 18. Configure HTTP security headers

- **Objective:** Configure and test CSP, framing protection (`frame-ancestors`), `X-Content-Type-Options`, `Referrer-Policy`, and a minimal `Permissions-Policy`; coordinate HSTS with HTTPS. Avoid production development-only CSP relaxations. [Next.js CSP](https://nextjs.org/docs/app/guides/content-security-policy), [OWASP HTTP controls](https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html).
- **When:** Before public deployment; retest when auth/integration scripts change.
- **Verify:** Inspect actual deployed HTML/API/error response headers and browser CSP violations; test that login, calendar connection, and normal navigation still work.
- **Status:** Not Started — no application-defined headers or deployed-header checks exist.

### 19. Enforce production HTTPS

- **Objective:** Require HTTPS on production domains, APIs, and OAuth redirects; redirect HTTP and prevent mixed content. Verify HSTS scope before including subdomains/preload. Localhost HTTP is development-only. Vercel provides HTTPS if selected, but deployment/domain behavior still requires verification. [Vercel TLS](https://vercel.com/docs/cdn-security/encryption).
- **When:** Before any public deployment or real-data OAuth callback.
- **Verify:** Test every production domain for HTTP redirects, valid certificates, HTTPS-only resources/callbacks, secure cookies, and appropriate HSTS.
- **Status:** Not Started — no production hosting/domain configuration has been verified.

### 20. Review vulnerabilities and apply security updates

- **Objective:** Run full and production-only `npm audit` before releases and after dependency changes. The owner reviews advisories at least weekly and promptly on critical alerts, records reachability, severity, mitigation, and a remediation deadline, and tests compatible updates. Never blindly run `npm audit fix --force`. Include developer/build dependencies in the risk review. [npm audit](https://docs.npmjs.com/cli/v11/commands/npm-audit/).
- **When:** Start now; repeat during development and maintenance.
- **Verify:** Retain dated redacted audit summaries and disposition of each finding; review lockfile changes and rerun lint, typecheck, build, and relevant security/workflow tests after approved updates.
- **Status:** In Progress — current audits completed; five high-severity development-chain findings remain unresolved. No recurring review automation or update verification has been established.

## Additional Ventus requirements

| Control and objective | Implementation deadline | Required verification | Current status |
|---|---|---|---|
| Google Calendar OAuth: bind authorization to the signed-in user using validated state, exact redirect allowlists, authorization-code flow, and PKCE where supported. Request minimum necessary scopes; exchange codes on the server. Keep client secrets and Google tokens server-only; encrypt token storage, coordinate refresh safely, handle revoked/expired grants, and revoke grants and remove stored tokens on disconnect. | Before connecting real Google accounts. | Test state mismatch, callback replay, code reuse, wrong-user connection attempts, refresh concurrency, denial/revocation, and disconnect. Confirm no Google tokens reach browser payloads or logs. | Not Started — no integration. |
| Calendar isolation: bind durable task/event mappings to the owner; only synchronize linked events. Authorize and authenticate any future push notification/job entry point. | With the first sync operation. | Two-account tests; tamper with event/task IDs, replay sync deliveries, and verify unrelated events remain unchanged. | Not Started — no mappings or sync jobs. |
| Duplicate processing: use stable occurrence IDs, database uniqueness, transactions, and idempotency appropriate to recurrence, postponement, and synchronization. | With recurrence and background processing. | Retry and concurrency tests produce one occurrence/transition/event effect and preserve completion history. | In Progress — nonrecurring creation retries, occurrence/history uniqueness and concurrent writes passed locally; hosted structure confirmed. Integrated retries, recurrence and sync tests remain pending. |
| Reward integrity: compute reward transactions on the server; reject direct balance/XP writes and enforce one effect per authorized occurrence/transition. Preserve legitimate task-point overrides and correction rules. | Before explicitly authorized product Phase 2. Preserve required history during product Phase 1. | Replay, concurrency, ownership, correction, and season-lock tests under approved scoring rules. | Not Started — rewards remain deferred. |
| Backup and recovery: approve maximum data-loss and recovery-time targets, plan/retention, encrypted restricted backups, and access to recovery keys. Include schema, RLS, auth dependencies, and event mappings; assess storage separately if introduced. | Design with database adoption; verify before real user data is relied on and before release. | Restore to an isolated environment; verify ownership policies and history, document measured recovery, and ensure restored stale jobs/tokens cannot replay unsafe effects. Repeat after material changes. | Not Started — no backup plan or restore evidence. |
| Monitoring and incident response: assign the owner and a private reporting route; collect redacted errors/auth failures/sync failures, restrict log access and retention, and configure actionable alerts. Record triage, containment, credential revocation, evidence preservation, recovery, affected-user notification assessment, and follow-up. | Before public deployment; redact logs from the first backend operation. | Trigger a safe test alert; confirm no secrets/private task text in logs; rehearse incident handling and verify access/retention. | Not Started — no production monitoring, reporting route, or incident exercise is established. |

References: [Google web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server), [Supabase backups](https://supabase.com/docs/guides/platform/backups), [OWASP logging](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html).

Do not report vulnerabilities containing secrets or personal data in public GitHub issues. A dedicated private reporting channel must be selected before public release; none is claimed here.

## Security release gate

**Status: Not Started — no release security verification has been performed.** Before opening public access, the owner must review dated evidence for the target revision and deployed environment:

- [ ] All applicable controls above are Verified; feature-based exclusions have a reason and are rechecked when scope changes. Required MVP features cannot be excluded merely because they are unfinished.
- [ ] Automated isolation tests pass for anonymous callers, two users, all user-owned records, and direct database/API bypass attempts. Test keys must not bypass RLS.
- [ ] Session, CSRF, input, XSS, protected-field, recurrence/idempotency, and Google OAuth/sync failure tests pass for implemented features.
- [ ] Secret scans cover tracked changes/history and browser bundles; environment separation and least-privilege production configuration are reviewed.
- [ ] Full and production dependency audits are reviewed. Unresolved exploitable high/critical findings block release; other exceptions require explicit owner approval with evidence, mitigation, and a deadline. No current finding is accepted by this document.
- [ ] HTTPS, headers, cookies, and private-response caching are verified on actual deployment domains, not inferred from provider defaults.
- [ ] Backup restoration and monitoring/incident exercises pass; the private reporting route and response owner are recorded.
- [ ] Existing lint, typecheck, build, and PRD acceptance checks pass. Build success alone is insufficient. Repeat affected verification after changes and request explicit deployment authorization.

Use the [Supabase production checklist](https://supabase.com/docs/guides/deployment/going-into-prod) alongside these application checks. No deployment is authorized by completing this document.

## Alignment and decisions requiring approval

- `AGENTS.md` governs workflow and `PRD.md` governs product behavior. This checklist adds verification requirements without authorizing product Phase 2 or new services. Supabase, testing tools, and Vercel remain subject to the existing approval requirements.
- **Session architecture approved for Milestone 2:** `AGENTS.md` permits browser-readable Supabase user-session access/refresh tokens through the standard SSR flow. `PRD.md` still prohibits unnecessary external-token exposure. Google tokens and elevated Supabase keys remain server-only. This approval does not verify live session security or authorize public release. [Supabase SSR guidance](https://supabase.com/docs/guides/auth/server-side/advanced-guide).
- **Retention and recovery:** Soft task deletion and permanent account erasure with associated-data cascades are approved. Cascades passed locally; hosted constraints were inspected without deleting accounts. The future endpoint requires explicit confirmation, recent reauthentication, server-derived UID and server-only Admin access. Retention periods, backup/log expiry, retry/recovery and restore suppression remain unresolved; no paid recovery plan is selected.
- **Integrations and rewards:** PRD decisions about calendar conflicts, external deletions, recurrence exceptions, season locking and retroactive scoring corrections remain unresolved. IANA-zone selection, original-slot preservation and explicit DST handling are approved; recurrence/time-display edge cases still require decisions. Security tests must follow approved behavior rather than inventing it.
- **Deployment:** Host, domains, monitoring, encryption/key-management approach, rate-limit thresholds, bot-control choice, and operational reporting channel are not yet selected or verified. Provider references are guidance, not configuration evidence.

Secret hygiene and dependency review apply immediately. Applied database/auth controls must remain enforced; integrated verification must precede reliance on persistent user tasks and public release. OAuth controls must precede Calendar connection; deployment controls must precede public exposure. Upload controls remain Not Applicable for the MVP, and reward-specific implementation waits for product Phase 2 authorization.
