import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLang } from "../../lib/LanguageContext.jsx";
import { SourceLine } from "../../components/SourceLine.jsx";
import { sanitizePublicMarkdown } from "../../lib/sanitizePublicMarkdown.js";
import { demoteMailboxLinks, loadFederalLawIndex, loadRegulationsIndex, loadRightsLawAgencies, loadRightsLawDocuments, markdownBlocks, recordsOf, splitMarkdown } from "./rightsLawLibrary.js";
import "./rightsLawLibrary.css";

// REQ-UG-RIGHTS-LAW-LIBRARY-20261012: the Massachusetts and federal
// labor-rights library on the Rights page, behind features.rights.law_library.
// Everything shown comes from data/reference/labor-rights/ and renders its
// SourceLine; a row whose record is missing says so instead of passing as
// sourced. General information, not legal advice: every situation routes to
// the member's steward. The agency pages and guides (documents.json) load only
// when the member opens them, so the first paint fetches agencies.json alone.

// The site carries no "509" in its own copy, and the inputs the
// line lists include the source library's repository coordinates. The record
// keeps every input; the line lists the provenance records it can resolve.
function displayProvenance(provenance) {
  if (!Array.isArray(provenance?.derived_from)) return provenance;
  return { ...provenance, derived_from: provenance.derived_from.filter((reference) => String(reference).startsWith("prov-")) };
}

function Sourced({ item, inputs }) {
  return <SourceLine provenance={displayProvenance(item.provenance)} inputs={inputs} className="rights-library__source" />;
}

function Deadline({ deadline, inputs, t }) {
  return (
    <li className="rights-library__deadline" id={`rights-deadline-${deadline.id}`}>
      <p className="rights-library__claim" lang="en">{deadline.claim}</p>
      <dl>
        <dt>{t("rightsLibrary.howLong")}</dt><dd lang="en">{deadline.period_text}</dd>
        {deadline.trigger ? <><dt>{t("rightsLibrary.trigger")}</dt><dd lang="en">{deadline.trigger}</dd></> : null}
        {deadline.extension ? <><dt>{t("rightsLibrary.extension")}</dt><dd lang="en">{deadline.extension}</dd></> : null}
        {deadline.statute ? <><dt>{t("rightsLibrary.law")}</dt><dd lang="en">{deadline.statute}</dd></> : null}
      </dl>
      <blockquote cite={deadline.evidence_url} aria-label={t("rightsLibrary.quote")} lang="en">{deadline.quote}</blockquote>
      <Sourced item={deadline} inputs={inputs} />
    </li>
  );
}

// One table cell through the public sanitizer, without its paragraph wrapper.
function inlineMarkdown(cell) {
  return sanitizePublicMarkdown(cell).replace(/^<p>([\s\S]*)<\/p>$/, "$1");
}

function DocumentBody({ document }) {
  // The shared public sanitizer escapes everything and allows only headings,
  // lists, emphasis and https links; long pages are rendered in sections so
  // its length cap never cuts the text, and tables are built here, each cell
  // through the same sanitizer.
  return (
    <div className="rights-library__doc" lang="en">
      {markdownBlocks(demoteMailboxLinks(document.body_md)).flatMap((block, index) => (block.kind === "table" ? [
        <div key={`t${index}`} className="rights-library__table">
          <table>
            <thead><tr>{block.rows[0].map((cell, column) => <th key={column} scope="col" dangerouslySetInnerHTML={{ __html: inlineMarkdown(cell) }} />)}</tr></thead>
            <tbody>{block.rows.slice(1).map((row, rowIndex) => (
              <tr key={rowIndex}>{row.map((cell, column) => <td key={column} dangerouslySetInnerHTML={{ __html: inlineMarkdown(cell) }} />)}</tr>
            ))}</tbody>
          </table>
        </div>,
      ] : block.kind === "ordered" ? [
        <ol key={`o${index}`}>{block.items.map((item, itemIndex) => <li key={itemIndex} value={item.number} dangerouslySetInnerHTML={{ __html: inlineMarkdown(item.text) }} />)}</ol>,
      ] : splitMarkdown(block.text).map((part, partIndex) => (
        <div key={`m${index}-${partIndex}`} dangerouslySetInnerHTML={{ __html: sanitizePublicMarkdown(part) }} />
      ))))}
    </div>
  );
}

// Dial the base number; an extension ("ext. 1") stays in the visible text.
function telNumber(value) {
  return value.split(/\s*(?:ext\.?|extension|x)\s*\d/i)[0].replace(/[^\d+]/g, "");
}

