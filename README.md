# Ventus

A minimal Next.js application using TypeScript, Tailwind CSS, ESLint, and the App Router.

## Requirements

- Node.js 22.13 or newer (Node.js 24 LTS is recommended)
- npm

## Local development

```sh
npm ci
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Edit `app/page.tsx` to update the homepage.

## Checks

```sh
npm run lint
npm run typecheck
npm run build
```

To serve a production build locally, run `npm run build` followed by `npm start`.

The project intentionally has no authentication, database, or external service integrations.

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
