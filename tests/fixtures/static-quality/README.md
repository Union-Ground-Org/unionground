# Static quality fixtures

Deterministic inputs for `tests/static-quality-gates.test.js`: one import cycle,
one unused export beside a used one, and one duplicated block. The production
analysis skips `tests/fixtures/`, so these never enter the repository baseline.
