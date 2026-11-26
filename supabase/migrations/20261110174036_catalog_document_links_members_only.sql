-- REQ-UG-CATALOG-DOCUMENTS-MEMBERS-ONLY-20261110 (#8042).
-- Project decision of November 10, 2026: union documents are for members, meaning
-- any Union Ground account in its own session. A visitor with no account may
-- see that a document exists (kind, title, date) but never its link.
--
-- public.get_union_catalog_profile stays granted to anon. For a caller with no
-- account (auth.uid() is null) it now returns:
--   * every document entry with url and urlHost null;
--   * bylawsUrl null;
--   * every other link field put through the rule the public union
--     directory export applies (normalize, decode, decide whether the link
--     is a document, reduce it to its site address, canonicalize: "Document
--     links are for members"). A link that is withheld is reduced to
--     its publishing site's address:
--       - citations (organization sourceUrls, and the sourceUrl of parents,
--         sub-units, seat outlines and contacts) and contact values that are
--         links: withheld when they are a document by shape, or when they name
--         one of the organization's document or bylaws addresses under any
--         spelling (a destination);
--       - the organization's and the sub-units' websites: by shape only when
--         they read as a home page (no document word anywhere in the path),
--         so a local's home page stays its home page even where a document
--         entry points at it; a website with a document word in its path
--         (".../contract/master-agreement") is also judged as a destination;
--     contact values that are not links (a phone, a mailbox, an office
--     address) are unchanged;
--   * documentLinks = 'members';
--   * and, last, every string in the answer (names, labels, notes, titles,
--     sources) put through the rule as text: a value that is a link as a
--     whole is judged by the rule; in any other text every address, with or
--     without a scheme, is shown as its site address only.
-- A member's session gets exactly what it got before, plus
-- documentLinks = 'included'.
--
-- public.search_union_catalog stays granted to anon too. For a caller with no
-- account each result's website goes through the same rule (a catalog row's
-- against its own organization's withheld destinations, a registry row's by
-- shape); a member's result is unchanged, except that a registry website is
-- now stored already put through the rule (below), for everyone.
--
-- public.union_orgs (the federal filer registry) is readable by anon straight
-- over the REST API, so the rule cannot live only in the reading functions:
--   * website is made public-safe at rest. A before insert or update trigger
--     puts every stored value through the rule, by shape and against the
--     withheld destinations of the catalog organizations linked to the row
--     (same file number, or union_org_id), and the existing rows are rewritten
--     once here. A release going live (private.catalog_activate_release, the
--     only writer of the catalog tables, re-emitted here with one added call
--     at its end) re-judges the websites of the registry rows linked to the
--     catalog once its organizations, sub-units and documents are final. A
--     website reduced this way is not restored if the document is later
--     removed; the next registry load writes it again. Every reader, table or function, old client or
--     new, then gets the safe value. The raw value is not kept: every registry
--     reader runs on the anonymous client, members included, so a raw copy
--     would reach no one; the source atlas keeps it.
--   * sources (citations, some of them document links, read by no client)
--     is no longer granted to anon: anon keeps SELECT on every other column,
--     authenticated keeps the table.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Refuse a stale re-emission if another migration changed a reader first.
do $predecessors$
declare
  changed text;
begin
  select expected.signature into changed
    from (values
      ('public.get_union_catalog_profile(text)', '14b1d8175c10216e68fdd82d44b65f30'),
      ('public.search_union_catalog(text,text,text,text,integer)', '7fea23001956643d57aa200871d62312'),
      ('private.catalog_activate_release(text)', 'dc7ffa5e2371d9b2278373704be27a0a')
    ) as expected(signature, source_md5)
    left join pg_catalog.pg_proc as p on p.oid = pg_catalog.to_regprocedure(expected.signature)
   where pg_catalog.md5(p.prosrc) is distinct from expected.source_md5
   limit 1;
  if changed is not null then
    raise exception 'catalog members-only predecessor changed: %', changed;
  end if;
end;
$predecessors$;

-- Percent-decoding, repeated up to three times, as the export's decoded(): a
-- twice-encoded ".pdf" is still a PDF. A run of escapes that is not UTF-8 is
-- decoded byte by byte, every byte outside ASCII read as U+FFFD.
create function private.catalog_link_decoded(p_text text)
returns text
language plpgsql
stable
set search_path = ''
as $function$
declare
  result text := p_text;
  previous text;
  built text;
  bytes bytea;
  piece record;
  passes integer := 0;
begin
  while passes < 3 and result is not null and pg_catalog.strpos(result, '%') > 0 loop
    passes := passes + 1;
    previous := result;
    built := '';
    for piece in
      select m.part[1] as escapes, m.part[2] as plain
        from pg_catalog.regexp_matches(result, '((?:%[0-9a-fA-F]{2})+)|(%|[^%]+)', 'g') with ordinality as m(part, n)
       order by m.n
    loop
      if piece.escapes is null then
        built := built || piece.plain;
      else
        bytes := pg_catalog.decode(pg_catalog.replace(piece.escapes, '%', ''), 'hex');
        begin
          if pg_catalog.strpos(piece.escapes, '%00') > 0 then
            raise exception using errcode = 'character_not_in_repertoire';
          end if;
          built := built || pg_catalog.convert_from(bytes, 'UTF8');
        exception when character_not_in_repertoire then
          built := built || (
            select pg_catalog.string_agg(case when b.value between 1 and 127 then pg_catalog.chr(b.value) else pg_catalog.chr(65533) end,
                                         '' order by b.n)
              from (select pg_catalog.get_byte(bytes, i) as value, i as n
                      from pg_catalog.generate_series(0, pg_catalog.length(bytes) - 1) as i) as b);
        end;
      end if;
    end loop;
    result := built;
    exit when result = previous;
  end loop;
  return result;
end;
$function$;

-- A link as the export reads it: normalize() (surrounding space, tabs and line
-- breaks dropped, an entity-encoded colon decoded, a backslash after the
-- scheme read as a slash, a protocol-relative address given https:), then
-- Python's urlsplit. p_unwrap judges an archived copy by the address it
-- archives. Returns {scheme, host, path, query, fragment}: scheme lowercased,
-- '' for an absent part, and the host as a browser resolves it: without any
-- user part or port, percent-decoded, lowercased and without a final DNS dot.
-- Null when the host cannot be read as a plain hostname (a bracket, or
-- anything but letters, digits, dots and hyphens once decoded), so the link
-- is withheld with no site address and makes no destination key.
create function private.catalog_link_parts(p_url text, p_unwrap boolean)
returns text[]
language plpgsql
stable
set search_path = ''
as $function$
declare
  link text;
  parts text[];
  netloc text;
  host text;
begin
  if p_url is null then
    return null;
  end if;
  link := pg_catalog.regexp_replace(pg_catalog.regexp_replace(p_url, '^\s+|\s+$', '', 'g'), '[\t\r\n]', '', 'g');
  link := pg_catalog.regexp_replace(link, '^(https?)(&#58;|&#x3a;|&colon;)', '\1:', 'i');
  link := pg_catalog.regexp_replace(link, '^(https?:)?[\\/]{2,}', '\1//', 'i');
  if pg_catalog.left(link, 2) = '//' then
    link := 'https:' || link;
  end if;
  -- A browser reads every backslash before the query as a slash in an http
  -- or https address, so "https://www.scribd.com\@other.example/" is scribd.com.
  if link ~* '^https?:' then
    link := pg_catalog.replace(pg_catalog.substring(link, '^[^?#]*'), '\', '/')
            || coalesce(pg_catalog.substring(link, '[?#].*$'), '');
  end if;
  if p_unwrap then
    link := coalesce((pg_catalog.regexp_match(link, '^https?://web\.archive\.org/web/[^/]+/(https?://.+)$', 'i'))[1], link);
  end if;
  parts := pg_catalog.regexp_match(link, '^(?:([a-z][a-z0-9+.-]*):)?(?://([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$', 'i');
  netloc := coalesce(parts[2], '');
  if pg_catalog.strpos(netloc, '[') > 0 or pg_catalog.strpos(netloc, ']') > 0 then
    return null;
  end if;
  -- "www.%73cribd.com" and "docs.google.com." name scribd.com and docs.google.com.
  host := pg_catalog.split_part(pg_catalog.regexp_replace(netloc, '^.*@', ''), ':', 1);
  host := pg_catalog.regexp_replace(pg_catalog.lower(private.catalog_link_decoded(host)), '\.$', '');
  if host !~ '^[a-z0-9.-]*$' then
    return null;
  end if;
  return array[
    pg_catalog.lower(coalesce(parts[1], '')),
    host,
    coalesce(parts[3], ''),
    coalesce(parts[4], ''),
    coalesce(parts[5], '')
  ];
end;
$function$;

-- One destination under its several spellings, as the export's canonical():
-- no scheme, the host without a leading "www.", the decoded path without a
-- trailing slash, no fragment and no tracking parameters. The path's case and
-- every other query parameter are kept, since they can change the page. Null
-- for a bare site address and for anything with no host, so neither is a key.
create function private.catalog_link_canonical(p_url text)
returns text
language plpgsql
stable
set search_path = ''
as $function$
declare
  parts text[] := private.catalog_link_parts(p_url, false);
  host text;
  path text;
  query text;
  segment text;
  kept text[] := '{}'::text[];
begin
  if parts is null or parts[2] = '' then
    return null;
  end if;
  host := case when pg_catalog.left(parts[2], 4) = 'www.' then pg_catalog.substr(parts[2], 5) else parts[2] end;
  path := private.catalog_link_decoded(parts[3]);
  -- "/a/./b" and "/a/x/../b" name "/a/b", as a browser resolves them (the
  -- escaped spellings are decoded above).
  if path ~ '(^|/)\.\.?(/|$)' then
    foreach segment in array pg_catalog.string_to_array(path, '/') loop
      if segment = '.' then
        continue;
      elsif segment = '..' then
        if pg_catalog.cardinality(kept) > 1 then
          kept := kept[1:pg_catalog.cardinality(kept) - 1];
        end if;
      else
        kept := kept || segment;
      end if;
    end loop;
    path := pg_catalog.array_to_string(kept, '/');
  end if;
  path := pg_catalog.rtrim(path, '/');
  select pg_catalog.string_agg(q.pair, '&' order by q.n)
    into query
    from pg_catalog.unnest(pg_catalog.string_to_array(parts[4], '&')) with ordinality as q(pair, n)
   where q.pair <> ''
     and pg_catalog.split_part(q.pair, '=', 1) !~* '^(utm_[a-z]+|fbclid|gclid|mc_cid|mc_eid|msclkid|igshid)$';
  if host = '' or (path = '' and query is null) then
    return null;
  end if;
  return host || path || coalesce('?' || query, '');
end;
$function$;

-- A link as a visitor with no account may see it. A value that is not a link
-- is returned unchanged; a whole value with no scheme, such as
-- "example.org/files/cba.pdf", is read with https:// in front, as the pages
-- read it. A link is withheld when it is a document by shape (the export's
-- is_document_link) or when its canonical form, or that of the address it
-- archives, is one of p_withheld; a withheld link is reduced to its
-- publishing site's address (site_address), or null when none can be read.
create function private.catalog_public_citation(p_url text, p_withheld text[])
returns text
language plpgsql
stable
set search_path = ''
as $function$
declare
  link text := pg_catalog.regexp_replace(p_url, '^\s+|\s+$', '', 'g');
  parts text[];
  path text;
  address text;
  last_segment text;
  archived text;
begin
  if p_url is null then
    return null;
  end if;
  -- A scheme written percent-encoded ("https%3A%2F%2F...") is read decoded.
  if link !~* '^(https?(:|&#58;|&#x3a;|&colon;)|[\\/]{2})'
     and private.catalog_link_decoded(link) ~* '^(https?(:|&#58;|&#x3a;|&colon;)|[\\/]{2})' then
    link := private.catalog_link_decoded(link);
  end if;
  if link !~* '^(https?(:|&#58;|&#x3a;|&colon;)|[\\/]{2})' then
    -- The value is a link when it matches as written or decoded (so an escaped
    -- or dotted host counts, and so does an encoded space in the path), with
    -- every backslash read as a slash; the last label is alphabetic, so a
    -- mailbox or a date ("10.11.2026/x") is not a link; a host of four dotted
    -- numbers ("10.0.0.12/files/x.pdf") is.
    if pg_catalog.replace(link, '\', '/') !~* '^(([a-z0-9-]+\.)+[a-z]{2,}\.?|([0-9]{1,3}\.){3}[0-9]{1,3})(:[0-9]+)?/\S+$'
       and pg_catalog.replace(private.catalog_link_decoded(link), '\', '/') !~* '^(([a-z0-9-]+\.)+[a-z]{2,}\.?|([0-9]{1,3}\.){3}[0-9]{1,3})(:[0-9]+)?/\S+$' then
      return p_url;
    end if;
    link := 'https://' || link;
  end if;
  parts := private.catalog_link_parts(link, true);
  if parts is null then
    return null;
  end if;
  -- A bare site address names the publisher, not a document.
  if not (parts[3] in ('', '/') and parts[4] = '' and parts[5] = '') then
    path := pg_catalog.replace(private.catalog_link_decoded(parts[3]), '\', '/');
    address := path || '?' || private.catalog_link_decoded(parts[4]) || '#' || private.catalog_link_decoded(parts[5]);
    last_segment := pg_catalog.rtrim(path, '/');
    if
      -- File-sharing, document-viewer and online-form hosts, and link
      -- shorteners: a link there is the document itself, or leads anywhere.
      -- A map short link is a citation of a place.
      (parts[2] <> 'maps.app.goo.gl' and parts[2] ~ ('(^|\.)(drive\.google\.com|docs\.google\.com|acrobat\.adobe\.com|dropbox\.com|documentcloud\.org'
        || '|scribd\.com|issuu\.com|1drv\.ms|onedrive\.live\.com|docsend\.com|box\.com|egnyte\.com'
        || '|mediafire\.com|wetransfer\.com|we\.tl|docdroid\.net|yumpu\.com|slideshare\.net'
        || '|flipsnack\.com|anyflip\.com|calameo\.com|fliphtml5\.com|pubhtml5\.com|heyzine\.com'
        || '|publuu\.com|joomag\.com|jotform\.com|jotform\.us|formstack\.com|formstack\.io'
        || '|cognitoforms\.com|typeform\.com|wufoo\.com|forms\.gle|forms\.office\.com'
        || '|forms\.microsoft\.com|forms\.cloud\.microsoft|surveymonkey\.com|smartsheet\.com'
        || '|airtable\.com|paperform\.co|tfaforms\.com|tfaforms\.net|123formbuilder\.com'
        || '|zohopublic\.com|hsforms\.com|tally\.so|fillout\.com'
        || '|bit\.ly|tinyurl\.com|goo\.gl|ow\.ly|t\.co|buff\.ly|rb\.gy|lnkd\.in|tiny\.cc'
        || '|is\.gd|cutt\.ly|qrco\.de)$'))
      -- SharePoint personal sites, and sharing links (/:b:/, /:w:/ and the rest) on any tenant.
      -- The path and query are read decoded too, so "/%3Ab%3A/" and "?%64ownload" count.
      or (parts[2] ~ '\.sharepoint\.com$' and (parts[2] ~ '-my\.sharepoint\.com$' or parts[3] ~* '^/:[a-z]:/' or path ~* '^/:[a-z]:/'))
      -- Document files, in the path, the query or the fragment.
      or address ~* '\.(pdf|docx?|docm|dotx?|xlsx?|xlsm|pptx?|ppsx?|rtf|odt|ods|odp|wpd|epub)(?![a-z0-9])'
      -- Download and viewer endpoints that serve a file under an address with no extension.
      or address ~* ('getattachmentservlet|/download_file/|/documentcenter/view/|showpublisheddocument|/viewfile'
        || '|/flipbook/|/files/attachment/|/document/view/')
      -- An object served as a PDF (".../021f-pdf"), a path that ends in a
      -- download, and an uploaded object with no file extension.
      or last_segment ~* '[-_]pdf$'
      or last_segment ~* '/download$'
      or last_segment ~* '(/sites/default/files/|/wp-content/uploads/|/_files/ugd/)([^?#]*/)?[^/.?#]+$'
      or parts[4] ~* '(^|&)(download|attachment|inline)(=|&|$)'
      or private.catalog_link_decoded(parts[4]) ~* '(^|&)(download|attachment|inline)(=|&|$)'
      -- A page whose address names it as the bylaws, a constitution, a
      -- newsletter or a handbook is that document.
      or pg_catalog.regexp_split_to_array(pg_catalog.lower(path), '[^a-z]+')
         && array['bylaws', 'constitution', 'constitutions', 'newsletter', 'newsletters', 'handbook', 'handbooks']
    then
      return case when parts[2] = '' then null else parts[1] || '://' || parts[2] || '/' end;
    end if;
  end if;
  -- One of the organization's document addresses, under any spelling. The
  -- export strips trailing punctuation before it compares.
  archived := (pg_catalog.regexp_match(link, 'web\.archive\.org/web/[^/]+/(https?://.+)$', 'i'))[1];
  if private.catalog_link_canonical(pg_catalog.rtrim(link, '.,;:!?)]}''"')) = any(coalesce(p_withheld, '{}'::text[]))
     or private.catalog_link_canonical(pg_catalog.rtrim(archived, '.,;:!?)]}''"')) = any(coalesce(p_withheld, '{}'::text[])) then
    return case when parts[2] = '' then null else parts[1] || '://' || parts[2] || '/' end;
  end if;
  return p_url;
end;
$function$;

revoke all on function private.catalog_link_decoded(text) from public, anon, authenticated, service_role;
revoke all on function private.catalog_link_parts(text, boolean) from public, anon, authenticated, service_role;
revoke all on function private.catalog_link_canonical(text) from public, anon, authenticated, service_role;
revoke all on function private.catalog_public_citation(text, text[]) from public, anon, authenticated, service_role;

comment on function private.catalog_link_decoded(text) is
  'Percent-decoding repeated up to three times (REQ-UG-CATALOG-DOCUMENTS-MEMBERS-ONLY-20261110).';
comment on function private.catalog_link_parts(text, boolean) is
  'A link parsed for catalog display (normalize, then urlsplit; p_unwrap judges an archived copy by the address it archives): {scheme, host, path, query, fragment}, or null when the host cannot be read (REQ-UG-CATALOG-DOCUMENTS-MEMBERS-ONLY-20261110).';
comment on function private.catalog_link_canonical(text) is
  'One destination under its several spellings; null for a bare site address (REQ-UG-CATALOG-DOCUMENTS-MEMBERS-ONLY-20261110).';
comment on function private.catalog_public_citation(text, text[]) is
  'A link as a visitor with no account may see it: a value that is not a link is unchanged; a link that is a document by shape or whose canonical form is one of p_withheld is reduced to its publishing site''s address (scheme://host/), or null when no host can be read (REQ-UG-CATALOG-DOCUMENTS-MEMBERS-ONLY-20261110).';

-- Whether a value is a link by the rule's own reading, and if so its site
-- address. The front of catalog_public_citation, unchanged: surrounding white
-- space dropped, a percent-encoded scheme read decoded, a scheme-free value
-- read with https:// in front when it is a host (alphabetic last label, or
-- four dotted numbers) and a path, written or decoded, backslashes read as
-- slashes. Returns null when the value is not a link, '' when it is one whose
-- host cannot be read, and scheme://host/ otherwise.
create function private.catalog_link_site(p_value text)
returns text
language plpgsql
stable
set search_path = ''
as $function$
declare
  link text := pg_catalog.regexp_replace(p_value, '^\s+|\s+$', '', 'g');
  parts text[];
begin
  if p_value is null then
    return null;
  end if;
  if link !~* '^(https?(:|&#58;|&#x3a;|&colon;)|[\\/]{2})'
     and private.catalog_link_decoded(link) ~* '^(https?(:|&#58;|&#x3a;|&colon;)|[\\/]{2})' then
    link := private.catalog_link_decoded(link);
  end if;
  if link !~* '^(https?(:|&#58;|&#x3a;|&colon;)|[\\/]{2})' then
    if pg_catalog.replace(link, '\', '/') !~* '^(([a-z0-9-]+\.)+[a-z]{2,}\.?|([0-9]{1,3}\.){3}[0-9]{1,3})(:[0-9]+)?/\S+$'
       and pg_catalog.replace(private.catalog_link_decoded(link), '\', '/') !~* '^(([a-z0-9-]+\.)+[a-z]{2,}\.?|([0-9]{1,3}\.){3}[0-9]{1,3})(:[0-9]+)?/\S+$' then
      return null;
    end if;
    link := 'https://' || link;
  end if;
  parts := private.catalog_link_parts(link, true);
  if parts is null or parts[2] = '' then
    return '';
  end if;
  return parts[1] || '://' || parts[2] || '/';
end;
$function$;

-- Text as a visitor with no account may see it.
--   * A value that is one link as a whole (no white space, angle bracket or
--     double quote inside once line breaks and tabs are dropped, and a link by
--     the rule's reading) is judged by catalog_public_citation, by shape and by
--     destination, with the rule's full normalization. When the rule keeps it
--     but the value, decoded, holds another address start beyond its first
--     host (a scheme, a "//", or a host with a path right after one of
--     , ; | = & ( [ { ' @), the visitor gets its outer site address; an
--     archived copy whose archived address holds no further start is left to
--     the rule.
--   * Any other text is prose, judged word by word with no search for
--     addresses inside a word, so no spelling of an address can matter. It is
--     cut at white space only, kept as it is. A word with no slash form (a
--     slash or backslash, a percent escape, "&#" or a named entity) is kept; so
--     is a plainly harmless one: two parts of 1 to 12 letters, digits, hyphens
--     or apostrophes around one slash ("24/7", "and/or", "c/o", "2024/2026"),
--     or a numeric date ("11/10/2026"), once one leading "(" and trailing
--     punctuation are set aside. Any other word is shown as its site address,
--     with its surrounding brackets, quotes and punctuation, when
--     catalog_link_site reads it as a link, and is dropped otherwise. There is
--     no destination comparison in prose.
-- Returns null only where catalog_public_citation does for a whole-value link.
create function private.catalog_public_text(p_text text, p_withheld text[])
returns text
language plpgsql
stable
set search_path = ''
as $function$
declare
  plain text := pg_catalog.regexp_replace(pg_catalog.regexp_replace(p_text, '[\t\r\n]', '', 'g'), '^\s+|\s+$', '', 'g');
  whole text;
  rest text;
  archived text;
  run record;
  lead text;
  trail text;
  core text;
  site text;
  built text := '';
begin
  -- An address has a slash form: a slash or a backslash, a percent escape, "&#" or a named entity.
  if p_text is null or p_text !~* '[/\\]|%[0-9a-f]{2}|&#|&[a-z]+;' then
    return p_text;
  end if;
  -- One address as a whole: no white space, angle bracket or double quote
  -- inside, and a link by the rule's reading.
  if plain !~ '[\s<>"]' and private.catalog_link_site(plain) is not null then
    -- Judged without its line breaks and tabs (the scheme-free recognizer
    -- reads a path without white space).
    whole := private.catalog_public_citation(plain, p_withheld);
    if whole is distinct from plain then
      return whole;
    end if;
    -- Kept by the rule: a second address inside it (after a comma, in a
    -- redirect's query, behind an archive address) is not judged by the
    -- rule, so the visitor gets the outer site address (an archive's own, not
    -- the one catalog_link_site reads through it). An archived copy of one
    -- address is left to the rule, which judges the address it archives.
    rest := pg_catalog.replace(private.catalog_link_decoded(plain), '\', '/');
    site := pg_catalog.lower((pg_catalog.regexp_match(rest, '^https?://web\.archive\.org/', 'i'))[1]);
    archived := (pg_catalog.regexp_match(rest, '^https?://web\.archive\.org/web/[0-9a-z_*-]+/(https?://.+)$', 'i'))[1];
    rest := pg_catalog.regexp_replace(coalesce(archived, rest), '^(https?(:|&#58;|&#x3a;|&colon;))?/*[^/?#]*', '', 'i');
    if rest ~* '(https?(:|&#58;|&#x3a;|&colon;)|//|[,;|=&(\[{''@](([a-z0-9-]+\.)+[a-z]{2,}|([0-9]{1,3}\.){3}[0-9]{1,3})\.?(:[0-9]+)?/)' then
      return coalesce(site, private.catalog_link_site(plain));
    end if;
    -- Stored as it is when the rule keeps it.
    return p_text;
  end if;
  -- Prose, word by word.
  for run in
    select m.part[1] as stop, m.part[2] as word
      from pg_catalog.regexp_matches(p_text, '(\s+)|(\S+)', 'g') with ordinality as m(part, n)
     order by m.n
  loop
    if run.word is null
       or run.word !~* '[/\\]|%[0-9a-f]{2}|&#|&[a-z]+;'
       or pg_catalog.regexp_replace(pg_catalog.regexp_replace(run.word, '^\(', ''), '[.,;:!?)]+$', '')
          ~ '^([[:alnum:]''-]{1,12}/[[:alnum:]''-]{1,12}|[0-9]{1,4}/[0-9]{1,2}/[0-9]{1,4})$' then
      built := built || coalesce(run.stop, run.word);
      continue;
    end if;
    lead := pg_catalog.substring(run.word, '^[(<\[{"'']*');
    trail := pg_catalog.substring(run.word, '[.,;:!?)\]}''"*_|>]*$');
    core := pg_catalog.substr(run.word, pg_catalog.length(lead) + 1);
    core := pg_catalog.left(core, pg_catalog.length(core) - pg_catalog.length(trail));
    site := private.catalog_link_site(core);
    if site <> '' then
      built := built || lead || site || trail;
    end if;
  end loop;
  return built;
end;
$function$;

-- A JSON answer as a visitor with no account may see it: every string in it,
-- at any depth, through catalog_public_text. Keys, numbers, booleans and nulls
-- are unchanged.
create function private.catalog_public_json(p_value jsonb, p_withheld text[])
returns jsonb
language plpgsql
stable
set search_path = ''
as $function$
begin
  case pg_catalog.jsonb_typeof(p_value)
    when 'string' then
      return pg_catalog.to_jsonb(private.catalog_public_text(p_value #>> '{}', p_withheld));
    when 'array' then
      return (select coalesce(pg_catalog.jsonb_agg(private.catalog_public_json(e.value, p_withheld) order by e.n), '[]'::jsonb)
                from pg_catalog.jsonb_array_elements(p_value) with ordinality as e(value, n));
    when 'object' then
      return (select coalesce(pg_catalog.jsonb_object_agg(e.key, private.catalog_public_json(e.value, p_withheld)), '{}'::jsonb)
                from pg_catalog.jsonb_each(p_value) as e(key, value));
    else
      return p_value;
  end case;
end;
$function$;

revoke all on function private.catalog_link_site(text) from public, anon, authenticated, service_role;
revoke all on function private.catalog_public_text(text, text[]) from public, anon, authenticated, service_role;
revoke all on function private.catalog_public_json(jsonb, text[]) from public, anon, authenticated, service_role;

comment on function private.catalog_link_site(text) is
  'Whether a value is a link by the catalog link rule''s own reading (the front of private.catalog_public_citation), and its site address: null when it is not a link, '''' when its host cannot be read (REQ-UG-CATALOG-DOCUMENTS-MEMBERS-ONLY-20261110).';
comment on function private.catalog_public_text(text, text[]) is
  'Text as a visitor with no account may see it: a value that is a link as a whole is judged by private.catalog_public_citation, and shown as its outer site address when the rule keeps it but it holds a second address start; any other text (prose) is judged word by word: a word with no slash form, or a plainly harmless one (24/7, and/or, a numeric date), is kept, any other is shown as its site address when it is a link by private.catalog_link_site and dropped otherwise (REQ-UG-CATALOG-DOCUMENTS-MEMBERS-ONLY-20261110).';
comment on function private.catalog_public_json(jsonb, text[]) is
  'A JSON answer as a visitor with no account may see it: every string at any depth through private.catalog_public_text (REQ-UG-CATALOG-DOCUMENTS-MEMBERS-ONLY-20261110).';

-- The destinations a caller with no account may not reach for one
-- organization: the canonical form of every link its documents and bylaws
-- carry, except an address the profile returns as the organization's or a
-- sub-unit's website that reads as a home page (no document word anywhere in
-- its path), as the export's settle_destinations() and home_pages() do.
create function private.catalog_withheld_destinations(p_catalog_key text)
returns text[]
language sql
stable
set search_path = ''
as $function$
  select coalesce(pg_catalog.array_agg(distinct link.key), '{}')
    from (
      select private.catalog_link_canonical(pg_catalog.rtrim(d.url, '.,;:!?)]}''"')) as key
        from private.catalog_documents as d where d.catalog_key = p_catalog_key
      union all
      select private.catalog_link_canonical(pg_catalog.rtrim(o.bylaws_url, '.,;:!?)]}''"'))
        from private.catalog_organizations as o where o.catalog_key = p_catalog_key
    ) as link
   where link.key is not null
     and not exists (
       select 1
         from (
           select o.website as url from private.catalog_organizations as o where o.catalog_key = p_catalog_key
           union all
           select listed.website
             from (
               select s.website
                 from private.catalog_subunits as s
                where s.catalog_key = p_catalog_key
                  and s.retired_release_id is null
                order by s.kind, s.name, s.subunit_key
                limit 500
             ) as listed
         ) as site
        where private.catalog_link_canonical(pg_catalog.rtrim(site.url, '.,;:!?)]}''"')) = link.key
          and not pg_catalog.regexp_split_to_array(pg_catalog.lower(private.catalog_link_decoded(
                pg_catalog.regexp_replace(pg_catalog.split_part(link.key, '?', 1), '^[^/]*/?', ''))), '[^a-z]+')
              && array['bylaws', 'constitution', 'constitutions', 'newsletter', 'newsletters', 'handbook', 'handbooks',
                   'bylaw', 'contract', 'contracts', 'agreement', 'agreements', 'cba', 'cbas', 'mou', 'moa', 'memorandum',
                   'form', 'forms', 'application', 'applications', 'document', 'documents', 'download', 'downloads',
                   'pdf', 'pdfs', 'publication', 'publications', 'policy', 'policies', 'flyer', 'flyers', 'bulletin',
                   'bulletins', 'magazine', 'governing']
     );
$function$;

revoke all on function private.catalog_withheld_destinations(text) from public, anon, authenticated, service_role;

comment on function private.catalog_withheld_destinations(text) is
  'Canonical document and bylaws destinations of one catalog organization that a caller with no account may not reach, less any listed organization or sub-unit website that reads as a home page (REQ-UG-CATALOG-DOCUMENTS-MEMBERS-ONLY-20261110).';

-- The destinations a registry row's website may not name for a caller with no
-- account: those of every catalog organization linked to the row, by the same
-- file number (as search_union_catalog joins them) or by union_org_id (the
-- profile's registryId, which the catalog loader sets from the file number).
-- The caller passes the row's own id and file number: in a BEFORE INSERT
-- trigger the row is not in the table yet.
create function private.registry_withheld_destinations(p_registry_id text, p_olms_file_number integer)
returns text[]
language sql
stable
set search_path = ''
as $function$
  select coalesce(pg_catalog.array_agg(distinct d.key), '{}'::text[])
    from private.catalog_organizations as c
    cross join lateral pg_catalog.unnest(private.catalog_withheld_destinations(c.catalog_key)) as d(key)
   where c.union_org_id = p_registry_id
      or c.olms_file_number = p_olms_file_number;
$function$;

revoke all on function private.registry_withheld_destinations(text, integer) from public, anon, authenticated, service_role;

comment on function private.registry_withheld_destinations(text, integer) is
  'Withheld destinations of every catalog organization linked to one public.union_orgs row, given the row''s own id and file number (same olms_file_number, or union_org_id), for judging that row''s website; the trigger passes the incoming row, so a new row or a changed file number is judged by its new value (REQ-UG-CATALOG-DOCUMENTS-MEMBERS-ONLY-20261110).';

-- The soft link the registry helper reads; the file number is already unique.
create index catalog_organizations_union_org_id_idx on private.catalog_organizations (union_org_id);

-- Previous definition: 20261023050348_bot_organization_directory_visibility.sql
create or replace function public.get_union_catalog_profile(p_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  organization jsonb;
  answer jsonb;
  -- A member is any Union Ground account in its own session.
  caller_is_member constant boolean := auth.uid() is not null;
  withheld text[] := '{}'::text[];
begin
  if p_key is null or p_key !~ '^(olms-[0-9]{1,9}|ug-[a-z0-9]{10})$' then
    raise exception 'invalid catalog key' using errcode = '22023';
  end if;

  -- Document links are for members. Without an account, every link this
  -- organization's documents and bylaws carry is withheld, and so is any
  -- other link to one of those destinations under any spelling, except an
  -- address this profile returns as a website that reads as a home page (no
  -- document word anywhere in its path).
  if not caller_is_member then
    withheld := private.catalog_withheld_destinations(p_key);
  end if;

  -- Unknown, retired and duplicate keys, and every key while no release is
  -- active, get the same answer.
  select pg_catalog.jsonb_build_object(
      'key', o.catalog_key,
      'olmsFileNumber', o.olms_file_number,
      'registryId', o.union_org_id,
      'origin', o.origin,
      'name', o.name,
      'aka', o.aka,
      'family', o.family,
      'designation', o.designation,
      'localNumber', o.local_number,
      'tier', o.tier,
      'level', case o.tier when 'national' then 'national' when 'regional' then 'intermediate'
                 when 'state' then 'intermediate' else 'local' end,
      'orgTypeLabel', o.org_type_label,
      'sector', o.sector,
      'industries', o.industries,
      'occupations', o.occupations,
      'trades', o.trades,
      'city', o.city,
      'state', o.state,
      'zip5', o.zip5,
      'censusRegion', o.census_region,
      'censusDivision', o.census_division,
      'latitude', o.latitude,
      'longitude', o.longitude,
      'geoPrecision', o.geo_precision,
      'website', case when caller_is_member then o.website else private.catalog_public_citation(o.website, withheld) end,
      'membersReported', o.members_reported,
      'membersFiscalYear', o.members_fiscal_year,
      'structureNote', private.catalog_scrub_text(o.structure_note),
      'electionTermYears', o.election_term_years,
      'nextElectionOn', o.next_election_on,
      'bylawsUrl', case when caller_is_member then o.bylaws_url end,
      'confidence', o.confidence,
      'researchedOn', o.researched_on,
      'sourceUrls', case when caller_is_member then pg_catalog.to_jsonb(o.source_urls) else (
        select coalesce(pg_catalog.jsonb_agg(cited.url order by cited.first_ordinal), '[]'::jsonb)
          from (
            select private.catalog_public_citation(source.url, withheld) as url,
                   pg_catalog.min(source.ordinal) as first_ordinal
              from pg_catalog.unnest(o.source_urls) with ordinality as source(url, ordinal)
             group by 1
          ) as cited
         where cited.url is not null
      ) end
    )
    into organization
    from private.catalog_organizations as o
   where o.catalog_key = p_key
     and o.retired_release_id is null
     and o.duplicate_of is null
     and private.catalog_registry_identity_visible(o.union_org_id)
     and exists (select 1 from private.catalog_releases as r where r.status = 'active');
  if organization is null then
    return pg_catalog.jsonb_build_object('found', false);
  end if;

  answer := pg_catalog.jsonb_build_object(
    'found', true,
    'documentLinks', case when caller_is_member then 'included' else 'members' end,
    'organization', organization,
    'parents', coalesce((
      select pg_catalog.jsonb_agg(item.payload order by item.depth, item.edge_kind, item.edge_key)
        from (
          select walked.depth, walked.edge_kind, walked.edge_key,
            pg_catalog.jsonb_build_object(
              'depth', walked.depth,
              'childKey', walked.child_key,
              'parentKey', parent.catalog_key,
              'parentName', parent.name,
              'parentLabel', private.catalog_scrub_text(walked.parent_label),
              'edgeKind', walked.edge_kind,
              'certainty', walked.certainty,
              'sourceUrl', case when caller_is_member then walked.source_url else private.catalog_public_citation(walked.source_url, withheld) end
            ) as payload
            from (
              with recursive chain as (
                select e.edge_key, e.child_key, e.parent_key, e.parent_label, e.edge_kind, e.certainty, e.source_url,
                       1 as depth
                  from private.catalog_edges as e
                 where e.child_key = p_key
                   and e.retired_release_id is null
                union
                select e.edge_key, e.child_key, e.parent_key, e.parent_label, e.edge_kind, e.certainty, e.source_url,
                       chain.depth + 1
                  from chain
                  -- The walk continues only through a visible organization.
                  join private.catalog_organizations as via
                    on via.catalog_key = chain.parent_key
                   and via.retired_release_id is null
                   and via.duplicate_of is null
                   and private.catalog_registry_identity_visible(via.union_org_id)
                  join private.catalog_edges as e on e.child_key = via.catalog_key
                 where chain.depth < 8
                   and e.retired_release_id is null
              )
              select distinct on (chain.edge_key)
                     chain.edge_key, chain.child_key, chain.parent_key, chain.parent_label, chain.edge_kind,
                     chain.certainty, chain.source_url, chain.depth
                from chain
               order by chain.edge_key, chain.depth
            ) as walked
            left join private.catalog_organizations as parent
              on parent.catalog_key = walked.parent_key
             and parent.retired_release_id is null
             and parent.duplicate_of is null
             and private.catalog_registry_identity_visible(parent.union_org_id)
           -- An edge to a retired or duplicate organization is left out, as
           -- that organization's own profile is; a label-only edge stays.
           where walked.parent_key is null or parent.catalog_key is not null
           order by walked.depth, walked.edge_kind, walked.edge_key
           limit 100
        ) as item
    ), '[]'::jsonb),
    'children', coalesce((
      select pg_catalog.jsonb_agg(item.payload order by item.sort_name, item.edge_key)
        from (
          select child.name as sort_name, e.edge_key,
            pg_catalog.jsonb_build_object(
              'key', child.catalog_key,
              'name', child.name,
              'tier', child.tier,
              'localNumber', child.local_number,
              'city', child.city,
              'state', child.state,
              'edgeKind', e.edge_kind,
              'certainty', e.certainty
            ) as payload
            from private.catalog_edges as e
            join private.catalog_organizations as child on child.catalog_key = e.child_key
           where e.parent_key = p_key
             and e.retired_release_id is null
             and child.retired_release_id is null
             and child.duplicate_of is null
             and private.catalog_registry_identity_visible(child.union_org_id)
           order by child.name, e.edge_key
           limit 500
        ) as item
    ), '[]'::jsonb),
    'childrenTotal', (
      select pg_catalog.count(*)
        from private.catalog_edges as e
        join private.catalog_organizations as child on child.catalog_key = e.child_key
       where e.parent_key = p_key
         and e.retired_release_id is null
         and child.retired_release_id is null
         and child.duplicate_of is null
         and private.catalog_registry_identity_visible(child.union_org_id)
    ),
    'subunits', coalesce((
      select pg_catalog.jsonb_agg(item.payload order by item.kind, item.name, item.subunit_key)
        from (
          select s.kind, s.name, s.subunit_key,
            pg_catalog.jsonb_build_object(
              'key', s.subunit_key,
              'parentKey', s.parent_subunit_key,
              'kind', s.kind,
              'kindLabel', private.catalog_scrub_text(s.kind_label),
              'name', private.catalog_scrub_text(s.name),
              'location', private.catalog_scrub_text(s.location),
              'employer', private.catalog_scrub_text(s.employer),
              'members', s.members,
              'membersSource', private.catalog_scrub_text(s.members_source),
              'densityNote', private.catalog_scrub_text(s.density_note),
              'website', case when caller_is_member then s.website else private.catalog_public_citation(s.website, withheld) end,
              'electionNote', private.catalog_scrub_text(s.election_note),
              'structureNote', private.catalog_scrub_text(s.structure_note),
              'confidence', s.confidence,
              'sourceUrl', case when caller_is_member then s.source_url else private.catalog_public_citation(s.source_url, withheld) end,
              'asOf', s.as_of
            ) as payload
            from private.catalog_subunits as s
           where s.catalog_key = p_key
             and s.retired_release_id is null
           order by s.kind, s.name, s.subunit_key
           limit 500
        ) as item
    ), '[]'::jsonb),
    'seatOutlines', coalesce((
      select pg_catalog.jsonb_agg(item.payload order by item.scope, item.seat_class, item.outline_key)
        from (
          select coalesce(so.subunit_key, '') as scope, so.seat_class, so.outline_key,
            pg_catalog.jsonb_build_object(
              'key', so.outline_key,
              'subunitKey', so.subunit_key,
              'seatClass', so.seat_class,
              'title', private.catalog_scrub_text(so.title),
              'listed', so.listed,
              'vacant', so.vacant,
              'sourceUrl', case when caller_is_member then so.source_url else private.catalog_public_citation(so.source_url, withheld) end,
              'asOf', so.as_of
            ) as payload
            from private.catalog_seat_outlines as so
           where so.catalog_key = p_key
             and so.retired_release_id is null
           order by coalesce(so.subunit_key, ''), so.seat_class, so.outline_key
           limit 500
        ) as item
    ), '[]'::jsonb),
    'contacts', coalesce((
      select pg_catalog.jsonb_agg(item.payload order by item.contact_kind, item.contact_key)
        from (
          select c.contact_kind, c.contact_key,
            pg_catalog.jsonb_build_object(
              'kind', c.contact_kind,
              'value', case when caller_is_member then c.value else private.catalog_public_citation(c.value, withheld) end,
              'label', private.catalog_scrub_text(c.label),
              'basis', c.basis,
              'sourceUrl', case when caller_is_member then c.source_url else private.catalog_public_citation(c.source_url, withheld) end,
              'asOf', c.as_of
            ) as payload
            from private.catalog_contacts as c
           where c.catalog_key = p_key
             and c.retired_release_id is null
           order by c.contact_kind, c.contact_key
           limit 50
        ) as item
    ), '[]'::jsonb),
    'documents', coalesce((
      select pg_catalog.jsonb_agg(item.payload order by item.doc_kind, item.document_key)
        from (
          select d.doc_kind, d.document_key,
            pg_catalog.jsonb_build_object(
              'key', d.document_key,
              'kind', d.doc_kind,
              'title', private.catalog_scrub_text(d.title),
              'titleDerived', d.title_derived,
              'url', case when caller_is_member then d.url end,
              'urlHost', case when caller_is_member then d.url_host end,
              'asOf', d.as_of,
              'subunitKeys', coalesce((
                select pg_catalog.jsonb_agg(link.subunit_key order by link.subunit_key)
                  from (
                    select ds.subunit_key
                      from private.catalog_document_subunits as ds
                     where ds.document_key = d.document_key
                       and ds.retired_release_id is null
                     order by ds.subunit_key
                     limit 50
                  ) as link
              ), '[]'::jsonb)
            ) as payload
            from private.catalog_documents as d
           where d.catalog_key = p_key
             and d.retired_release_id is null
           order by d.doc_kind, d.document_key
           limit 500
        ) as item
    ), '[]'::jsonb),
    'coverage', (
      select pg_catalog.jsonb_build_object(
          'band', cov.band,
          'checklist', cov.checklist,
          'subunits', cov.subunits,
          'subunitsWithMembers', cov.subunits_with_members,
          'seatOutlines', cov.seat_outlines,
          'documents', cov.documents,
          'demandBand', cov.demand_band,
          'communityVerifiedOn', cov.community_verified_on,
          'lastResearched', cov.last_researched
        )
        from private.catalog_coverage as cov
       where cov.catalog_key = p_key
    )
  );
  -- Last, every string a visitor gets (names, labels, notes, titles and the
  -- sources above) through the rule as text, so an address in any field,
  -- written alone or inside prose, is judged the same way.
  return case when caller_is_member then answer else private.catalog_public_json(answer, withheld) end;
end;
$function$;

revoke all on function public.get_union_catalog_profile(text) from public, anon, authenticated, service_role;
grant execute on function public.get_union_catalog_profile(text) to anon, authenticated, service_role;

comment on function public.get_union_catalog_profile(text) is
  'Union catalog profile for one live catalog key: the organization, parents up to 8 levels (edges to retired or duplicate organizations left out), up to 500 children with childrenTotal, sub-units, seat outlines and documents (totals in coverage), up to 50 contacts, and coverage. Unknown, retired and duplicate keys return {"found": false}. Document links are for members: a caller with no account gets documentLinks = ''members'', null document url, urlHost and bylawsUrl, and every other link that is a document by shape, or (except a website that reads as a home page) names one of the organization''s document addresses under any spelling, reduced to its site address, and every string of the answer put through the same rule as text (private.catalog_public_json); a signed-in caller gets documentLinks = ''included'' and every link.';

-- Previous definition: 20261023050348_bot_organization_directory_visibility.sql
create or replace function public.search_union_catalog(
  p_query text,
  p_state text,
  p_family text,
  p_tier text,
  p_page integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  query_text text := nullif(pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(p_query, ''), '\s+', ' ', 'g')), '');
  state_filter text := nullif(p_state, '');
  family_filter text := nullif(pg_catalog.btrim(coalesce(p_family, '')), '');
  tier_filter text := nullif(p_tier, '');
  registry_level text;
  number_match text[];
  local_number_filter text;
  text_part text;
  pattern text;
  full_pattern text;
  catalog_live boolean;
  match_count bigint;
  page_rows jsonb;
  -- A member is any Union Ground account in its own session.
  caller_is_member constant boolean := auth.uid() is not null;
begin
  if p_query ~ '[[:cntrl:]]' then
    raise exception 'invalid catalog search query' using errcode = '22023';
  end if;
  if query_text is not null and pg_catalog.char_length(query_text) not between 2 and 80 then
    raise exception 'catalog search query must be 2 to 80 characters' using errcode = '22023';
  end if;
  if state_filter is not null and state_filter !~ '^[A-Z]{2}$' then
    raise exception 'invalid catalog search state' using errcode = '22023';
  end if;
  if query_text is null and state_filter is null then
    raise exception 'catalog search needs a query or a state' using errcode = '22023';
  end if;
  if p_family ~ '[[:cntrl:]]' or pg_catalog.char_length(family_filter) > 40 then
    raise exception 'invalid catalog search family' using errcode = '22023';
  end if;
  if tier_filter is not null and tier_filter not in ('national', 'regional', 'state', 'local', 'sub_local') then
    raise exception 'invalid catalog search tier' using errcode = '22023';
  end if;
  if p_page is null or p_page not between 1 and 40 then
    raise exception 'invalid catalog search page' using errcode = '22023';
  end if;

  registry_level := case tier_filter
    when 'national' then 'national'
    when 'regional' then 'intermediate'
    when 'state' then 'intermediate'
    when 'local' then 'local'
    when 'sub_local' then 'local'
  end;

  -- The Phase 1 reading of a query: "Local 600", "lu 12 boston" or a bare
  -- number names a local number; the remaining text (two characters or more)
  -- matches a name, a city or the catalog search text.
  if query_text is not null then
    number_match := pg_catalog.regexp_match(query_text, '^#?([0-9]{1,7})$');
    if number_match is not null then
      local_number_filter := (number_match[1])::integer::text;
    else
      number_match := pg_catalog.regexp_match(query_text,
        '(^|\s)(local|lu|lodge|branch|br|chapter|ch|division|div)\s*#?\s*([0-9]{1,7})(?=\s|$)', 'i');
      if number_match is not null then
        local_number_filter := (number_match[3])::integer::text;
        text_part := pg_catalog.btrim(pg_catalog.regexp_replace(pg_catalog.regexp_replace(query_text,
          '(^|\s)(local|lu|lodge|branch|br|chapter|ch|division|div)\s*#?\s*([0-9]{1,7})(?=\s|$)', ' ', 'i'), '\s+', ' ', 'g'));
        full_pattern := '%' || pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(query_text, '\', '\\'), '%', '\%'), '_', '\_') || '%';
      else
        text_part := query_text;
      end if;
    end if;
    if pg_catalog.char_length(text_part) >= 2 then
      pattern := '%' || pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(text_part, '\', '\\'), '%', '\%'), '_', '\_') || '%';
    end if;
  end if;

  catalog_live := exists (select 1 from private.catalog_releases as r where r.status = 'active');

  with matches as (
    select 0 as source_rank, o.name as sort_name, o.catalog_key as sort_key, null::text as registry_parent,
      pg_catalog.jsonb_build_object(
        'key', o.catalog_key,
        'registryOnly', false,
        'name', o.name,
        'family', o.family,
        'designation', o.designation,
        'localNumber', o.local_number,
        'tier', o.tier,
        'level', case o.tier when 'national' then 'national' when 'regional' then 'intermediate'
                   when 'state' then 'intermediate' else 'local' end,
        'city', o.city,
        'state', o.state,
        'website', o.website,
        'membersReported', o.members_reported,
        'membersFiscalYear', o.members_fiscal_year,
        'registryId', o.union_org_id
      ) as payload
      from private.catalog_organizations as o
     where catalog_live
       and o.retired_release_id is null
       and o.duplicate_of is null
       and private.catalog_registry_identity_visible(o.union_org_id)
       and (local_number_filter is null or o.local_number = local_number_filter
            or (full_pattern is not null and o.name ilike full_pattern escape '\'))
       and (pattern is null or o.name ilike pattern escape '\' or o.city ilike pattern escape '\'
            or o.search_text ilike pattern escape '\')
       and (state_filter is null or o.state = state_filter)
       and (family_filter is null or o.family = family_filter)
       and (tier_filter is null or o.tier = tier_filter)
    union all
    select 1 as source_rank, u.name as sort_name, u.id as sort_key, u.parent_name as registry_parent,
      pg_catalog.jsonb_build_object(
        'key', u.id,
        'registryOnly', true,
        'name', u.name,
        'family', u.affiliation,
        'designation', u.designation,
        'localNumber', u.local_number,
        'tier', null,
        'level', u.level,
        'city', u.city,
        'state', u.state,
        'website', u.website,
        'membersReported', u.members_latest,
        'membersFiscalYear', u.members_latest_year,
        'registryId', u.id
      ) as payload
      from public.union_orgs as u
     where not u.is_fictional
       and (local_number_filter is null or u.local_number = local_number_filter
            or (full_pattern is not null and u.name ilike full_pattern escape '\'))
       and (pattern is null or u.name ilike pattern escape '\' or u.city ilike pattern escape '\'
            or u.affiliation ilike pattern escape '\')
       and (state_filter is null or u.state = state_filter)
       and (family_filter is null or u.affiliation = family_filter)
       and (registry_level is null or u.level = registry_level)
       and (not catalog_live or not exists (
             select 1 from private.catalog_organizations as c
              where c.olms_file_number = u.olms_file_number and c.retired_release_id is null
                and private.catalog_registry_identity_visible(c.union_org_id)))
  )
  select
    (select pg_catalog.count(*) from (select 1 from matches limit 1001) as capped),
    coalesce((
      select pg_catalog.jsonb_agg(
               -- The "Part of" line. A catalog row: the highest-ranked live
               -- edge that still names something visible, that is its
               -- visible parent (an edge to a retired or duplicate
               -- organization is skipped, as in the profile) or else its
               -- scrubbed label (a label-only edge whose label is scrubbed is
               -- skipped, so a lower-ranked visible parent wins); null when
               -- no edge qualifies. A registry row: the registry's own
               -- parent name, scrubbed the same way.
               page.payload || pg_catalog.jsonb_build_object('parentName', case when page.source_rank = 0 then (
                 select coalesce(parent.name, private.catalog_scrub_text(e.parent_label))
                   from private.catalog_edges as e
                   left join private.catalog_organizations as parent
                     on parent.catalog_key = e.parent_key
                    and parent.retired_release_id is null
                    and parent.duplicate_of is null
                    and private.catalog_registry_identity_visible(parent.union_org_id)
                  where e.child_key = page.sort_key
                    and e.retired_release_id is null
                    and (e.parent_key is null or parent.catalog_key is not null)
                    and coalesce(parent.name, private.catalog_scrub_text(e.parent_label)) is not null
                  order by case e.edge_kind when 'olms_parent' then 0 when 'parent_body' then 1 else 2 end, e.edge_key
                  limit 1
               ) else private.catalog_scrub_text(page.registry_parent) end)
               order by page.source_rank, page.sort_name, page.sort_key)
        from (
          select m.source_rank, m.sort_name, m.sort_key, m.registry_parent, m.payload
            from matches as m
           order by m.source_rank, m.sort_name, m.sort_key
           limit 25 offset (p_page - 1) * 25
        ) as page
    ), '[]'::jsonb)
    into match_count, page_rows;

  -- Document links are for members: without an account every string of each
  -- row (its website and its labels) goes through the rule as text, a catalog
  -- row's against its own organization's withheld destinations and a registry
  -- row's against those of the catalog organizations linked to it.
  if not caller_is_member then
    select coalesce(pg_catalog.jsonb_agg(private.catalog_public_json(r.value,
             case when (r.value ->> 'registryOnly')::boolean
                  then private.registry_withheld_destinations(r.value ->> 'key',
                         (select u.olms_file_number from public.union_orgs as u where u.id = r.value ->> 'key'))
                  else private.catalog_withheld_destinations(r.value ->> 'key') end) order by r.n), '[]'::jsonb)
      into page_rows
      from pg_catalog.jsonb_array_elements(page_rows) with ordinality as r(value, n);
  end if;

  return pg_catalog.jsonb_build_object(
    'rows', page_rows,
    'page', p_page,
    'pageSize', 25,
    'total', least(match_count, 1000),
    'totalCapped', match_count > 1000,
    'hasNext', p_page < 40 and p_page * 25 < least(match_count, 1000)
  );
end;
$function$;

revoke all on function public.search_union_catalog(text, text, text, text, integer) from public, anon, authenticated, service_role;
grant execute on function public.search_union_catalog(text, text, text, text, integer) to anon, authenticated, service_role;

-- Registry links at rest (public.union_orgs is readable by anon over REST).
create function private.union_orgs_public_website()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.website is not null then
    new.website := private.catalog_public_citation(new.website, private.registry_withheld_destinations(new.id, new.olms_file_number));
  end if;
  return new;
end;
$function$;

revoke all on function private.union_orgs_public_website() from public, anon, authenticated, service_role;

comment on function private.union_orgs_public_website() is
  'Before insert or update on public.union_orgs: the stored website is put through the catalog link rule, by shape and against the withheld destinations of the linked catalog organizations (private.registry_withheld_destinations), so a document link is kept only as its site address for every reader (REQ-UG-CATALOG-DOCUMENTS-MEMBERS-ONLY-20261110).';

create trigger union_orgs_public_website
  before insert or update on public.union_orgs
  for each row execute function private.union_orgs_public_website();

-- The rows loaded before the trigger (the trigger applies the same rule).
update public.union_orgs
   set website = website
 where website is distinct from private.catalog_public_citation(website, private.registry_withheld_destinations(id, olms_file_number));

-- The registry websites linked to the catalog, judged again (a release going
-- live calls this once its organizations, sub-units and documents are final).
-- Only a website with a path or query can name a destination. Each update
-- fires union_orgs_public_website; returns how many rows were judged.
create function private.catalog_refresh_registry_websites()
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  by_file integer;
  by_link integer;
begin
  update public.union_orgs as u
     set website = u.website
    from private.catalog_organizations as c
   where c.olms_file_number = u.olms_file_number
     and u.website !~* '^https?://[^/?#]+/?$';
  get diagnostics by_file = row_count;
  update public.union_orgs as u
     set website = u.website
    from private.catalog_organizations as c
   where c.union_org_id = u.id
     and c.olms_file_number is distinct from u.olms_file_number
     and u.website !~* '^https?://[^/?#]+/?$';
  get diagnostics by_link = row_count;
  return by_file + by_link;
end;
$function$;

revoke all on function private.catalog_refresh_registry_websites() from public, anon, authenticated, service_role;

comment on function private.catalog_refresh_registry_websites() is
  'Re-judges the stored website of every public.union_orgs row linked to a catalog organization (same olms_file_number, or union_org_id) whose website has a path or query; called by private.catalog_activate_release once a release''s rows are final (REQ-UG-CATALOG-DOCUMENTS-MEMBERS-ONLY-20261110).';

-- Previous definition: 20261012090000_union_catalog_research_tables.sql
create or replace function private.catalog_activate_release(p_label text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  target_id uuid;
  target_status text;
  target_loaded_at timestamptz;
  target_verified_at timestamptz;
  target_verified_sha256 text;
  staged_sha256 text;
  allow_retire bigint;
  research_loaded_over uuid;
  previous_id uuid;
  staged_organizations bigint;
  live_organizations bigint;
  retiring_organizations bigint;
  live_subunits bigint;
  retiring_subunits bigint;
  mismatched_tables text[];
  diff jsonb;
begin
  if p_label is null or p_label !~ '^[0-9]{8}-[0-9]{2}$' then
    raise exception 'invalid catalog release label' using errcode = '22023';
  end if;

  -- One activation at a time. Only private.catalog_* rows are involved.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('union-catalog-activation', 509));

  select r.id, r.status, r.loaded_at, r.verified_at, r.verified_sha256, (r.counts ->> 'allowRetire')::bigint
    into target_id, target_status, target_loaded_at, target_verified_at, target_verified_sha256, allow_retire
    from private.catalog_releases as r
   where r.label = p_label
     for update;
  -- A staged release, or a retired one whose staging rows were kept for a
  -- rollback. Never the active release and never a failed one.
  if target_id is null or target_status not in ('staged', 'retired') then
    raise exception 'catalog release is not staged' using errcode = '22023';
  end if;
  -- catalog:verify stamps verified_at when the staged rows match the
  -- artifact; a later load clears the stamp by moving loaded_at past it, a
  -- failed verify clears it, and retiring a release clears it, so a rollback
  -- is verified again against the current exclusion list and privacy gate.
  if target_verified_at is null or target_verified_at < target_loaded_at then
    raise exception 'catalog release is not verified; run catalog:verify first' using errcode = '22023';
  end if;
  select pg_catalog.count(*)
    into staged_organizations
    from private.catalog_staging as s
   where s.release_id = target_id
     and s.table_name = 'organizations';
  if staged_organizations = 0 then
    raise exception 'catalog release has no staged rows; load it again' using errcode = '22023';
  end if;
  -- The staged rows must be exactly the ones catalog:verify matched: the
  -- digest (sha256 over every staged row's table, key, content hash and a
  -- sha256 of its content, in key order) is recomputed here and compared
  -- with the one verify stored. scripts/load-union-catalog.mjs
  -- (STAGING_DIGEST_SQL) computes the same expression.
  select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(coalesce(pg_catalog.string_agg(
           s.table_name || ' ' || s.row_key || ' ' || s.content_sha256 || ' '
             || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(s.content::text, 'UTF8')), 'hex'),
           pg_catalog.chr(10) order by s.table_name, s.row_key), ''), 'UTF8')), 'hex')
    into staged_sha256
    from private.catalog_staging as s
   where s.release_id = target_id;
  if target_verified_sha256 is null or staged_sha256 is distinct from target_verified_sha256 then
    raise exception 'catalog release staged rows changed after catalog:verify; run catalog:verify again' using errcode = '22023';
  end if;

  -- A research release carries its base's content rows unchanged and was
  -- checked at load against the live rows of the release then active
  -- (catalog:load records its id in research_loaded_over). It may
  -- replace only that release: if another release was activated since, its
  -- corrections or research rows would be overwritten or retired unchecked.
  -- A retired target is a deliberate rollback to a snapshot that was live,
  -- verified again, under the withdrawal guard below; it is not rechecked.
  select r.research_loaded_over into research_loaded_over from private.catalog_releases as r where r.id = target_id;
  if target_status = 'staged'
     and research_loaded_over is not null
     and research_loaded_over is distinct from (
       select r.id from private.catalog_releases as r where r.status = 'active') then
    raise exception 'catalog research release was loaded over a release that is no longer active; load it again' using errcode = '22023';
  end if;

  -- The withdrawal guard (spec section 2.6), enforced where rows actually
  -- retire: more than 3% of live organizations or 10% of live sub-units may
  -- retire only under the ceiling the operator recorded with --allow-retire.
  select pg_catalog.count(*),
         pg_catalog.count(*) filter (where not exists (
           select 1 from private.catalog_staging as s
            where s.release_id = target_id and s.table_name = 'organizations' and s.row_key = o.catalog_key))
    into live_organizations, retiring_organizations
    from private.catalog_organizations as o
   where o.retired_release_id is null;
  select pg_catalog.count(*),
         pg_catalog.count(*) filter (where not exists (
           select 1 from private.catalog_staging as s
            where s.release_id = target_id and s.table_name = 'subunits' and s.row_key = u.subunit_key))
    into live_subunits, retiring_subunits
    from private.catalog_subunits as u
   where u.retired_release_id is null;
  if (allow_retire is not null and retiring_organizations + retiring_subunits > allow_retire)
     or (allow_retire is null
         and (retiring_organizations > live_organizations * 0.03 or retiring_subunits > live_subunits * 0.1)) then
    raise exception 'withdrawal guard: % of % live organizations and % of % live sub-units would retire; re-run activate with --allow-retire %',
      retiring_organizations, live_organizations, retiring_subunits, live_subunits, retiring_organizations + retiring_subunits
      using errcode = '22023';
  end if;

  -- Apply the staged set: insert new rows, update rows whose content changed
  -- or that were retired, leave unchanged live rows alone (first_release_id
  -- is never updated), then retire every live row the release does not carry.
  -- organizations
  insert into private.catalog_organizations as t
  select r.*
    from private.catalog_staging as s
    cross join lateral pg_catalog.jsonb_populate_record(
      null::private.catalog_organizations,
      s.content || pg_catalog.jsonb_build_object(
        'first_release_id', target_id, 'last_release_id', target_id, 'retired_release_id', null, 'content_sha256', s.content_sha256)
    ) as r
   where s.release_id = target_id
     and s.table_name = 'organizations'
  on conflict (catalog_key) do update
     set olms_file_number = excluded.olms_file_number,
         union_org_id = excluded.union_org_id,
         origin = excluded.origin,
         name = excluded.name,
         aka = excluded.aka,
         family = excluded.family,
         designation = excluded.designation,
         local_number = excluded.local_number,
         tier = excluded.tier,
         org_type_label = excluded.org_type_label,
         sector = excluded.sector,
         industries = excluded.industries,
         occupations = excluded.occupations,
         trades = excluded.trades,
         city = excluded.city,
         state = excluded.state,
         zip5 = excluded.zip5,
         census_region = excluded.census_region,
         census_division = excluded.census_division,
         latitude = excluded.latitude,
         longitude = excluded.longitude,
         geo_precision = excluded.geo_precision,
         website = excluded.website,
         members_reported = excluded.members_reported,
         members_fiscal_year = excluded.members_fiscal_year,
         structure_note = excluded.structure_note,
         election_term_years = excluded.election_term_years,
         next_election_on = excluded.next_election_on,
         bylaws_url = excluded.bylaws_url,
         confidence = excluded.confidence,
         researched_on = excluded.researched_on,
         source_urls = excluded.source_urls,
         duplicate_of = excluded.duplicate_of,
         search_text = excluded.search_text,
         last_release_id = excluded.last_release_id,
         retired_release_id = null,
         content_sha256 = excluded.content_sha256
   where t.content_sha256 is distinct from excluded.content_sha256
      or t.retired_release_id is not null;

  -- edges
  insert into private.catalog_edges as t
  select r.*
    from private.catalog_staging as s
    cross join lateral pg_catalog.jsonb_populate_record(
      null::private.catalog_edges,
      s.content || pg_catalog.jsonb_build_object(
        'first_release_id', target_id, 'last_release_id', target_id, 'retired_release_id', null, 'content_sha256', s.content_sha256)
    ) as r
   where s.release_id = target_id
     and s.table_name = 'edges'
  on conflict (edge_key) do update
     set child_key = excluded.child_key,
         parent_key = excluded.parent_key,
         parent_label = excluded.parent_label,
         edge_kind = excluded.edge_kind,
         certainty = excluded.certainty,
         source_url = excluded.source_url,
         last_release_id = excluded.last_release_id,
         retired_release_id = null,
         content_sha256 = excluded.content_sha256
   where t.content_sha256 is distinct from excluded.content_sha256
      or t.retired_release_id is not null;

  -- subunits
  insert into private.catalog_subunits as t
  select r.*
    from private.catalog_staging as s
    cross join lateral pg_catalog.jsonb_populate_record(
      null::private.catalog_subunits,
      s.content || pg_catalog.jsonb_build_object(
        'first_release_id', target_id, 'last_release_id', target_id, 'retired_release_id', null, 'content_sha256', s.content_sha256)
    ) as r
   where s.release_id = target_id
     and s.table_name = 'subunits'
  on conflict (subunit_key) do update
     set catalog_key = excluded.catalog_key,
         parent_subunit_key = excluded.parent_subunit_key,
         kind = excluded.kind,
         kind_label = excluded.kind_label,
         name = excluded.name,
         location = excluded.location,
         employer = excluded.employer,
         members = excluded.members,
         members_source = excluded.members_source,
         density_note = excluded.density_note,
         website = excluded.website,
         election_note = excluded.election_note,
         structure_note = excluded.structure_note,
         confidence = excluded.confidence,
         source_url = excluded.source_url,
         as_of = excluded.as_of,
         last_release_id = excluded.last_release_id,
         retired_release_id = null,
         content_sha256 = excluded.content_sha256
   where t.content_sha256 is distinct from excluded.content_sha256
      or t.retired_release_id is not null;

  -- seat_outlines
  insert into private.catalog_seat_outlines as t
  select r.*
    from private.catalog_staging as s
    cross join lateral pg_catalog.jsonb_populate_record(
      null::private.catalog_seat_outlines,
      s.content || pg_catalog.jsonb_build_object(
        'first_release_id', target_id, 'last_release_id', target_id, 'retired_release_id', null, 'content_sha256', s.content_sha256)
    ) as r
   where s.release_id = target_id
     and s.table_name = 'seat_outlines'
  on conflict (outline_key) do update
     set catalog_key = excluded.catalog_key,
         subunit_key = excluded.subunit_key,
         seat_class = excluded.seat_class,
         title = excluded.title,
         listed = excluded.listed,
         vacant = excluded.vacant,
         source_url = excluded.source_url,
         as_of = excluded.as_of,
         last_release_id = excluded.last_release_id,
         retired_release_id = null,
         content_sha256 = excluded.content_sha256
   where t.content_sha256 is distinct from excluded.content_sha256
      or t.retired_release_id is not null;

  -- contacts
  insert into private.catalog_contacts as t
  select r.*
    from private.catalog_staging as s
    cross join lateral pg_catalog.jsonb_populate_record(
      null::private.catalog_contacts,
      s.content || pg_catalog.jsonb_build_object(
        'first_release_id', target_id, 'last_release_id', target_id, 'retired_release_id', null, 'content_sha256', s.content_sha256)
    ) as r
   where s.release_id = target_id
     and s.table_name = 'contacts'
  on conflict (contact_key) do update
     set catalog_key = excluded.catalog_key,
         contact_kind = excluded.contact_kind,
         value = excluded.value,
         label = excluded.label,
         basis = excluded.basis,
         source_url = excluded.source_url,
         as_of = excluded.as_of,
         last_release_id = excluded.last_release_id,
         retired_release_id = null,
         content_sha256 = excluded.content_sha256
   where t.content_sha256 is distinct from excluded.content_sha256
      or t.retired_release_id is not null;

  -- documents
  insert into private.catalog_documents as t
  select r.*
    from private.catalog_staging as s
    cross join lateral pg_catalog.jsonb_populate_record(
      null::private.catalog_documents,
      s.content || pg_catalog.jsonb_build_object(
        'first_release_id', target_id, 'last_release_id', target_id, 'retired_release_id', null, 'content_sha256', s.content_sha256)
    ) as r
   where s.release_id = target_id
     and s.table_name = 'documents'
  on conflict (document_key) do update
     set catalog_key = excluded.catalog_key,
         doc_kind = excluded.doc_kind,
         title = excluded.title,
         title_derived = excluded.title_derived,
         url = excluded.url,
         url_host = excluded.url_host,
         as_of = excluded.as_of,
         last_release_id = excluded.last_release_id,
         retired_release_id = null,
         content_sha256 = excluded.content_sha256
   where t.content_sha256 is distinct from excluded.content_sha256
      or t.retired_release_id is not null;

  -- document_subunits
  insert into private.catalog_document_subunits as t
  select r.*
    from private.catalog_staging as s
    cross join lateral pg_catalog.jsonb_populate_record(
      null::private.catalog_document_subunits,
      s.content || pg_catalog.jsonb_build_object(
        'first_release_id', target_id, 'last_release_id', target_id, 'retired_release_id', null, 'content_sha256', s.content_sha256)
    ) as r
   where s.release_id = target_id
     and s.table_name = 'document_subunits'
  on conflict (document_key, subunit_key) do update
     set last_release_id = excluded.last_release_id,
         retired_release_id = null,
         content_sha256 = excluded.content_sha256
   where t.content_sha256 is distinct from excluded.content_sha256
      or t.retired_release_id is not null;

  -- research_facts
  insert into private.catalog_research_facts as t
  select r.*
    from private.catalog_staging as s
    cross join lateral pg_catalog.jsonb_populate_record(
      null::private.catalog_research_facts,
      s.content || pg_catalog.jsonb_build_object(
        'first_release_id', target_id, 'last_release_id', target_id, 'retired_release_id', null, 'content_sha256', s.content_sha256)
    ) as r
   where s.release_id = target_id
     and s.table_name = 'research_facts'
  on conflict (fact_key) do update
     set evidence_tier = excluded.evidence_tier,
         binding = excluded.binding,
         catalog_key = excluded.catalog_key,
         publisher_candidates = excluded.publisher_candidates,
         fact_kind = excluded.fact_kind,
         title = excluded.title,
         url = excluded.url,
         url_host = excluded.url_host,
         as_of = excluded.as_of,
         unresolved = excluded.unresolved,
         source_sha256 = excluded.source_sha256,
         last_release_id = excluded.last_release_id,
         retired_release_id = null,
         content_sha256 = excluded.content_sha256
   where t.content_sha256 is distinct from excluded.content_sha256
      or t.retired_release_id is not null;

  -- research_categories
  insert into private.catalog_research_categories as t
  select r.*
    from private.catalog_staging as s
    cross join lateral pg_catalog.jsonb_populate_record(
      null::private.catalog_research_categories,
      s.content || pg_catalog.jsonb_build_object(
        'first_release_id', target_id, 'last_release_id', target_id, 'retired_release_id', null, 'content_sha256', s.content_sha256)
    ) as r
   where s.release_id = target_id
     and s.table_name = 'research_categories'
  on conflict (category_key) do update
     set catalog_key = excluded.catalog_key,
         evidence_tier = excluded.evidence_tier,
         category = excluded.category,
         outcome = excluded.outcome,
         gate_contract = excluded.gate_contract,
         evaluated_on = excluded.evaluated_on,
         last_release_id = excluded.last_release_id,
         retired_release_id = null,
         content_sha256 = excluded.content_sha256
   where t.content_sha256 is distinct from excluded.content_sha256
      or t.retired_release_id is not null;


  update private.catalog_organizations as t
     set retired_release_id = target_id
   where t.retired_release_id is null
     and not exists (
       select 1 from private.catalog_staging as s
        where s.release_id = target_id and s.table_name = 'organizations' and s.row_key = t.catalog_key);

  update private.catalog_edges as t
     set retired_release_id = target_id
   where t.retired_release_id is null
     and not exists (
       select 1 from private.catalog_staging as s
        where s.release_id = target_id and s.table_name = 'edges' and s.row_key = t.edge_key);

  update private.catalog_subunits as t
     set retired_release_id = target_id
   where t.retired_release_id is null
     and not exists (
       select 1 from private.catalog_staging as s
        where s.release_id = target_id and s.table_name = 'subunits' and s.row_key = t.subunit_key);

  update private.catalog_seat_outlines as t
     set retired_release_id = target_id
   where t.retired_release_id is null
     and not exists (
       select 1 from private.catalog_staging as s
        where s.release_id = target_id and s.table_name = 'seat_outlines' and s.row_key = t.outline_key);

  update private.catalog_contacts as t
     set retired_release_id = target_id
   where t.retired_release_id is null
     and not exists (
       select 1 from private.catalog_staging as s
        where s.release_id = target_id and s.table_name = 'contacts' and s.row_key = t.contact_key);

  update private.catalog_documents as t
     set retired_release_id = target_id
   where t.retired_release_id is null
     and not exists (
       select 1 from private.catalog_staging as s
        where s.release_id = target_id and s.table_name = 'documents' and s.row_key = t.document_key);

  update private.catalog_document_subunits as t
     set retired_release_id = target_id
   where t.retired_release_id is null
     and not exists (
       select 1 from private.catalog_staging as s
        where s.release_id = target_id and s.table_name = 'document_subunits' and s.row_key = t.document_key || '|' || t.subunit_key);

  -- A release without research tables retires every live research row: a
  -- release is a complete snapshot of everything it carries.
  update private.catalog_research_facts as t
     set retired_release_id = target_id
   where t.retired_release_id is null
     and not exists (
       select 1 from private.catalog_staging as s
        where s.release_id = target_id and s.table_name = 'research_facts' and s.row_key = t.fact_key);

  update private.catalog_research_categories as t
     set retired_release_id = target_id
   where t.retired_release_id is null
     and not exists (
       select 1 from private.catalog_staging as s
        where s.release_id = target_id and s.table_name = 'research_categories' and s.row_key = t.category_key);

  select r.id
    into previous_id
    from private.catalog_releases as r
   where r.status = 'active';

  -- The retired release keeps its staging rows for a rollback, but not its
  -- verify stamp: activating it again needs a fresh catalog:verify.
  update private.catalog_releases as r
     set status = 'retired',
         verified_at = null,
         verified_sha256 = null
   where r.status = 'active';

  update private.catalog_releases as r
     set status = 'active',
         activated_at = pg_catalog.now()
   where r.id = target_id;

  delete from private.catalog_coverage as cov
   where cov.catalog_key is not null;

  insert into private.catalog_coverage (
    catalog_key, release_id, subunits, subunits_with_members, seat_outlines, documents, checklist, band, last_researched
  )
  select o.catalog_key,
         target_id,
         coalesce(sub.total, 0),
         coalesce(sub.with_members, 0),
         coalesce(seat.total, 0),
         pg_catalog.jsonb_build_object(
           'contract', coalesce(doc.contracts, 0),
           'bylaws', coalesce(doc.bylaws, 0),
           'form', coalesce(doc.forms, 0),
           'newsletter', coalesce(doc.newsletters, 0),
           'handbook', coalesce(doc.handbooks, 0),
           'other', coalesce(doc.others, 0)
         ),
         pg_catalog.jsonb_build_object(
           'website', o.website is not null,
           'publicContact', coalesce(contact.public_contacts, 0) > 0,
           'structure', coalesce(sub.total, 0) > 0,
           'seats', coalesce(seat.total, 0) > 0,
           'governingDocument', o.bylaws_url is not null or coalesce(doc.bylaws, 0) > 0,
           'contract', coalesce(doc.contracts, 0) > 0,
           'electionCadence', o.election_term_years is not null or o.next_election_on is not null,
           'hierarchy', coalesce(edge.total, 0) > 0
         ),
         case
           when coalesce(sub.total, 0) > 0 and coalesce(doc.total, 0) > 0 and o.members_reported is not null then 'deep'
           when coalesce(sub.total, 0) > 0 or coalesce(seat.total, 0) > 0 then 'structured'
           else 'basic'
         end,
         o.researched_on
    from private.catalog_organizations as o
    left join (
      select s.catalog_key, pg_catalog.count(*) as total,
             pg_catalog.count(*) filter (where s.members is not null) as with_members
        from private.catalog_subunits as s
       where s.retired_release_id is null
       group by s.catalog_key
    ) as sub on sub.catalog_key = o.catalog_key
    left join (
      select so.catalog_key, pg_catalog.count(*) as total
        from private.catalog_seat_outlines as so
       where so.retired_release_id is null
       group by so.catalog_key
    ) as seat on seat.catalog_key = o.catalog_key
    left join (
      select d.catalog_key, pg_catalog.count(*) as total,
             pg_catalog.count(*) filter (where d.doc_kind = 'contract') as contracts,
             pg_catalog.count(*) filter (where d.doc_kind = 'bylaws') as bylaws,
             pg_catalog.count(*) filter (where d.doc_kind = 'form') as forms,
             pg_catalog.count(*) filter (where d.doc_kind = 'newsletter') as newsletters,
             pg_catalog.count(*) filter (where d.doc_kind = 'handbook') as handbooks,
             pg_catalog.count(*) filter (where d.doc_kind = 'other') as others
        from private.catalog_documents as d
       where d.retired_release_id is null
       group by d.catalog_key
    ) as doc on doc.catalog_key = o.catalog_key
    left join (
      select c.catalog_key, pg_catalog.count(*) filter (where c.contact_kind <> 'website') as public_contacts
        from private.catalog_contacts as c
       where c.retired_release_id is null
       group by c.catalog_key
    ) as contact on contact.catalog_key = o.catalog_key
    left join (
      select ends.catalog_key, pg_catalog.count(*) as total
        from (
          select e.child_key as catalog_key from private.catalog_edges as e where e.retired_release_id is null
          union all
          select e.parent_key from private.catalog_edges as e where e.retired_release_id is null and e.parent_key is not null
        ) as ends
       group by ends.catalog_key
    ) as edge on edge.catalog_key = o.catalog_key
   where o.retired_release_id is null
     and o.duplicate_of is null;


  -- The live, non-retired row set must now be exactly the staged set.
  select pg_catalog.array_agg(live.table_name order by live.table_name)
    into mismatched_tables
    from (
      select 'organizations' as table_name, pg_catalog.count(*) as live_rows
        from private.catalog_organizations as t where t.retired_release_id is null
      union all
      select 'edges', pg_catalog.count(*) from private.catalog_edges as t where t.retired_release_id is null
      union all
      select 'subunits', pg_catalog.count(*) from private.catalog_subunits as t where t.retired_release_id is null
      union all
      select 'seat_outlines', pg_catalog.count(*) from private.catalog_seat_outlines as t where t.retired_release_id is null
      union all
      select 'contacts', pg_catalog.count(*) from private.catalog_contacts as t where t.retired_release_id is null
      union all
      select 'documents', pg_catalog.count(*) from private.catalog_documents as t where t.retired_release_id is null
      union all
      select 'document_subunits', pg_catalog.count(*) from private.catalog_document_subunits as t where t.retired_release_id is null
      union all
      select 'research_facts', pg_catalog.count(*) from private.catalog_research_facts as t where t.retired_release_id is null
      union all
      select 'research_categories', pg_catalog.count(*) from private.catalog_research_categories as t where t.retired_release_id is null
    ) as live
    left join (
      select s.table_name, pg_catalog.count(*) as staged_rows
        from private.catalog_staging as s
       where s.release_id = target_id
       group by s.table_name
    ) as staged on staged.table_name = live.table_name
   where live.live_rows <> coalesce(staged.staged_rows, 0);
  if mismatched_tables is not null then
    raise exception 'catalog activation left % out of step with the staged release', mismatched_tables;
  end if;

  -- Counts only: what this release added, retired and changed.
  diff := pg_catalog.jsonb_build_object(
    'organizationsAdded', (select pg_catalog.count(*) from private.catalog_organizations as o
                            where o.first_release_id = target_id and o.retired_release_id is null),
    'organizationsRetired', (select pg_catalog.count(*) from private.catalog_organizations as o
                              where o.retired_release_id = target_id),
    'organizationsChanged', (select pg_catalog.count(*) from private.catalog_organizations as o
                              where o.last_release_id = target_id and o.first_release_id <> target_id
                                and o.retired_release_id is null),
    'subunitsAdded', (select pg_catalog.count(*) from private.catalog_subunits as s
                       where s.first_release_id = target_id and s.retired_release_id is null),
    'subunitsRetired', (select pg_catalog.count(*) from private.catalog_subunits as s
                         where s.retired_release_id = target_id)
  );
  -- Research counts appear only when research rows were involved, so the
  -- diff of a release without research tables keeps its earlier shape.
  if exists (select 1 from private.catalog_staging as s
              where s.release_id = target_id and s.table_name in ('research_facts', 'research_categories'))
     or exists (select 1 from private.catalog_research_facts as f where f.retired_release_id = target_id)
     or exists (select 1 from private.catalog_research_categories as c where c.retired_release_id = target_id) then
    diff := diff || pg_catalog.jsonb_build_object(
      'researchFactsAdded', (select pg_catalog.count(*) from private.catalog_research_facts as f
                              where f.first_release_id = target_id and f.retired_release_id is null),
      'researchFactsRetired', (select pg_catalog.count(*) from private.catalog_research_facts as f
                                where f.retired_release_id = target_id),
      'researchCategoriesAdded', (select pg_catalog.count(*) from private.catalog_research_categories as c
                                   where c.first_release_id = target_id and c.retired_release_id is null),
      'researchCategoriesRetired', (select pg_catalog.count(*) from private.catalog_research_categories as c
                                     where c.retired_release_id = target_id)
    );
  end if;

  update private.catalog_releases as r
     set activation_diff = diff
   where r.id = target_id;

  -- Keep the staging rows of this release and of the one it retired (a
  -- rollback re-applies them); every other release must be loaded again.
  delete from private.catalog_staging as s
   where s.release_id <> target_id
     and s.release_id is distinct from previous_id;

  -- REQ-UG-CATALOG-DOCUMENTS-MEMBERS-ONLY-20261110: the registry
  -- websites linked to the catalog are judged again now that its documents
  -- are final. Unlike the rest of this function, this call also writes
  -- outside the catalog: it updates public.union_orgs.website.
  perform private.catalog_refresh_registry_websites();

  return diff;
end;
$function$;

revoke all on function private.catalog_activate_release(text) from public, anon, authenticated, service_role;

-- anon reads every registry column except sources.
revoke select on public.union_orgs from anon;
grant select (id, olms_file_number, name, affiliation, designation, local_number, level,
              parent_olms_file_number, parent_affiliation, parent_name, sector_public_private, sector_tags,
              city, state, zip, latitude, longitude, geocode_precision, geocode_match_type, website,
              members_latest, members_latest_year, membership_history, finances, public_record_coverage,
              enrichment_status, source_updated_at, atlas_manifest_sha, first_loaded_at, is_fictional)
  on public.union_orgs to anon;

insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select s.kind, s.schema_name, s.table_name, s.object_name, s.definition_hash
from private.account_lifecycle_trigger_surface() s
where (s.kind = 'function'
  and ((s.schema_name = 'public' and pg_catalog.split_part(s.object_name, '(', 1) in ('get_union_catalog_profile', 'search_union_catalog'))
    or (s.schema_name = 'private' and pg_catalog.split_part(s.object_name, '(', 1)
        in ('catalog_link_decoded', 'catalog_link_parts', 'catalog_link_canonical', 'catalog_public_citation',
            'catalog_withheld_destinations', 'union_orgs_public_website', 'catalog_public_text', 'catalog_public_json', 'catalog_link_site',
            'registry_withheld_destinations', 'catalog_refresh_registry_websites', 'catalog_activate_release'))))
   or (s.kind = 'trigger' and s.schema_name = 'public' and s.table_name = 'union_orgs'
       and s.object_name = 'union_orgs_public_website')

on conflict (kind, schema_name, table_name, object_name)
do update set definition_hash = excluded.definition_hash;
do $review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review incomplete after the catalog members-only change';
  end if;
end;
$review$;

notify pgrst, 'reload schema';
commit;
