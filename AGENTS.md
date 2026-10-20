# Ventus — Codex Development Instructions

## 1. Project Overview

Ventus is a modern, minimalist task management web application with Google Calendar integration and a future gamification system.

The application will support public account registration, private user data, recurring tasks, and a premium, responsive user interface.

The primary development objective is to produce reliable, maintainable, secure software while keeping implementation complexity and AI token consumption low.

## 2. Technology Stack

Current:
- Next.js 16 with App Router
- React 19
- TypeScript
- Tailwind CSS 4
- ESLint
- npm
- Supabase email/password Authentication with official clients (`@supabase/supabase-js` and `@supabase/ssr`) and SSR sessions; registration, login, logout, and protected Dashboard access manually verified by the project owner; password recovery pending manual verification due to Supabase rate limiting

Planned, subject to approval:
- Supabase PostgreSQL application tables and RLS; production Auth configuration and release verification
- Google Calendar API
- shadcn/ui
- Playwright
- Vercel deployment

Use existing dependencies and conventions whenever practical. Do not introduce new frameworks, libraries, services, or infrastructure without explaining the justification.

## 3. Development Principles

- Prefer the simplest solution that satisfies the requirements.
- Write readable, modular, maintainable TypeScript.
- Reuse components and shared logic where appropriate.
- Avoid unnecessary abstractions, premature optimization, and duplicated functionality.
- Follow established Next.js and React conventions.
- Prefer official documentation and maintained libraries.
- Preserve existing functionality when modifying features.
- Do not implement unrequested features.

## 4. Product and Design Requirements

Ventus is being developed incrementally.

### Phase 1 — Task Management
- Secure user registration and authentication.
- Weekly Sunday–Saturday navigation.
- Daily task management.
- Scheduled, anytime, and overdue tasks.
- Task categories and completion tracking.
- Recurring tasks and dated subtasks.
- Task postponement and cancellation.
- Two-way Google Calendar synchronization.

### Phase 2 — Gamification
- Category-based task points and penalties.
- Lifetime XP and progression.
- Monthly competitive rankings.
- Performance analytics and dashboards.

Do not implement Phase 2 unless explicitly requested.

### UI/UX Standards
- Minimal, professional, desktop-first interface.
- Subtle liquid-glass visual treatment.
- Strong typography and clear visual hierarchy.
- Consistent spacing, responsive layouts, and accessible interactions.
- Restrained animations that respect reduced-motion preferences.
- Avoid unnecessary decorative elements or visual clutter.

Follow approved design references when available. Do not redesign approved interfaces without authorization.

Detailed requirements belong in separate project documentation rather than this file.

## 5. Architecture and Security

- Keep business logic separate from presentation components.
- Validate user input at appropriate system boundaries.
- Never trust client-provided user IDs, authorization claims, or reward calculations.
- Enforce authorization on protected backend and database operations.
- Design for strict isolation between user accounts.
- Use Supabase Row Level Security when the database is introduced.
- Never expose privileged application credentials (including Supabase secret/service-role keys) or Google OAuth access/refresh tokens to the browser.
- Browser-side Supabase user-session access/refresh tokens are permitted through the approved standard Supabase SSR authentication flow. Treat them as sensitive bearer credentials; enforce server-side authorization, RLS when the database is introduced, XSS/CSRF protections, and secure session handling.
- Never commit credentials, environment files containing secrets, or private user data.
- Keep Google Calendar credentials and synchronization logic secure.
- Use reliable identifiers and idempotent operations where duplicate processing is possible.

Preserve task occurrence and completion history so future analytics and reward calculations can be implemented accurately.

## 6. Codex Workflow

For each development request:

1. Inspect only the relevant files and existing conventions.
2. Identify the smallest implementation that satisfies the request.
3. Make focused changes without modifying unrelated functionality.
4. Run appropriate checks.
5. Review the resulting changes for errors and unintended behavior.
6. Report what changed, what was tested, and any remaining limitations.

Ask for clarification when a requirement is genuinely ambiguous or an architectural decision is consequential.

Do not repeatedly request approval for routine implementation details already covered by project requirements.

Do not create Git commits, push changes, deploy, or modify external services unless explicitly instructed.

## 7. Testing and Verification

Current project commands:

- `npm run lint`
- `npm run typecheck`
- `npm run build`
- `npm run test:auth`
- `npm run dev`

Run relevant checks after making changes.

Before claiming success, distinguish between:
- Code written
- Checks passed
- Functionality actually verified

As the application develops:
- Add unit tests for business rules.
- Add integration tests for database access and authorization.
- Add browser-based tests for critical user workflows.
- Test edge cases involving recurrence, time zones, missed deadlines, and synchronization.

Do not claim a feature works unless it has been appropriately verified.

## 8. Git and Repository Management

- Preserve the existing Git history.
- Keep changes focused and reviewable.
- Do not overwrite unrelated work.
- Never force-push or rewrite published history without explicit authorization.
- Respect `.gitignore`.
- Do not commit generated artifacts or unnecessary dependencies.

The public GitHub repository is `dbellis4-cmd/ventus`.

## 9. Efficiency and Token Management

- Read only files relevant to the current task.
- Avoid repeatedly loading the entire repository.
- Prefer targeted searches over broad exploration.
- Keep explanations concise unless deeper instruction is requested.
- Do not generate extensive documentation for routine changes.
- Use specialized skills only when they materially improve the task.
- Avoid installing overlapping skills or unnecessary MCP servers.
- Use existing project context instead of repeatedly reconstructing architectural decisions.

Prioritize verified functionality and maintainability over code volume.

## 10. Communication

The project owner is learning software engineering through AI-assisted development.

Provide concise summaries of implementation decisions and explain important engineering concepts when they directly relate to the work.

For completed tasks, report:
- Changes made
- Checks performed and their results
- Any blockers or unresolved issues

Avoid unnecessary commentary and lengthy explanations.

When implementation involves significant architectural, security, or cost implications, explain the tradeoffs before proceeding.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
