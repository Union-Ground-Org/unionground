# Contributing to Union Ground

Thank you for helping. Union Ground is free software under the GNU Affero
General Public License, version 3 only (see [`LICENSE`](LICENSE) and
[`NOTICE`](NOTICE)). This guide covers setting up, testing, opening a pull
request and signing the Contributor License Agreement.

Found a security problem? Do not open an issue or pull request. Follow
[`SECURITY.md`](SECURITY.md) instead.

## Set up

You need Node.js 22 (the exact major version is in `.nvmrc`; `package.json`
lists the supported range) and npm. For database work you also need Docker,
which the Supabase CLI uses to run a local database.

```sh
git clone <your fork's URL>
cd <your fork's directory>
npm ci
cp .env.example .env.local   # then fill in values for your own test project
npm run dev                  # web app at the address Vite prints
```

Use your own Supabase project or a local one (`npx supabase start`) for
development. Never point a development copy at someone else's production
service, and never commit `.env.local` or any key.

The phone app lives in `apps/mobile` (Expo and React Native) and has its own
dependencies:

```sh
cd apps/mobile
npm ci
npm start
```

## Run the tests

The test runner is [Vitest](https://vitest.dev). The full suite is large, so
run the tests for the files you changed and for the files that import them:

```sh
npx vitest run --pool=threads tests/some-feature.test.js
npx vitest run --pool=threads -t "name of one test"
```

Find the tests that cover a file by searching `tests/` for its name. Phone app
tests run from `apps/mobile` with `npx vitest run <file>`, and its type check
with `npm run typecheck`.

Before you open a pull request, also run:

```sh
npx eslint <the files you changed>
npm run verify:conventions
npm run verify:licenses      # when you add or change a dependency
```

`npm run check` runs the whole local gate (lint, every test and the build).
It is slow; continuous integration runs it on every pull request, so you do
not need to run it yourself for a small change.

## Open a pull request

1. Fork the repository and create a branch from the default branch.
2. Keep each pull request to one change. Small, focused pull requests are
   reviewed fastest.
3. Add or update tests for what you change. A bug fix should come with a test
   that fails without the fix.
4. Write the title as what the change does for people using Union Ground.
   In the description say what the problem was, how you solved it and how you
   checked it. Link the issue it fixes (`Fixes #123`).
5. A change that removes or replaces a feature removes its old code, tests
   and data in the same pull request.
6. Make sure continuous integration passes. A maintainer reviews the pull
   request and may ask for changes.

Dependencies must use a license compatible with the AGPL. The license check
(`npm run verify:licenses`) fails on licenses that are not.

## Sign the Contributor License Agreement

Before your first contribution can be merged you must agree to the
[Contributor License Agreement](CLA.md). When you open your first pull
request, a bot posts a comment with the agreement. Reply with the sentence it
asks for:

> I have read the CLA Document and I hereby sign the CLA

You sign once; the signature covers your later contributions. If you
contribute on behalf of an employer or another organization, that
organization must also accept the entity agreement in [`CLA.md`](CLA.md) before
your contribution is merged; ask a maintainer how.

Maintainers who work for Union Ground LLC do not sign: the LLC already owns
what they write, and the CLA workflow lists their accounts as exempt.

Why a CLA: Union Ground LLC runs the official hosted Union Ground service and
publishes the official apps. The agreement lets the LLC use contributions in
that service and those apps, as well as in this repository. You keep the
copyright in your contribution.

## How changes move between this repository and the hosted service

Union Ground LLC develops the official hosted service alongside this
repository. The maintainers may integrate fixes and features from the hosted
service into this repository, and may bring contributions made here into the
hosted service. A change you see land here may therefore arrive as part of a
larger update from the maintainers.

## Conduct

Everyone taking part in this project, in issues, pull requests, discussions
and any other space, follows the [Code of Conduct](CODE_OF_CONDUCT.md). Be
kind, assume good intent, and keep criticism about the work, not the person.

Union Ground serves workers and the organizations they build. Do not put real
people's personal information, real member records or real organization data
into issues, pull requests, tests or fixtures. Use fictional examples; the
project's sample organization is "Tamarack".

## Trademarks

The code is free software; the Union Ground name and logo are not. If you
publish your own version, give it your own name and logo. See
[`TRADEMARKS.md`](TRADEMARKS.md).
