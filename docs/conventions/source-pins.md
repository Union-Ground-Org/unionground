# Independent source pins

PRs retain independently reviewed values without rewriting a shared digest.
No merge driver or post-merge repair is required, including in GitHub's merge
queue. Changes to the same reviewed value can still conflict and require a
review; unrelated values do not share a generated line.

- Telemetry: `config/telemetry-disclosure-sources.json` is a schema 2 descriptor.
  Its `.d` directory holds one pin for each group/source pair. The collector
  still discovers all storage and cookie writers and checks the complete key
  constructors, SDK identities and configuration. After reviewing the
  disclosure, use `node scripts/render-telemetry-disclosure.mjs
  --review-source-inventory`. The existing telemetry test compares the full
  collected value with the reconstructed pin map, including additions/removals.
- Reviewer packet: `config/legal-catalogue-pins` binds every exact English and
  Spanish legal key/value to its catalogue source identity. Unrelated Home or
  Work translations no longer invalidate the legal packet. New, removed and
  changed legal keys fail `node scripts/legal-catalogue-pins.mjs` and the
  existing legal parity test. After reviewing copy, update with `--review`.
- Mobile types: `type-coverage-baseline.json` stays the initial policy floor.
  `npm --prefix apps/mobile run type-coverage:update` adds a content-addressed
  receipt to `apps/mobile/type-coverage-ratchets/` only when floors rise or
  ceilings tighten. Readers compose the maximum aggregate/per-file floors and
  minimum suppression ceilings. The aggregate is only a backstop: the ratchet
  measures the comparison base in-run and judges the aggregate against it, and
  updates no longer raise the committed aggregate. Retired file floors remain recorded. Exact
  pull-request, push and merge-group base blobs include their receipts, so
  removing or lowering them cannot erase the historical floor. Dates and file
  counts in the initial baseline describe its initial measurement; the command
  reports the current measurement. No receipt is emitted for metadata alone.

Pin filenames are SHA-256 of the key stored inside each file; both identity
and value are validated. Only regular files in a regular directory are allowed.
Telemetry and legal comparisons require exact sets.
Type receipts additionally hash their full payload;
their join can only tighten policy. Pin regeneration remains an explicit review
action and never runs on a validator's check path.

Run `node --test tests/source-pin-integration.node-test.mjs` for a real Git
exercise of independent deliveries in both merge orders, using the collectors,
type checker and exact historical readers. The root Vitest suite also runs it.
