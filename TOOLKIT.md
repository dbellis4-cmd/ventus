# Ventus — Development Toolkit

**Reviewed:** October 20, 2026 (America/Phoenix).

Select the smallest useful toolset for each milestone. This inventory is guidance, not permission to install software, change services, or expand scope. Product behavior remains governed by `PRD.md`; implementation and security follow `AGENTS.md`, `ARCHITECTURE.md`, and `SECURITY.md`.

## Status and evidence

- **Research Only:** Candidate for evaluation; no adoption approval implied.
- **Approved:** Adoption explicitly authorized, but installation/integration not yet established.
- **Installed:** Present in the checked environment, without demonstrated application integration.
- **Integrated:** Used by the application or established development workflow; does not imply production readiness.
- **Deferred:** Reserved for later work or a demonstrated need; no installation approval implied.

Evidence: inspected project guidance, `PROJECT_STATUS.md`, `HANDOFF.md`, Git state, package manifest/lockfile, installed core packages, application imports, local executable directory, skill directories, and this Codex session's skill catalog. Core versions are recorded in `package.json`; avoid duplicating version lists here.

The original research-only third-party skills below are absent from the checked session catalog and project/user skill directories. Ponytail was subsequently installed as a user-level Codex plugin; its review skill was used for Milestone 3. Playwright CLI remains uninstalled; the separate `@playwright/test` development dependency now runs the requested disposable-fixture browser suite. Other optional libraries below are not declared application dependencies. Machine-wide plugin caches and other executables were not exhaustively audited: **other global installation statuses are unconfirmed**, and a cached download would not establish activation.

## Core development