// UX-UG-RIGHTS-LIBRARY-AGENCY-EXCERPT-DEADLINE-NOTE-20261022: an
// agency excerpt stays verbatim; where its deadline wording differs from the
// library's cards, the library's own note sits beside it, labelled as the
// library's, and links each card it restates.
function LibraryNote({ note, deadlines, documentId, inputs }) {
  const titleId = `rights-note-${documentId}`;
  return (
    <aside className="rights-library__note" aria-labelledby={titleId} lang="en">
      <p><strong id={titleId}>{note.title}</strong></p>
      <p>{note.text}</p>
      <ul>
        {note.deadline_ids.map((id) => (
          <li key={id}><a href={`#rights-deadline-${id}`}>{deadlines.find((deadline) => deadline.id === id)?.claim ?? id}</a></li>
        ))}
      </ul>
      <Sourced item={note} inputs={inputs} />
    </aside>
  );
}

function DocumentItem({ document, deadlines = [], inputs, t }) {
  return (
    <details className="rights-library__page" id={`rights-doc-${document.id}`}>
      <summary lang="en">{document.title}</summary>
      <Sourced item={document} inputs={inputs} />
      {document.library_note ? <LibraryNote note={document.library_note} deadlines={deadlines} documentId={document.id} inputs={inputs} /> : null}
      <DocumentBody document={document} />
      {/* The authored guides live on this page; only agency pages link out. */}
      {document.agency_id ? <p><a href={document.url} target="_blank" rel="noopener noreferrer">{t("rightsLibrary.readPage")}</a></p> : null}
    </details>
  );
}

// Opening the disclosure is what asks for documents.json; until it arrives
// the panel says so, and a failed load says so too, with Try again (#9890).
function DocumentsPanel({ summary, documents, onOpen, t, children }) {
  return (
    <details className="rights-library__pages" onToggle={(event) => { if (event.currentTarget.open) onOpen(); }}>
      <summary>{summary}</summary>
      {documents.status === "ready" ? children(documents.file)
        : documents.status === "failed" ? <p role="alert">{t("rightsLibrary.loadFailed")} <button type="button" className="xus-btn" onClick={() => onOpen()}>{t("rightsLibrary.retry")}</button></p>
          : documents.status === "loading" ? <p aria-busy="true">{t("rightsLibrary.loading")}</p> : null}
    </details>
  );
}

