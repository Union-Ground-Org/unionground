# Provenance: every fact carries its source

**Enforced by:** `npm run verify:conventions` (`scripts/verify-repository-conventions.mjs`, section 4, for `data/reference/` files and for migrations; the "Repository conventions" step of the `conventions-and-lint` job in `.github/workflows/ci.yml`) and the loaders that call `scripts/lib/provenance.mjs`.
**Origin:** the contract and `scripts/lib/provenance.mjs` arrived on October 14, 2026; this document and the migration rule were adopted on November 11, 2026, with the checker.

## The rule

A reader must be able to go from any figure, document, lesson, deadline or fact
in the product back to the exact public bytes it came from, see when they were
captured, and see how they were turned into what is shown. Nothing is displayed
without that chain and nothing is loaded without it. "Unknown" is a refusal,
not a default.

## The record

```json
{
  "provenance_id": "prov-<sha256 of the canonical JSON without this field>",
  "source": {
    "url": "https://...",
    "publisher": "State labor relations board",
    "title": "Decision ...",
    "document_date": "2026-03-14"
  },
  "retrieved_at": "2026-10-12T07:01:22Z",
  "content_sha256": "<hex SHA-256 of the captured bytes>",
  "capture": { "method": "http-get", "tool": "name@version", "run_id": "lane-unit-or-job id" },
  "extraction": { "method": "verbatim", "extractor": "model or script @ version", "quote_binding": "exact-substring" },
  "as_of": "2026-03-14",
  "derived_from": ["prov-...", "<owner>/<repo>@<commit>:<path>"],
  "review": { "status": "unreviewed", "reviewed_at": null, "reviewer_role": "lane", "note": "" },
  "reuse": { "basis": "public-record", "note": "" }
}
```

The JSON Schema is [`schemas/provenance.schema.json`](../../schemas/provenance.schema.json).

| Field | Required | Meaning |
|---|---|---|
| `provenance_id` | yes | `prov-` plus the SHA-256 of the record's canonical JSON (keys sorted at every depth, no whitespace) without this field. A changed record has a different id. |
| `source.url` | yes | Absolute `http`/`https` URL of what was captured, without credentials. |
| `source.publisher` | yes | Who published it. Describes the source only. |
| `source.title`, `source.document_date` | no | Title of the document; its own date (`YYYY-MM-DD`). |
| `retrieved_at` | yes | When the bytes were captured, RFC 3339 UTC ending in `Z`. Displayed in Eastern time. |
| `content_sha256` | yes | SHA-256 of the captured bytes (for computed or authored items, of the output). |
| `capture.method` | yes | `http-get`, `firecrawl`, `browser`, `bulk-file`, `prr-production`, `computed` or `authored`. `tool` and `run_id` say what ran. |
| `extraction` | no, except computed | `method` (`verbatim`, `model`, `script`, `manual`), `extractor` (name@version), `quote_binding` (`exact-substring`, `offsets`, `none`). |
| `as_of` | yes | The date (or UTC timestamp) the content is valid as of. |
| `derived_from` | computed and authored | Every input: a `prov-` id of a full record, or `owner/repo@<commit>:<path>`. |
| `review.status` | yes | `unreviewed` or `reviewed`. A reviewed record also needs `reviewed_at` and `reviewer_role` (`lane`, `platform_editor`, `owner`). |
| `reuse` | no | `basis` (`public-record`, `public-domain`, `license`, `fair-use-excerpt`, `owner-authored`) and a note. |

Further rules `validate()` applies:

- Unknown fields are refused at every level. A field that is not in the
  contract cannot carry a name, an offset or anything else past review.
- A computed record (`capture.method` = `computed`) lists every input in
  `derived_from` and names its script and version in `extraction.extractor`.
- An authored record (glossary entry, lesson, explainer) lists the sources it
  rests on in `derived_from`, each a full record.
- Timestamps must be real and may not run ahead of the checking clock by more
  than five minutes.
- A refreshed capture is a new record with a new `retrieved_at` and
  `content_sha256`. Keep the old one; never overwrite it.

## The helper

`scripts/lib/provenance.mjs` is the only place records are built and checked.

```js
import { assertProvenance, stamp, validate, validateDocument } from "./lib/provenance.mjs";

const record = stamp({
  bytes,                       // or contentSha256 when the bytes were hashed while streaming
  source: { url, publisher, title },
  retrievedAt: new Date(),     // stored as UTC
  capture: { method: "http-get", tool: "node-fetch@22", run_id: "L2a-unit-3" },
  asOf: "2026-03-14",
  reuse: { basis: "public-record" },
});                            // throws ProvenanceError if anything required is missing

assertProvenance(row.provenance, `row ${index}`);   // loaders: refuse, never default
```

