# Ventus

A task management application using Next.js, TypeScript, Tailwind CSS, Supabase Authentication, and persistent PostgreSQL tasks.

## Requirements

- Node.js 22.13 or newer (Node.js 24 LTS is recommended)
- npm

## Local development

```sh
npm ci
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and sign in to your Ventus workspace.

## Checks

```sh
npm run lint
npm run typecheck
npm run build
npm run test:auth
npm run test:tasks
npm run test:calendar
npm run test:browser
```

The browser suite starts an isolated local Next.js server and disposable mock Supabase API. It uses the installed Google Chrome binary and does not access hosted accounts or tasks.

To serve a production build locally, run `npm run build` followed by `npm start`.

## Supabase authentication

Ventus uses email/password authentication and standard Supabase SSR cookie
sessions. `/login`, `/signup`, `/forgot-password`, and `/reset-password` provide
login, registration, and recovery. `/` is the protected Dashboard; task data is
stored through authenticated, owner-restricted Supabase RPCs and ownership RLS.
Google Calendar synchronization is implemented and verified locally; hosted migrations and production credentials are still pending.

## Google Calendar integration (local implementation)

The integration requests [`calendar.app.created`](https://developers.google.com/workspace/calendar/api/auth) plus the basic `openid` identity scope, creates a separate Ventus calendar, and synchronizes selected top-level tasks in both directions when Ventus opens or the user selects **Sync now**. Google’s verified `sub` claim is unique across active Ventus connections; email addresses are not used for identity. Task saves also schedule an outbound sync after the response; the daily recovery route retries pending outbound work. Google edits are imported on app open or **Sync now**. The existing Calendar sidebar link opens Google Calendar in a new tab. Deleting one recurring event in Google disables synchronization for that occurrence alone. Disconnecting keeps existing Google events.

The two Milestone 5 migrations, `supabase/migrations/20261023000100_google_calendar.sql` and `supabase/migrations/20261024000100_google_account_uniqueness.sql`, are applied to hosted Supabase; do not reapply them. For a new project, apply them in that order. The uniqueness migration clears older Calendar-only tokens and asks those users to reconnect so their Google `sub` can be verified. Before deployment, enable the Google Calendar API, configure an OAuth consent screen and a **Web application** OAuth client, and register the exact `${SITE_URL}/api/google/callback` redirect URI. Set the server-only `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_TOKEN_ENCRYPTION_KEY` (base64 encoding of 32 random bytes), `SUPABASE_SECRET_KEY`, and deployment `CRON_SECRET` from `.env.example`. Never place them in `NEXT_PUBLIC_*` settings or Git. [Google's OAuth guidance](https://developers.google.com/identity/protocols/oauth2/) says refresh tokens for External apps in Testing mode expire after seven days; choose a suitable publishing mode before expecting long-lived connections.

Create a dedicated `sb_secret_` key for Calendar synchronization under Supabase **Project Settings → API Keys → Publishable and secret API keys**. Add its value only to Vercel **Project Settings → Environment Variables** as `SUPABASE_SECRET_KEY`, type **Secret**, environment **Production**. The key maps to `service_role` and bypasses RLS; keep it server-only. Existing table grants and user RLS policies remain unchanged. Environment changes take effect on the next deployment. Keep the legacy key active until the new deployment has been verified; credential retirement is a separate approved operation.

Local verification uses `npm run test:calendar` for fake Google responses, `python3 -B supabase/tests/verify_calendar_local.py "$PWD"` for disposable **local** Supabase data, and `npm run test:browser` for the UI fixture. The database script requires a running local Supabase stack and refuses a linked hosted project. These checks do not establish a live Google OAuth connection.

### Milestone 2 verification — October 19, 2026

Authentication implementation is finalized for the Milestone 2 commit. Manual
results below were reported by the project owner in the finalization request;
they are distinct from the automated checks performed by Codex.

| Flow | Manual verification |
|---|---|
| Registration | Passed — project owner verified. |
| Login | Passed — project owner verified. |
| Logout | Passed — project owner verified. |
| Protected Dashboard access | Passed — project owner verified. |
| Password recovery | **Pending manual verification due to Supabase rate limiting. Not passed.** |

Lint, typecheck, production build, and all 16 authentication tests pass. Recovery
regression tests use mocked Auth HTTP and do not establish successful live email
recovery. Preserve the recovery fixes and SSR configuration while awaiting the
manual retry. Session expiry/refresh, Back/multiple-tab behavior, deployed cache
isolation, and signup abuse controls require their own verification before public
release. This paragraph records the Milestone 2 checkpoint; persistent tasks
and RLS were added in Milestone 3.

### Local authentication setup

1. In your Supabase project's **Connect** dialog, obtain the project URL and
   **publishable** key (`sb_publishable_...`).
2. Copy `.env.example` to `.env.local` and fill in
   `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.
   `.env.local` is ignored by Git. Do not use secret/service-role keys or Google
   tokens; neither is needed for this setup.
