# Security scanner fixtures

`node scripts/run-security-scan.mjs self-test` scans this directory with the
exact pinned scanner images and fails when a scanner does not report its own
unsafe fixture, or reports the safe one. The gate is proven here before it is
trusted anywhere else.

Every ERROR-severity rule in `config/semgrep-rules.yml` carries a reviewed
unsafe/safe fixture pair under `semgrep/unsafe/` and `semgrep/safe/`. The
self-test derives the blocking rule identifiers from the ruleset itself and
fails by rule identifier when any blocking rule produces no unsafe-fixture
finding, so adding a blocking rule without fixtures fails immediately.

The directory is excluded from the production scan scope
(`config/security-scanner-policy.json` exclusions and the `config/gitleaks.toml`
allowlist), because a fixture's purpose is to carry the unsafe shape.

Every value here is an obvious synthetic placeholder. Nothing in this directory
is, or resembles, a real credential.