// BUG-UG-RIGHTS-PAGE-RENDERS-WHOLE-LIBRARY-20261106: every agency
// and concept opened in full made the page about 14,600 px tall, so each card
// starts collapsed to its name; a situation's jump link opens the card it
// names.
function AgencyCard({ agency, documents, onOpenDocuments, inputs, documentInputs, t }) {
  return (
    <details className="rights-library__agency" id={`rights-agency-${agency.id}`}>
      <summary><h4 lang="en">{agency.name}{agency.abbreviation ? ` (${agency.abbreviation})` : ""}</h4></summary>
      <div className="rights-library__agency-body">
        <p className="rights-library__statute" lang="en">{agency.primary_statute}</p>
        <Sourced item={agency} inputs={inputs} />
        {agency.use_for?.length ? (
          <>
            <h5>{t("rightsLibrary.handles")}</h5>
            <ul className="rights-library__uses" lang="en">{agency.use_for.map((use) => <li key={use}>{use}</li>)}</ul>
          </>
        ) : null}
        <h5>{t("rightsLibrary.deadlines")}</h5>
        {agency.deadlines.length
          ? <ul className="rights-library__deadlines">{agency.deadlines.map((deadline) => <Deadline key={deadline.id} deadline={deadline} inputs={inputs} t={t} />)}</ul>
          : <p>{t("rightsLibrary.noDeadlines")}</p>}
        {agency.contact?.length ? (
          <>
            <h5>{t("rightsLibrary.contact")}</h5>
            <ul className="rights-library__contact">
              {agency.contact.map((row) => (
                <li key={`${row.field}:${row.value}`} lang="en">
                  {row.label ? `${row.label}: ` : ""}
                  {row.field === "phone" ? <a href={`tel:${telNumber(row.value)}`}>{row.value}</a>
                    : row.field === "email" ? <a href={`mailto:${row.value}`}>{row.value}</a>
                      : /^https:\/\//.test(row.value) ? <a href={row.value} target="_blank" rel="noopener noreferrer">{row.value}</a>
                        : row.value}
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {agency.documents?.length ? (
          <DocumentsPanel summary={t("rightsLibrary.pagesCount", { count: agency.documents.length })} documents={documents} onOpen={onOpenDocuments} t={t}>
            {(file) => file.documents.filter((document) => document.agency_id === agency.id)
              .map((document) => <DocumentItem key={document.id} document={document} deadlines={agency.deadlines} inputs={documentInputs} t={t} />)}
          </DocumentsPanel>
        ) : null}
      </div>
    </details>
  );
}

// A closed card would leave the jump at a bare heading; open it first and let
// the browser follow the link.
function openAgency(id) {
  const card = globalThis.document?.getElementById(`rights-agency-${id}`);
  if (card) card.open = true;
}

// A small file that loads once, the first time its panel opens.
function useLazyFile(load) {
  const [file, setFile] = useState({ status: "idle", file: null });
  const requested = useRef(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);
  const open = useCallback(() => {
    if (requested.current) return;
    requested.current = true;
    setFile({ status: "loading", file: null });
    load().then(
      (value) => { if (live.current) setFile({ status: "ready", file: value }); },
      () => {
        requested.current = false;
        if (live.current) setFile({ status: "failed", file: null });
      },
    );
  }, [load]);
  return [file, open];
}

// REQ-UG-RIGHTS-LIBRARY-FEDERAL-TEXT-TO-OFFICIAL-LINKS-20261110: one
// line per federal act and per regulation part, each linked to its official
// text. Opening the section loads the two small indexes.
function FederalAct({ act, parts, t }) {
  return (
    <li className="rights-library__federal-act" id={`rights-act-${act.id}`}>
      <span lang="en">{act.name}{act.abbreviation ? ` (${act.abbreviation})` : ""}, {act.citation}.</span>{" "}
      <a href={act.url} target="_blank" rel="noopener noreferrer">{t("rightsLibrary.readOfficial")}</a>
      {parts.length ? (
        <ul aria-label={t("rightsLibrary.regulations")}>
          {parts.map((part) => (
            <li key={part.id} id={`rights-cfr-${part.id}`}>
              <span lang="en">{part.citation}, {part.heading}.</span>{" "}
              <a href={part.url} target="_blank" rel="noopener noreferrer">{t("rightsLibrary.readEcfr")}</a>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function FederalLaw({ loadIndex, loadRegulations, t }) {
  const [index, openIndex] = useLazyFile(loadIndex);
  const [regulations, openRegulations] = useLazyFile(loadRegulations);
  const open = useCallback(() => { openIndex(); openRegulations(); }, [openIndex, openRegulations]);
  // The section shows once both indexes are in: an act is never listed with
  // an empty part list while the regulations are loading or after they failed.
  // Reopening the panel retries a failed load.
  const both = index.status === "failed" || regulations.status === "failed" ? { status: "failed", file: null }
    : index.status === "ready" && regulations.status === "ready" ? { status: "ready", file: { index: index.file, parts: regulations.file.parts } }
      : index.status === "idle" && regulations.status === "idle" ? { status: "idle", file: null } : { status: "loading", file: null };
  return (
    <>
      <h3>{t("rightsLibrary.federalLaw")}</h3>
      <p className="rights-library__statute">{t("rightsLibrary.federalLawIntro")}</p>
      <DocumentsPanel summary={t("rightsLibrary.openFederalLaw")} documents={both} onOpen={open} t={t}>
        {({ index: file, parts }) => (
          <>
            <p className="rights-library__statute" lang="en">{file.disclaimer}</p>
            <ul className="rights-library__federal">
              {file.acts.map((act) => <FederalAct key={act.id} act={act} parts={parts.filter((part) => part.act === act.id)} t={t} />)}
            </ul>
          </>
        )}
      </DocumentsPanel>
    </>
  );
}

export function RightsLawLibrary({ onAskSteward = null, loadAgencies = loadRightsLawAgencies, loadDocuments = loadRightsLawDocuments, loadFederalIndex = loadFederalLawIndex,
  loadRegulations = loadRegulationsIndex }) {
  const { t, lang } = useLang();
  const [state, setState] = useState({ status: "loading", agencies: null });
  const [documents, setDocuments] = useState({ status: "idle", file: null });
  const live = useRef(true);
  // #9890: Try again on a failed agencies read runs the same read again.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    live.current = true;
    loadAgencies().then(
      (agencies) => { if (live.current) setState({ status: "ready", agencies }); },
      () => { if (live.current) setState({ status: "failed", agencies: null }); },
    );
    return () => { live.current = false; };
  }, [loadAgencies, attempt]);
  const retryAgencies = useCallback(() => {
    setState({ status: "loading", agencies: null });
    setAttempt((value) => value + 1);
  }, []);

  // One request at a time; a failed load may be retried by opening again.
  const documentsRequested = useRef(false);
  const openDocuments = useCallback(() => {
    if (documentsRequested.current) return;
    documentsRequested.current = true;
    setDocuments({ status: "loading", file: null });
    loadDocuments().then(
      (file) => { if (live.current) setDocuments({ status: "ready", file }); },
      () => {
        documentsRequested.current = false;
        if (live.current) setDocuments({ status: "failed", file: null });
      },
    );
  }, [loadDocuments]);

  const agencies = state.agencies;
  const inputs = useMemo(() => recordsOf(agencies), [agencies]);
  const documentInputs = useMemo(() => recordsOf(agencies, documents.file), [agencies, documents.file]);
  const agencyName = useMemo(() => new Map((agencies?.agencies ?? []).map((agency) => [agency.id, agency.abbreviation || agency.name])), [agencies]);

  if (state.status === "loading") return <section className="rights-library" aria-busy="true"><p>{t("rightsLibrary.loading")}</p></section>;
  if (state.status === "failed") return <section className="rights-library"><p role="alert">{t("rightsLibrary.loadFailed")} <button type="button" className="xus-btn" onClick={retryAgencies}>{t("rightsLibrary.retry")}</button></p></section>;

  return (
    <section className="rights-library" aria-labelledby="rights-library-title">
      <header>
        <h2 id="rights-library-title">{t("rightsLibrary.title")}</h2>
        <p>{t("rightsLibrary.subtitle")}</p>
      </header>
      <div className="rights-library__disclaimer" role="note">
        <strong>{t("rightsLibrary.disclaimerTitle")}</strong>
        <p lang="en">{agencies.disclaimer}</p>
        {onAskSteward ? <button type="button" className="rights-library__steward" onClick={onAskSteward}>{t("rightsLibrary.askSteward")}</button> : null}
        {lang !== "en" ? <p lang={lang}>{t("rightsLibrary.englishOnly")}</p> : null}
      </div>

      {/* The content is English; the headings and labels around it follow the
          page language, so lang="en" sits on the content nodes only. */}
      <div>
        <h3>{t("rightsLibrary.situations")}</h3>
        <ul className="rights-library__situations">
          {agencies.scenarios.map((scenario) => (
            <li key={scenario.id}>
              <details>
                <summary lang="en">{scenario.title}</summary>
                <p lang="en">{scenario.summary}</p>
                <p className="rights-library__urgency" lang="en">{scenario.urgency_text}</p>
                {[scenario.primary_agency, ...scenario.also_see].filter((id) => agencyName.has(id)).map((id) => (
                  <a key={id} className="rights-library__jump" href={`#rights-agency-${id}`} onClick={() => openAgency(id)}>{t("rightsLibrary.openAgency", { agency: agencyName.get(id) })}</a>
                ))}
                <Sourced item={scenario} inputs={inputs} />
              </details>
            </li>
          ))}
        </ul>

        <h3>{t("rightsLibrary.concepts")}</h3>
        <ul className="rights-library__concepts">
          {agencies.concepts.map((concept) => (
            <li key={concept.id}>
              <details>
                <summary lang="en">{concept.name}</summary>
                <p lang="en">{concept.summary}</p>
                <Sourced item={concept} inputs={inputs} />
              </details>
            </li>
          ))}
        </ul>

        <h3>{t("rightsLibrary.agencies")}</h3>
        {agencies.agencies.map((agency) => <AgencyCard key={agency.id} agency={agency} documents={documents} onOpenDocuments={openDocuments} inputs={inputs} documentInputs={documentInputs} t={t} />)}
        {agencies.excluded.length ? <p className="rights-library__excluded">{t("rightsLibrary.excluded", { names: agencies.excluded.map((row) => row.name).join(", ") })}</p> : null}

        <FederalLaw loadIndex={loadFederalIndex} loadRegulations={loadRegulations} t={t} />

        <h3>{t("rightsLibrary.guides")}</h3>
        <DocumentsPanel summary={t("rightsLibrary.openGuides")} documents={documents} onOpen={openDocuments} t={t}>
          {(file) => file.documents.filter((document) => !document.agency_id)
            .map((document) => <DocumentItem key={document.id} document={document} inputs={documentInputs} t={t} />)}
        </DocumentsPanel>

      </div>
    </section>
  );
}
