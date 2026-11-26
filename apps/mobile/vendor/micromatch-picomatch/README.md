# micromatch-picomatch (vendored)

A minimal, `micromatch`-compatible module backed by
[`picomatch`](https://github.com/micromatch/picomatch) alone. The phone app's
`package.json` overrides `micromatch` with this folder so that
[`braces`](https://github.com/micromatch/braces) never enters the build.

`braces` <= 3.0.3 carries GHSA-vfj7-8cjw-p6xm (a deeply nested brace pattern
exhausts the call stack) and has no patched release. It reaches an Expo build
only through `expo -> @expo/metro -> metro-file-map -> micromatch -> braces`,
and `metro-file-map` calls exactly one function, `micromatch.some()`, which is
pure `picomatch`. A differential test of this module against `micromatch`
4.0.8 over that call shape found no mismatches in 325 cases.

| Export | Behavior |
| --- | --- |
| `micromatch(list, patterns, options)` | filters `list` with `picomatch` |
| `micromatch.some` | the function Metro calls |
| `micromatch.isMatch` / `micromatch.any` | single-string match |
| `micromatch.matcher` | returns a `picomatch` matcher |
| `micromatch.makeRe` | returns `picomatch.makeRe` |
| `micromatch.braces`, `.braceExpand`, `.expand`, `.parse` | **throw** a clear `Error` |

The brace entry points throw on purpose: if a future Metro release starts
calling one, the build fails loudly instead of behaving differently. This is
not a general-purpose `micromatch` replacement.

It lives in this repository, not in a separate package repository, so the
build depends on nothing outside it and the installed bytes change only
through a reviewed change here. `tests/security-trivy-braces-removal.test.js`
keeps the override and the lockfile pointed at this folder.

MIT licensed; see [LICENSE](LICENSE), which is kept as published.
