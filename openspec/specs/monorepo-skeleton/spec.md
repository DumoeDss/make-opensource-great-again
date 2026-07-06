# monorepo-skeleton

## Purpose

Establishes the npm-workspaces monorepo toolchain (packages, TypeScript config, build, and test runner) that every `@mosga/*` package builds on.

## Requirements

### Requirement: npm-workspaces monorepo layout

The repository root SHALL be an npm-workspaces monorepo. The root `package.json` SHALL declare `"private": true`, `"type": "module"`, and a `"workspaces"` glob covering `packages/*`. Each package SHALL live at `packages/<name>/` and be published-ready under the `@mosga/` scope (though publishing itself is out of scope for this change).

#### Scenario: Workspace resolution succeeds from a clean checkout

- **WHEN** a developer runs the install command at the repo root on a clean checkout
- **THEN** npm resolves every `packages/*` workspace and links inter-package dependencies (e.g. `@mosga/session-readers` → `@mosga/contracts`) without a registry fetch for the local packages

#### Scenario: Inter-package import resolves by package name

- **WHEN** `@mosga/session-readers` imports from `@mosga/contracts` by its package name
- **THEN** the import resolves to the local workspace package (not a published version) at build and test time

### Requirement: TypeScript ESM configuration

The monorepo SHALL use a shared `tsconfig.base.json` at the root that every package's `tsconfig.json` extends. The shared config SHALL target modern ESM (`"module": "NodeNext"` / `"moduleResolution": "NodeNext"`, `"target"` ES2022 or later), enable `"strict": true`, and emit declaration files. All source SHALL be authored as ESM (no CommonJS `require`).

#### Scenario: Package tsconfig extends the shared base

- **WHEN** a package's `tsconfig.json` is type-checked
- **THEN** it extends `tsconfig.base.json` and inherits strict ESM settings without redeclaring them

#### Scenario: Type-check passes with no errors

- **WHEN** `tsc --noEmit` (or the equivalent workspace type-check) runs across all packages
- **THEN** it completes with zero type errors under `strict` mode

### Requirement: tsup build emits ESM plus type declarations

Each publishable package SHALL build with tsup, emitting an ESM bundle plus `.d.ts` declaration files into the package's `dist/`. Each package's `package.json` SHALL declare `"exports"`, `"main"`/`"module"`, and `"types"` pointing at the built artifacts.

#### Scenario: Build produces ESM and declarations

- **WHEN** the build command runs for a package
- **THEN** `dist/` contains an ESM `.js` entry and matching `.d.ts` declarations, and no CommonJS output is required for the package to be consumed

### Requirement: Root vitest test runner

The monorepo SHALL run tests with vitest via a single root command that discovers and executes every package's tests. Test fixtures SHALL be hand-crafted fake data only; no real session data is ever committed.

#### Scenario: Root test command runs all package tests

- **WHEN** the root test command is invoked
- **THEN** vitest discovers and runs the test files across all workspaces and reports a single aggregated result

#### Scenario: A trivial smoke test passes on the fresh skeleton

- **WHEN** the skeleton is first stood up with at least one placeholder/smoke test per package
- **THEN** the root test command exits green, proving the toolchain (resolution → build/transpile → test) is wired end to end