- `stamp()` copies its inputs, hashes the bytes, fingerprints the record,
  throws a `ProvenanceError` listing every problem if the record is incomplete,
  and returns it frozen so it cannot change after its id was computed. A
  timestamp string must carry a real date, time and offset; February 30 is
  refused, not rolled into March.
- `validate(record)` returns `{ ok, errors }`; `assertProvenance()` throws.
- `fingerprint(record)` returns the `provenance_id`.
- `validateDocument(json)` checks every value under a `provenance` key in a
  document, requires at least one, and requires every `prov-` id in a
  `derived_from` to be a complete record in the same document.

A loader that meets a record it cannot validate stops and reports the record.
It never fills a default.

## Database tables

Every new reference or content table carries the record in one column, checked
in the migration that creates it. A migration that creates a table whose name
starts with `catalog_`, `reference_`, `research_` or `content_` must, in its
`CREATE TABLE` statement:

- declare the column as exactly `provenance pg_catalog.jsonb not null`, with
  nothing else on that column (no default, no generated value, no column
  CHECK). The type is qualified because PostgreSQL searches `pg_temp` for type
  names before `pg_catalog`, so a temporary domain or table named `jsonb` could
  otherwise take the column and later drop it with `CASCADE`. Tables created
  before the rule required this used the documented `jsonb`, and the migrations
  that created them shadow no type; and
- declare the predicate below, token for token, as the table constraint
  `<table>_provenance_complete`. Naming a key is not requiring it, so do not
  rewrite the predicate. Further CHECK constraints may sit beside it; they can
  only restrict more.

Later migrations do not rename such a table, weaken its `provenance` column or
drop its constraint, and do not create one through `SELECT ... INTO`, foreign
tables, inheritance, or SQL assembled inside a `DO` block, a function body or
an `EXECUTE` string.

`npm run verify:conventions` enforces this for every migration after
`20261019224500` (the last migration present when this repository adopted the
rule) that is not yet on `main`. The check fails closed: a statement
may name such a table only in a shape known to leave the column and its CHECK
intact, and any other statement naming one is refused. The allowed shapes are:

- the `CREATE TABLE` below, written as exactly `create table <name> (...)` with
  nothing after the column list (no `IF NOT EXISTS`, `TEMP`, `UNLOGGED`, `LIKE`,
  `INHERITS`, `PARTITION BY`, `WITH` or `AS`), and the constraint element
  exactly `constraint <table>_provenance_complete check (<predicate>)` with
  nothing after the predicate (no `NO INHERIT`, `NOT VALID` or `NOT ENFORCED`);
- DML, `GRANT`/`REVOKE`, `COMMENT`, `DROP`, `CREATE INDEX`, `CREATE POLICY`,
  and routines and views that read the table;
- an `ALTER` that does not touch the `provenance` column or the
  `<table>_provenance_complete` constraint, rename the table, or attach it to
  an inheritance or partition tree. An `ADD CHECK` may mention `provenance`,
  because it can only restrict further.

Always refused: `IMPORT FOREIGN SCHEMA`, `CREATE FOREIGN TABLE` with such a
name, `INHERITS (...)` or `PARTITION OF` naming one, `CREATE SCHEMA ...
CREATE TABLE` naming one, a trigger on one, `ALTER TABLE ... OF` on one, a
name whose `<table>_provenance_complete` constraint would pass PostgreSQL's
63-byte identifier limit, any such table created inside a `DO` block, a routine
body or an `EXECUTE` string, `CREATE OPERATOR`, and a `search_path` that names
another schema ahead of `pg_catalog` (an operator there could make the CHECK
always true; a quoted `"PG_CATALOG"` or `"pg_catalog "` is another schema,
a `SET search_path` string must be `''` or a plain lowercase name because
`SET` takes each string as one exact name, and a `set_config` value may not
contain a double quote), a `set_config` whose setting name or `search_path` value is not
one constant string, and any change to `standard_conforming_strings` (with it
off, backslash escapes decode to SQL the check never read). The check reads `DO` bodies,
routine bodies and `EXECUTE` operands as SQL, and no other string literal, so
a `COMMENT` that mentions "execute" is just a comment. `EXECUTE` in a `DO` or
routine body must run one constant string; SQL assembled from `format()`, `||`
or a variable is refused, including the `execute definition` function-rewrite
pattern that older migrations used. Write that change as a top-level
`create or replace function` instead.

Copy this shape:

<!-- provenance-check-sql -->
```sql
create table private.reference_example (
  id uuid primary key default extensions.gen_random_uuid(),
  provenance pg_catalog.jsonb not null,
  constraint reference_example_provenance_complete check (
    jsonb_typeof(provenance) = 'object'
    and coalesce(provenance ->> 'provenance_id', '') ~ '^prov-[0-9a-f]{64}$'
    and pg_catalog.btrim(coalesce(provenance -> 'source' ->> 'url', '')) ~ '^https?://'
    and pg_catalog.btrim(coalesce(provenance -> 'source' ->> 'publisher', '')) <> ''
    and pg_catalog.btrim(coalesce(provenance ->> 'retrieved_at', '')) <> ''
    and coalesce(provenance ->> 'content_sha256', '') ~ '^[0-9a-f]{64}$'
    and pg_catalog.btrim(coalesce(provenance -> 'capture' ->> 'method', '')) <> ''
    and pg_catalog.btrim(coalesce(provenance ->> 'as_of', '')) <> ''
    and pg_catalog.btrim(coalesce(provenance -> 'review' ->> 'status', '')) <> ''
  )
);
```

The CHECK is the last line of defence, not the validator: loaders run
`assertProvenance()` before they write, and only that recomputes the
fingerprint. Existing tables are not altered by this contract.

## Reference data files

Any `.json` file under `data/reference/` must pass `validateDocument()`: it
carries at least one record under a `provenance` key (on the file, a row or a
cell, as the data needs), every record is complete, and every `prov-` input it
cites is in the same file. `npm run verify:conventions` fails otherwise.

## Display

Every member-facing figure or document added under this contract renders the
shared source line:

- Web: `src/components/SourceLine.jsx`.
- Mobile: `apps/mobile/src/components/SourceLine.tsx`.

Both read the same model (`src/lib/sourceLine.js`) and strings
(`src/lib/i18n/sourceLine.js`, English and Spanish): "Source: *publisher*,
retrieved *date*", the publisher linked to `source.url`, the date in Eastern
time. A computed or authored item adds an expandable list of its inputs. The
model applies the validator's shape rules to the required fields (the exact
stored URL, a real UTC capture time, the id and digest formats); a record that
fails them says so ("Source record missing") instead of rendering as if it
were sourced. It does not recompute the fingerprint, which is a content hash
rather than a signature: whoever could forge a row could recompute it.

## Existing provenance in this repository

These tables predate the contract. They keep their columns; the contract does
not alter them.

| Table | What it records | Conforms? |
|---|---|---|
| `public.organization_knowledge_conversions` | `source_sha256` of the exact converted bytes, `converter_name`, `converter_version`, `pipeline_version`, `converted_at`, review time | Partly. Bytes, method and version are recorded; the source is an uploaded file named by `organization_knowledge_sources.label`, with no URL, publisher, `as_of` or reuse basis. |
| `private.learning_content` | `payload` `source`, `attribution`, `rights_note` and `review_note`, required before publication by `learning_publication_review` | Partly. Source text, reuse note and review note are required to publish; no capture time, content hash or capture method. |
| `private.catalog_contacts`, `private.catalog_documents` | `source_url` (contacts) or `url` (documents), `as_of`, `content_sha256` of the row | Partly. Source and as-of date are recorded; the hash covers the row, not the captured bytes, and the publisher, retrieval time and capture method are carried by the release artifact rather than the row. |
| `private.catalog_organizations` | `source_urls[]`, `content_sha256` of the row | Partly, as above, with no per-row as-of date. |
| `private.catalog_releases` | `source_sha256`, `artifact_sha256`, `source_built_at`, `verified_sha256` | Yes for the release as a whole: it binds the exact export bytes and when they were built. |
| `private.reference_ulp_limitation_periods` (migration `20261013200000`) | A `provenance jsonb not null` column with the documented `reference_ulp_limitation_periods_provenance_complete` CHECK | Yes, except that the column type is the unqualified `jsonb` the rule accepted before it required `pg_catalog.jsonb`. |
| `private.catalog_research_facts` and companions (migration `20261012090000`) | `url` (not null), `as_of` (nullable), evidence tier, and `content_sha256` on the facts and categories | Partial: no `provenance_id`, `retrieved_at`, capture method, publisher or review status, and `as_of` may be empty. It predates the contract and is not altered here. |

## Privacy and representation

- No name-free stream gains names through provenance. `source.title` and
  `review.note` must not carry person names in catalog-bound streams; the
  exporter's name-free rule still owns that.
- A quote-bound fact keeps its quote offsets in the research stream, never in
  a catalog-bound stream.
- Publisher and title fields describe the source only. Provenance never states
  or implies that the owner of this repository is affiliated with any union.