| Resource and official URL | Category | Purpose | Ventus milestone | Status | Dependencies, context, and security |
|---|---|---|---|---|---|
| [Codex](https://openai.com/codex/) | Platform | Primary AI development environment. | All | Integrated | Development tool, no app dependency. Limit loaded context; review commands and permissions; exclude secrets/private data from prompts. |
| [GitHub](https://github.com/) | Platform | Source control and review; [Ventus repository](https://github.com/dbellis4-cmd/ventus). | All | Integrated | No app dependency. Public repository requires secret hygiene; commits, pushes, and deployment integrations need authorization. |
| [Supabase](https://supabase.com/docs) | Platform | PostgreSQL, authentication, RLS, restricted task RPCs. | M2 auth; M3 persistence; later Calendar storage | Integrated | Official JS/SSR clients and development CLI installed. Preserve user JWT/RLS boundaries; privileged keys stay server-only. Hosted task behavior remains unverified. |
| [Vercel](https://vercel.com/docs) | Platform | Proposed Next.js hosting and previews. | M7 release/deployment | Deferred | No hosting integration established. Evaluate budget, scheduling limits, secrets, preview-data isolation, and rollback before adoption. |
| [Next.js](https://nextjs.org/docs) | Library | App Router, server rendering/actions, application backend. | M1–M7 | Integrated | Existing runtime dependency. Consult installed version's guides; validate server inputs, sessions, origins, and cache isolation. |
| [React](https://react.dev/) | Library | Dashboard and shared modal interactions. | M1 UI; M3 onward | Integrated | Existing runtime dependency. Preserve accessibility and safe rendering; avoid unnecessary client state and dependencies. |
| [TypeScript](https://www.typescriptlang.org/docs/) | Library | Static checking and shared data contracts. | All implementation | Integrated | Existing development dependency. Types do not replace runtime validation or authorization. |
| [Tailwind CSS](https://tailwindcss.com/docs) | Library | Existing responsive styling and design consistency. | M1 UI; refinements throughout | Integrated | Existing build dependency. Preserve approved styling and reduced-motion behavior; no second styling system needed. |

## Codex skills and testing

A [skill](https://developers.openai.com/plugins/concepts/skills) supplies workflow instructions/resources; a plugin may bundle skills and MCP servers. Neither is automatically an application library. Collection links below identify sources for selecting individual skills, not packages to install wholesale.

| Resource and official URL | Category | Purpose | Ventus milestone | Status | Dependencies, context, and security |
|---|---|---|---|---|---|
| [OpenAI Build Web Apps](https://github.com/openai/plugins) | Skill | Web-development workflows in the `plugins/build-web-apps` bundle; select only applicable guidance. | UI; later deployment | Research Only | Plugin collection, not proof of an installed named skill. Inspect selected instructions, companion tools, permissions, and overlap before use; no app dependency merely from reading. |
| [Supabase Agent Skills](https://github.com/supabase/agent-skills) | Skill | Evaluate `supabase-postgres-best-practices` for RLS, queries, locking, and data-access review. | M2 auth/database; **M3 priority** | Research Only | Instructions add context; inspect scripts before execution. Use targeted references; no authority to alter approved migrations, RLS, or hosted data. |
| [Vercel React Best Practices](https://github.com/vercel-labs/agent-skills) | Skill | Focused React/Next.js performance review when a measured problem warrants it. | UI refinement; M7 hardening | Research Only | Adds guidance/context, not a required runtime package. Check version compatibility; avoid speculative optimization or conflicts with project conventions. |
| [Playwright CLI](https://github.com/microsoft/playwright-cli) | Library | Developer CLI with optional agent skill for browser workflows, inspection, and test generation. | **M3 priority**; M7 acceptance | Research Only | Would add development tooling/browser requirements, not a production dependency. Browser sessions, traces, and screenshots can contain tokens/private data. CLI use alone is not a committed automated test suite. |
| [Trail of Bits Security Skills](https://github.com/trailofbits/skills) | Skill | Select applicable audit workflows for authorization and input-boundary review. | M3 security; M7 release | Research Only | Collection originates with Claude Code workflows; verify Codex compatibility and selected tool requirements. Limit context/permissions and inspect scripts; no blanket security guarantee. |
| [Ponytail](https://github.com/DietrichGebert/ponytail) | Skill | Codex plugin with focused change review (`ponytail-review`) and whole-repository audit (`ponytail-audit`); reports correctness, security, tests, performance, and simplification opportunities. | M3 review; later milestone reviews and authorized audits | Installed and used | Version 5.3.2; review and audit skills are accessible, and the focused review informed approved cleanup. No Ventus package dependency or declared MCP/OAuth connection. Node hooks read local source symbols and inject instructions; write local mode state. Preserve validation, RLS/RPC security, concurrency, accessibility, and history. |

### Ponytail installation and permissions

Installed October 20, 2026 using the [official Codex installation method](https://github.com/DietrichGebert/ponytail/blob/main/INSTALL.md#codex): `codex plugin marketplace add DietrichGebert/ponytail`, then `codex plugin add ponytail@ponytail`. Codex CLI `0.163.0-alpha.10.2` supports both commands; Node `v24.22.0` is available. Reviewed marketplace revision: `09c434ab73ca43761c5d8b0c5d341926c2fba710`; plugin cache: `~/.codex/plugins/cache/ponytail/ponytail/5.3.2`.

- The installed Codex manifest and hook sources match the inspected marketplace files. CLI listing confirms installed/enabled; both review/audit skill manifests are present. Seven JavaScript syntax checks and isolated executions of all three hook events passed using temporary state. No review, audit, or cleanup was run as part of installation.
- Despite the installation guide's reference to two hooks, this version's [hook manifest](https://github.com/DietrichGebert/ponytail/blob/main/hooks/claude-codex-hooks.json) declares `SessionStart`, `SubagentStart`, and `UserPromptSubmit`. They activate/inject instructions, propagate mode to existing subagents, and process mode commands; they do not grant permission to spawn agents.
- The inspected Codex hook path reads plugin/config files, maps local source symbols through `git ls-files` and file reads, and stores mode flags under Codex's plugin-data directory. An explicit default-mode command can write `~/.config/ponytail/config.json`. It adds model context; no network calls were found in this hook path. This is a scoped source review, not a guarantee about every bundled adapter or future update. Claude-specific band/session-import features were not enabled.
- The earlier installation checkpoint required interactive activation. Subsequent Milestone 3 work used the accessible `ponytail-review` skill; the full codebase audit was not run. This historical hook inspection is not a new hook audit.
- Prefer a targeted `ponytail-review` for the changed milestone; reserve `ponytail-audit` for an explicitly requested broader audit. Both are report-only skills. Findings do not authorize edits, dependency removal, or security simplification. Reinspect hooks before trusting an update from the marketplace's moving `main` reference.

## Libraries and reference implementations

| Resource and official URL | Category | Purpose | Ventus milestone | Status | Dependencies, context, and security |
|---|---|---|---|---|---|
| [Super Productivity](https://github.com/super-productivity/super-productivity) | Reference Repository | Study task-management interaction and scheduling approaches selectively. | M3 tasks; M4 recurrence | Research Only | Separate application, not a drop-in dependency. Read targeted files; review licensing before code reuse; do not import its stack or redesign Ventus. |
| [Habitica](https://github.com/HabitRPG/habitica) | Reference Repository | Study task/reward history and gamification concepts. | Later product Phase 2 | Deferred | Separate application, not a reward engine for Ventus. Targeted reading only; inspect license before reuse. No scoring or rewards work authorized. |
| [rrule.js](https://github.com/jkbrzt/rrule) | Library | Candidate recurrence-rule parsing and expansion. | M4 recurrence | Deferred | Would add runtime dependency. Evaluate maintenance, bounded expansion, DST and date semantics; adoption and recurrence decisions require approval. |
| [Google APIs Node.js Client](https://github.com/googleapis/google-api-nodejs-client) | Library | Candidate official client for Google Calendar API and OAuth. | M5 outbound; M6 inbound Calendar | Deferred | Would add server dependency. Protect OAuth tokens, minimize scopes, and design retries/quotas/conflict handling; product approval does not establish installed client/setup. |
| [shadcn/ui](https://github.com/shadcn-ui/ui) | Library | Optional component source for a demonstrated accessibility/UI gap. | UI refinement; M7 hardening if needed | Deferred | Copies maintained component code and may add dependencies. Review selected component requirements; preserve existing modal/design rather than replacing them by default. |

## Additional development tools

| Resource and official URL | Category | Purpose | Ventus milestone | Status | Dependencies, context, and security |
|---|---|---|---|---|---|
| [Codebase Memory MCP](https://github.com/DeusData/codebase-memory-mcp) | MCP Server | Candidate persistent code index/relationship queries if targeted search becomes insufficient. | Cross-milestone maintenance | Research Only | Additional executable/server and stored index; evaluate filesystem access, code retention, and exposed tools. Token/performance claims require measurement against `rg`; no benefit assumed. |
| [OpenDesign](https://github.com/nexu-io/open-design) | Platform | Separate design-agent workspace for possible future approved prototyping. | UI exploration, only if requested | Research Only | Not a Ventus component library. Running it introduces a separate tool stack and potentially provider/network permissions; review data handling and overlap with existing tools. |
| [Transitions.dev](https://github.com/Jakubantalik/transitions.dev) | Reference Repository | Selective motion examples; also offers optional skills/CLI. | UI refinement, only if justified | Research Only | Reading adds context only; adopting snippets adds maintained CSS/code, while CLI/skills introduce tooling/instructions. Review license and scripts; preserve restrained motion and reduced-motion support. |

## Skill selection principles

1. Use the minimum number of skills necessary; activate only those relevant to the current task.
2. Prefer maintained, authoritative resources; recheck compatibility and maintenance before adoption.
3. Avoid overlapping skills and conflicting instructions. Project requirements and authorized scope remain controlling.
4. Select one applicable skill rather than installing an entire collection.
5. Inspect third-party instructions, scripts, dependencies, licenses, permissions, network access, and data retention before enabling skills or MCP servers. Grant only necessary access.
6. Verify benefit on a representative task: correctness, time, context usage, and maintenance cost. Do not assume a skill improves performance.
7. Prefer targeted official documentation and files over loading entire repositories. Start with existing code, `rg`, and current tooling.
8. Record authorization and actual installation/integration evidence when updating statuses. Research is not approval; adoption does not replace testing.

## Recommended milestone usage

| Work | First choice | Conditional evaluation |
|---|---|---|
| UI implementation/refinement | Existing React, Tailwind, Next.js and approved design | Relevant Build Web Apps guidance; Vercel React skill for measured performance issues. shadcn/ui only for a demonstrated gap; OpenDesign/Transitions.dev only when needed. |
| Authentication/database | Existing official Supabase clients, SSR flow, schema/RPC documents | A focused Supabase skill; targeted security review. |
| Persistent task operations — M3 | Existing session-verified server access, RLS/RPC contracts, Node tests | **Evaluate Supabase best practices and Playwright CLI first; install neither yet.** Super Productivity only for a concrete behavior question. |
| Recurrence — M4 | Approved date/occurrence/history model and explicit rule decisions | Evaluate rrule.js with DST/month-boundary/bounded-expansion tests; targeted reference reading. |
| Google Calendar — M5/M6 | Official Calendar/OAuth documentation and approved synchronization contracts | Evaluate Google APIs Node.js Client; protect credentials and verify retries, conflicts, and isolation. |
| Gamification — later Phase 2 | Preserved occurrence/activity history; separately approved scoring | Habitica as a reference only. |
| Automated testing | Existing Node runner, auth/task suites, lint/typecheck/build | Evaluate Playwright CLI and whether maintained browser tests are needed; distinguish mock results from real database verification. |
| Security review | `SECURITY.md`, owned server boundaries, anonymous/two-user tests | Targeted Supabase and Trail of Bits guidance; verify tool compatibility and permissions first. |
| Deployment — M7 | Release gates, recovery/rollback plan, explicit deployment approval | Evaluate Vercel hosting, budget, preview isolation, and scheduling requirements; only relevant deployment skills. |

### Current persistence priority

Stage 1 reads, Stage 2A creation/editing and Stage 2B lifecycle operations are implemented locally. The owner reported hosted Stage 2A persistence and two-user browser isolation passed; hosted Stage 2B lifecycle behavior remains unverified. Recurrence, Calendar, gamification, and deployment remain out of scope.

Evaluate the Supabase best-practices skill against existing RLS, ownership, concurrency, and query contracts without changing the approved backend. Evaluate Playwright CLI for repeatable create/edit/subtask, retained-draft, conflict, refresh/login, and isolated-account browser checks. Compare added tooling cost with existing checks before requesting adoption. Use dedicated authorized accounts for any later hosted tests; mocked browser results cannot establish hosted persistence or RLS. **This inventory authorizes no installation or hosted operation.**
