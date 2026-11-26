-- Allow line breaks in clause summary and full text.
--
-- The Add/Edit clause form presents summary and full text as textareas, so
-- stewards type paragraph breaks, but contract_clauses_summary_bounded and
-- contract_clauses_full_text_bounded rejected every [[:cntrl:]] character and
-- the client refused the same bytes, telling the steward required fields were
-- missing. The client (src/features/clauses/clause.js trimMultilineText) now
-- normalizes CRLF/CR to LF and accepts no other control character, so these
-- constraints drop LF and CR before the control-character test and accept
-- exactly the same set of values. A value that is only pad characters — LF,
-- CR, ASCII space, tab, U+00A0, and the rest of the ECMA-262 trim set in
-- CLAUSE_TEXT_PAD_CODES — is refused by btrim of that same set, matching the
-- client so a visually empty summary cannot persist and later fail
-- normalizeClause on catalog load. One-argument btrim would keep U+00A0 and
-- reopen catalog_unavailable. BEL, tab, DEL and every other C0 control
-- character are still refused, as is the C1 range U+0080-U+009F that
-- [[:cntrl:]] also matches under a UTF-8 locale, and the one-argument btrim
-- length bounds are unchanged. The single-line fields (article, section, category,
-- title) keep their original all-controls constraints.

begin;

-- Legacy remediation, before the stricter checks validate existing rows.
-- Until now both the clause RPCs and the old constraints used one-argument
-- btrim, so an authorized direct RPC write of a summary or full text made only
-- of non-ASCII pad characters (U+00A0 and the rest of CLAUSE_TEXT_PAD_CODES)
-- persisted. ADD CONSTRAINT validates immediately, so one such row would abort
-- this migration and leave the line-break rejection in place. Those rows are
-- already unreadable: normalizeClause refuses them and
-- createClauseCatalogFromRpcPayload turns a single one into
-- catalog_unavailable for the whole organization's catalog. A pad-only full
-- text means no full text, so it becomes null; summary is required, so it
-- becomes a plain marker a steward can search for and replace.
update public.contract_clauses
  set full_text = null
  where full_text is not null
    and pg_catalog.char_length(pg_catalog.btrim(full_text,
      chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(32) || chr(160)
      || chr(5760) || chr(8192) || chr(8193) || chr(8194) || chr(8195)
      || chr(8196) || chr(8197) || chr(8198) || chr(8199) || chr(8200)
      || chr(8201) || chr(8202) || chr(8232) || chr(8233) || chr(8239)
      || chr(8287) || chr(12288) || chr(65279)
    )) = 0;

update public.contract_clauses
  set summary = 'Summary not recorded - re-enter this clause summary.'
  where pg_catalog.char_length(pg_catalog.btrim(summary,
    chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(32) || chr(160)
    || chr(5760) || chr(8192) || chr(8193) || chr(8194) || chr(8195)
    || chr(8196) || chr(8197) || chr(8198) || chr(8199) || chr(8200)
    || chr(8201) || chr(8202) || chr(8232) || chr(8233) || chr(8239)
    || chr(8287) || chr(12288) || chr(65279)
  )) = 0;

-- ECMA-262 WhiteSpace + LineTerminator, matching CLAUSE_TEXT_PAD_CODES.
-- chr(9-13,32,160) then U+1680, U+2000-200A, U+2028, U+2029, U+202F,
-- U+205F, U+3000, U+FEFF.
alter table public.contract_clauses
  drop constraint contract_clauses_summary_bounded;

alter table public.contract_clauses
  add constraint contract_clauses_summary_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(summary)) between 1 and 2000
    and pg_catalog.char_length(pg_catalog.btrim(summary,
      chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(32) || chr(160)
      || chr(5760) || chr(8192) || chr(8193) || chr(8194) || chr(8195)
      || chr(8196) || chr(8197) || chr(8198) || chr(8199) || chr(8200)
      || chr(8201) || chr(8202) || chr(8232) || chr(8233) || chr(8239)
      || chr(8287) || chr(12288) || chr(65279)
    )) >= 1
    and pg_catalog.translate(summary, chr(10) || chr(13), '') !~ '[[:cntrl:]]'
  );

alter table public.contract_clauses
  drop constraint contract_clauses_full_text_bounded;

alter table public.contract_clauses
  add constraint contract_clauses_full_text_bounded check (
    full_text is null
    or (
      pg_catalog.char_length(pg_catalog.btrim(full_text)) between 1 and 20000
      and pg_catalog.char_length(pg_catalog.btrim(full_text,
        chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(32) || chr(160)
        || chr(5760) || chr(8192) || chr(8193) || chr(8194) || chr(8195)
        || chr(8196) || chr(8197) || chr(8198) || chr(8199) || chr(8200)
        || chr(8201) || chr(8202) || chr(8232) || chr(8233) || chr(8239)
        || chr(8287) || chr(12288) || chr(65279)
      )) >= 1
      and pg_catalog.translate(full_text, chr(10) || chr(13), '') !~ '[[:cntrl:]]'
    )
  );

commit;
