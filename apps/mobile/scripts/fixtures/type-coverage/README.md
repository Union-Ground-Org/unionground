# Type-coverage ratchet fixtures

A standalone TypeScript project measured by
`src/lib/typeCoverageRatchet.test.ts`. The unsafe files carry each escape the
ratchet exists to surface — an `any` boundary, an `as any` cast, an
`as unknown as` double assertion and a `@ts-ignore` — so the gate is proven to
fail before it is trusted. The safe file is the typed counterpart.

`apps/mobile/tsconfig.json` excludes this directory, so the fixtures never enter
`tsc --noEmit`, the Expo bundle or the maintained baseline.