3. `SITE_URL` is the canonical application origin used in email callbacks. It
   defaults to `http://localhost:3000` in development only. Set it explicitly for
   another local port or production (HTTPS required except on loopback).
4. In Supabase Auth URL Configuration, set the Site URL to your application
   origin. Add these Redirect URLs for local development:
   `http://localhost:3000/auth/callback` and
   `http://localhost:3000/auth/callback?next=/reset-password`.
   Use exact approved HTTPS equivalents when deployment is authorized.
5. Keep email/password signup enabled. The code respects the project's email
   confirmation setting; it does not change that policy. Default email templates
   use the PKCE callback: open links in the same browser where signup/recovery
   started so the verifier cookie is available. If cross-device confirmation is
   needed, the callback also supports the documented token-hash email links:
   `{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=signup`
   and `{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=recovery`.
   Review changes to templates and email-scanner behavior before enabling them.
6. Verify email delivery. Supabase's default mail service restricts delivery to
   project-team addresses and has strict limits. Configure custom SMTP in
   Supabase for general self-service registration; never put SMTP credentials in
   this repository. [Official SMTP guidance](https://supabase.com/docs/guides/auth/auth-smtp).
7. Restart `npm run dev` after changing environment values. Next.js includes
   `NEXT_PUBLIC_*` values in browser bundles at build time; rebuild when changing
   them for a production environment.

Missing/invalid configuration never grants Dashboard access. Auth operations
return safe error messages without displaying credentials or provider internals.
New passwords require 12–128 characters and matching confirmation; login accepts
existing passwords without imposing the new-password minimum. Supabase may
enforce additional password requirements.

Use `lib/supabase/client.ts` in browser components and await `createClient()` from
`lib/supabase/server.ts` on the server. The proxy verifies claims and refreshes
cookies, forwarding the SDK's cache-protection headers. It does not restrict
access by itself. The Dashboard, password update action, and session endpoint
use `getUser()` for a fresh server-verified identity. Every future protected
operation must authorize independently. Auth routes are dynamic; responses use
`private, no-store`. Server Actions provide POST/Origin CSRF checks. Callback
redirects accept only fixed local destinations and suppress referrers.

Session cookies use `SameSite=Lax`, host-only scope, path `/`, and `Secure` in
production. They are browser-readable as required by the approved Supabase SSR
flow. Privileged credentials and Google OAuth tokens must remain server-only.
Sign out revokes the current session (`scope: local`), clears its cookies, and
discards client navigation/task state. A Dashboard guard rechecks on focus,
visibility changes, restored pages, sign-out notifications, and periodically.
It hides the workspace if verification fails and reloads on account changes.
Other devices remain signed in. Database policies must account for JWT
expiry/revocation semantics; do not rely on a UI guard for authorization.

`npm run test:auth` runs 16 automated tests using mocked Auth responses, including
the real SSR SDK cookie lifecycle and revoked-session replay. Production HTTP
smoke checks cover anonymous redirects, recovery protection, cache headers, and
cross-origin Server Action rejection. The table above records the reported manual
passes; it does not imply every edge case below has been checked:

- Register with a test mailbox, confirm email, log in, reload, and navigate weeks.
- Verify invalid credentials, duplicate signup, and provider password-policy errors.
- Request recovery, open the link in the same browser, change the password, and
  verify the old password fails and the new one works. Reused/expired links fail.
- Sign out, then try Back, reload, direct Dashboard access, and a second tab.
- Verify session expiry/refresh and server-side revocation with the real project.
- Confirm two accounts see only their own persistent tasks. The owner reported
  this browser check passed in Milestone 3; direct hosted RLS tampering remains unverified.

Before public registration, review Supabase rate limits, IP/proxy behavior,
password/email settings, and bot protection. No app-level distributed rate limiter
or CAPTCHA integration is installed. Complete the `SECURITY.md` release gate;
authentication implementation does not authorize deployment.

### Password recovery troubleshooting

The request uses `resetPasswordForEmail()` with
`SITE_URL/auth/callback?next=/reset-password`. The SSR client writes the PKCE
verifier cookie before sending the request. The callback exchanges `code` using
that cookie, honors the SDK's verified recovery intent even without `next`, and
persists session cookies before redirecting to `/reset-password`. Auth actions
and callbacks fail rather than silently ignoring cookie-write errors. The reset
page and password update action still independently verify the user.

Two email-link formats are supported; do not mix their parameters:

- **Default PKCE:** the email uses `{{ .ConfirmationURL }}`. Open the newest link
  in the same browser profile and at the same hostname as the reset request.
  `localhost` and `127.0.0.1` do not share cookies; private windows and mail-app
  browsers can also lose the verifier. Starting another signup/recovery flow can
  replace the verifier. A missing/mismatched verifier is rejected, not bypassed.
- **Direct token hash:** for recovery that must work in another browser, set the
  Supabase **Reset password** email template's link to:

  ```html
  <a href="{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&amp;type=recovery">Reset password</a>
  ```

  Set Supabase's **Site URL** to the application origin only, for example
  `http://localhost:3000`. The callback verifies the single-use recovery hash with
  Supabase using `verifyOtp({ token_hash, type: 'recovery' })`; it never trusts
  tokens or session claims supplied by the URL without provider verification.
  Do not use a bare `.Token`, `type=signup`, or a fragment containing access tokens
  in this server-side callback. This template is a manual dashboard change; no
  provider configuration was changed by the application fix.

Check **Auth → URL Configuration**: Site URL must match the browser/app origin,
and the exact callback Redirect URLs above must be allowed. Keep the existing
expiry/security policy, request a fresh email, and use it once. Old, consumed, or
expired links remain invalid. Review the **Reset password** template rather than
the signup template. SMTP click tracking can rewrite links, and email-security
scanners can consume single-use links before the user clicks them; investigate
these if a fresh correctly configured link still reports expiry. Do not paste
reset URLs, hashes, codes, or cookies into logs or support messages.

The callback maps known failures to fixed notices for a missing/mismatched PKCE
verifier, expired/used links, and other invalid callbacks; raw provider errors are
never displayed. Regression tests cover real-SDK verifier persistence, recovery
routing with no `next`, cookie-write failure, missing-verifier denial, and
token-hash session creation/replay rejection against mocked Auth HTTP. Actual
email contents, dashboard settings, mail scanners, and live delivery still need
manual verification. See [Supabase PKCE](https://supabase.com/docs/guides/auth/sessions/pkce-flow)
and [email-template guidance](https://supabase.com/docs/guides/auth/auth-email-templates).

This follows the [official Supabase Next.js SSR guide](https://supabase.com/docs/guides/auth/server-side/creating-a-client?queryGroups=framework&framework=nextjs)
and [session/caching guidance](https://supabase.com/docs/guides/auth/server-side/advanced-guide).
`ARCHITECTURE.md`, `SECURITY.md`, and `AGENTS.md` record the approved session
strategy and the remaining implementation/verification work.

## Tooling compatibility

TypeScript 6 and ESLint 9 are used because the Next.js lint plugins do not yet support
all newer major releases. The `typescript-eslint` override pins the latest fully
published compatible package set; the registry's newer wrapper currently references
an unpublished dependency. Versions are locked in `package-lock.json`.

## Initialization checks

- ESLint, TypeScript, and the production build passed.
- The development server returned HTTP 200 with the Ventus heading.
- The production dependency audit reported zero vulnerabilities.
- The full audit reported five high-severity findings in the development-only
  ESLint dependency chain (`braces`, `micromatch`, `fast-glob`, the Next.js lint
  plugin, and its configuration). npm's suggested fix downgrades the lint
  configuration to Next.js 14, so it was not applied.

The initialization environment had no system `node` or `npm` on PATH. Checks used
the Codex bundled Node.js 24 runtime and a temporary npm installation. Install
Node.js 24 LTS with npm for the standard commands above. During this local
session, the installed dependencies can also be run with:

```sh
PATH="/Users/dantebellissimo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" \
  node /tmp/ventus-npm-runtime/package/bin/npm-cli.js run dev
```

The temporary npm installation may be cleared by the operating system. The first
build was blocked by the execution sandbox's local-port restriction; it passed
when rerun with permission to create Turbopack's local worker port.
