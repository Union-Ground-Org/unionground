# Secret-fallback ban fixtures

These files exist so the blocking gate in `scripts/verify-env-fallback-ban.mjs`
can be proven to reject and accept the exact shapes it claims to. They are
excluded from the production scan scope (`SCAN_EXCLUSIONS`) because a fixture's
purpose is to carry the unsafe shape.

Every value here is an obvious placeholder. Nothing in this directory is, or
resembles, a real credential.
