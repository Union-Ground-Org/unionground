// @vitest-environment node
// All identities, organizations, domains and observations in this fixture are fictional.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildCatalogRelease, buildOrganizationPrefill, documentKey, nameTokens, parseExclusionList, personNameVariants } from "../scripts/union-catalog/privacy-filter.mjs";
import { baseFixture, filterOptions, LOCAL_ID, OLMS_KEY, TEST_SALT } from "./helpers/union-catalog-fixture.mjs";

const digest = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const record = (f) => f.enriched[LOCAL_ID];
const schema = "catalog-short-name-evidence/1";
const transliterations = [
  ["ø", "Ø", "o"], ["ł", "Ł", "l"], ["đ", "Đ", "d"], ["æ", "Æ", "ae"],
  ["œ", "Œ", "oe"], ["ß", "ẞ", "ss"], ["þ", "Þ", "th"], ["ð", "Ð", "d"],
].flatMap(([lower, upper, plain]) => [[lower, plain], [upper, plain]]);
const digraphs = [
  ["ö", "oe", "o"], ["ä", "ae", "a"], ["ü", "ue", "u"], ["ø", "oe", "o"],
  ["å", "aa", "a"], ["æ", "ae", "ae"], ["œ", "oe", "oe"],
].flatMap(([letter, digraph, single]) => [[letter, digraph, single], [letter.toUpperCase(), digraph, single]]);

it.each(transliterations)("adds the undecomposed letter %s as a person-name reading (ledger 563)", (letter, plain) => {
  expect(personNameVariants(`Avery Q${letter}ll`)).toContain(`avery q${plain}ll`);
});

it.each([
  ["Avery Quill", ["avery", "quill"]],
  ["Ávery Peña", ["avery", "pena"]],
  ["Avery O’Quill-Moss", ["avery", "oquill", "moss"]],
  ["Ａｖｅｒｙ Ｑｕｉｌｌ", ["avery", "quill"]],
  ["A\u200bvery Quill", ["avery", "quill"]],
  ["李 文", []],
])("keeps canonical name tokens unchanged for %s without the added letters", (name, expected) => {
  expect(nameTokens(name)).toEqual(expected);
});
it("requires a new source review before changing the committed verdicts", () => {
  const bytes = readFileSync(new URL("../config/catalog-short-name-evidence.json", import.meta.url));
  expect(digest(bytes), "Catalog verdicts changed: a new source review is required before updating this pin.")
    .toBe("sha256:61877ebc0a012ee3af2e5ea11a79224db7906a36dd83f28cee07b25cc8dace25");
});
const evidence = (f, path, value, classification = "organization") => ({
  schema,
  entries: [{
    record_id: LOCAL_ID,
    catalog_key: OLMS_KEY.local,
    record_digest: digest(JSON.stringify(record(f))),
    value_digest: digest(value),
    paths: [path],
    classification,
    capture: { path: "fixture/captured-page.json", pointer: "/organization/contact", digest: digest("fictional captured observation") },
    observation: "Reviewed captured organization contact, separate from the listed officer's own contact.",
  }],
});
const socialPath = (value) => {
  const suffix = createHash("sha256").update(`social|${value.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase()}`).digest("hex").slice(0, 12);
  return `contacts.${OLMS_KEY.local}~social-${suffix}.value`;
};

describe.each(["release", "prefill"])("short-name provenance: %s", (mode) => {
  const build = (f, shortNameEvidence = { schema, entries: [] }) => {
    const options = filterOptions(f, { shortNameEvidence });
    const result = mode === "release" ? buildCatalogRelease(options) : buildOrganizationPrefill(LOCAL_ID, options);
    return { ...result, data: result.release ?? result };
  };
  const fixture = (name = "Avery Quill Fixtureperson") => {
    const f = baseFixture();
    record(f).leaders[0].name = name;
    return f;
  };

  describe.each(["plain", "hyphenated", "upper-case", "possessive", "URL"])("unchanged Main hash in %s text", (form) => {
    it.each([
      ["Avery Qøll", "avery q ll"], ["Avery Qłll", "avery q ll"],
      ["Avery Qđll", "avery q ll"], ["Avery Qæll", "avery q ll"],
      ["Avery Qœll", "avery q ll"], ["Avery Qßll", "avery q ll"],
      ["Avery Qþll", "avery q ll"], ["Avery Qðll", "avery q ll"],
      ["Søren Þorn", "s ren orn"],
    ])("holds %s using the literal canonical hash %s", (name, canonical) => {
      const f = baseFixture();
      const written = form === "hyphenated" ? name.replaceAll(" ", "-")
        : form === "upper-case" ? name.replaceAll("ß", "ẞ").toUpperCase()
          : form === "possessive" ? `${name}'s`
            : form === "URL" ? `https://social.example/${encodeURIComponent(name.replaceAll(" ", "-"))}` : name;
      record(f).structureNote = written;
      const hash = createHash("sha256").update(`${TEST_SALT}\u0000${canonical}`).digest("hex");
      const options = filterOptions(f, { exclusions: parseExclusionList({ schema: "catalog-exclusions/1", salt: TEST_SALT, hashes: [hash] }) });
      const result = mode === "release" ? buildCatalogRelease(options) : buildOrganizationPrefill(LOCAL_ID, options);
      const data = result.release ?? result;
      expect(data.organizations.find((row) => row.catalog_key === OLMS_KEY.local).structure_note).toBeNull();
    });
  });

  describe.each(["joined", "reversed"])("original-letter and ASCII %s handles (#9295)", (order) => {
    const spellings = transliterations.flatMap(([letter, ascii]) => [
      [letter, letter], [letter, ascii], ...(letter.toLowerCase() === "ø" ? [[letter, "oe"]] : []),
    ]);
    it.each(spellings)("withholds listed %s written %s", (letter, written) => {
      const f = fixture(`Avery Q${letter}ll`);
      const handle = order === "joined" ? `averyq${written}ll` : `q${written}llavery`;
      const value = new URL(`https://social.example/${handle}`).href;
      record(f).social = [value];
      expect(build(f).data.contacts.some((contact) => contact.value === value)).toBe(false);
    });
  });

  it("preserves an unrelated organization social handle", () => {
    const f = fixture("Avery Qæll");
    const value = "https://social.example/organizationdesk";
    record(f).social = [value];
    expect(build(f).data.contacts.some((contact) => contact.value === value)).toBe(true);
  });

  const textSurface = (f, surface, value) => {
    if (surface === "note") {
      record(f).structureNote = value;
      return { path: "organizations.structure_note", present: (data) => data.organizations.some((o) => o.structure_note === value) };
    }
    if (surface === "title") {
      f.documents[0].title = value;
      return { path: `documents.${documentKey(OLMS_KEY.local, f.documents[0].url)}.title`, present: (data) => data.documents.some((d) => d.title === value) };
    }
    record(f).offices[0].address = value;
    const suffix = createHash("sha256").update(`office_address|${value.toLowerCase()}`).digest("hex").slice(0, 12);
    return { path: `contacts.${OLMS_KEY.local}~office_address-${suffix}.value`, present: (data) => data.contacts.some((c) => c.value === value) };
  };

  describe.each(["note", "title", "address"])("undecomposed-letter %s", (surface) => {
    describe.each(["given-first", "surname-first"])("%s", (order) => {
      describe.each(["", " Fixtureperson"])("listed suffix %j", (suffix) => {
        it.each(transliterations)("withholds %s written as %s (ledger 563)", (letter, plain) => {
          const f = fixture(`Avery Q${letter}ll${suffix}`);
          const value = order === "given-first" ? `Avery Q${plain}ll` : `Q${plain}ll, Avery`;
          const { present } = textSurface(f, surface, value);
          expect(present(build(f).data)).toBe(false);
        });
      });
    });
  });

  describe.each(["note", "title", "address"])("listed digraph alternate %s", (surface) => {
    describe.each(["given-first", "surname-first"])("%s", (order) => {
      describe.each(["", " Fixtureperson"])("listed suffix %j", (suffix) => {
        it.each(digraphs)("matches both spellings of listed %s (digraph %s)", (letter, digraph, single) => {
          const f = fixture(`Avery Q${letter}ll${suffix}`);
          for (const spelling of new Set([single, digraph])) {
            const value = order === "given-first" ? `Avery Q${spelling}ll` : `Q${spelling}ll, Avery`;
            const { present } = textSurface(f, surface, value);
            expect(present(build(f).data)).toBe(false);
          }
        });
      });
      it.each([["oe", "o"], ["ae", "a"], ["ue", "u"], ["aa", "a"]])(
        "does not unfold text %s to %s for a listed ASCII name", (listed, written) => {
          const f = fixture(`Avery Q${listed}ll Fixtureperson`);
          const value = order === "given-first" ? `Avery Q${written}ll` : `Q${written}ll, Avery`;
          const { present } = textSurface(f, surface, value);
          expect(present(build(f).data)).toBe(true);
        },
      );
    });
  });

  describe.each(["note", "title", "address"])("surname-first %s", (surface) => {
    it.each([
      ["Avery Quill", "Quill, Avery"],
      ["Avery Quill", "Quill Avery"],
      ["Avery Quill Fixtureperson", "Quill, Avery"],
      ["Avery Quill Fixtureperson", "Quill Avery"],
      ["Avery Quill Fixtureperson", "Fixtureperson, Avery"],
      ["Avery Quill Fixtureperson", "Fixtureperson Avery"],
      ["Avery Quill Fixtureperson", "Quill Fixtureperson, Avery"],
      ["Avery Quill Fixtureperson", "Minutes prepared by Quill, Avery for the chapter."],
      ["Avery Quill Fixtureperson", "Quill, Avery’s office"],
      ["Avery Quill Fixtureperson", "QUILL,\u00a0A\u200bVERY"],
      ["Quill Fixtureperson, Avery", "Quill, Avery"],
      ["Avery de la Quill Moss Fixtureperson", "Quill, Avery"],
      ["Ávery Peña Fixtureperson", "Pena, Avery"],
      ["Avery O'Quill Fixtureperson", "O’Quill, Avery"],
      ["Avery Quill Fixtureperson", "Quіll, Avery"],
      ["李 文", "文 李"],
    ])("withholds %s written %s without source attribution", (name, value) => {
      const f = fixture(name);
      const { present } = textSurface(f, surface, value);
      expect(present(build(f).data)).toBe(false);
    });

    it.each(["organization", "office_role"])("preserves reviewed %s attribution and holds person or unknown", (classification) => {
      const f = fixture("Grant Hall");
      const value = "Hall, Grant";
      const { path, present } = textSurface(f, surface, value);
      expect(present(build(f).data)).toBe(false);
      const proof = evidence(f, path, value, classification);
      expect(present(build(f, proof).data)).toBe(true);
      for (const rejected of ["person", "unknown"]) {
        proof.entries[0].classification = rejected;
        expect(present(build(f, proof).data)).toBe(false);
      }
    });

    it.each(["Quillish, Avery", "Quill, Averyton", "Quill office serves Avery"])("preserves noncandidate text %s", (value) => {
      const f = fixture();
      const { present } = textSurface(f, surface, value);
      expect(present(build(f).data)).toBe(true);
    });
  });

  it("holds a surname-first document title together with its dependent links", () => {
    const f = fixture("Avery Quill");
    const value = "Quill, Avery";
    const { path, present } = textSurface(f, "title", value);
    const key = documentKey(OLMS_KEY.local, f.documents[0].url);
    const reviewed = build(f, evidence(f, path, value));
    expect(reviewed.data.document_subunits.some((link) => link.document_key === key)).toBe(true);
    const held = build(f);
    expect(present(held.data)).toBe(false);
    expect(held.data.document_subunits.some((link) => link.document_key === key)).toBe(false);
    expect(held.dropReport["short_name.held.documents:unknown"]).toBe(1);
    expect(held.dropReport["short_name.held.document_subunits:unknown"]).toBe(1);
  });

  it.each(["note", "title", "url", "handle"])("withholds the missing first-surname %s without an observation", (surface) => {
    const f = fixture();
    const value = surface === "url" ? "https://exampleworkers1.example/files/avery-quill-letter.pdf"
      : surface === "handle" ? "https://social.example/averyquill" : "Avery Quill report";
    if (surface === "note") record(f).structureNote = value;
    if (surface === "title") f.documents[1].title = value;
    if (surface === "url") f.documents[2].url = value;
    if (surface === "handle") record(f).social = [value];
    const { data } = build(f);
    if (surface === "note") expect(data.organizations.find((o) => o.catalog_key === OLMS_KEY.local).structure_note).toBeNull();
    if (surface === "title") expect(data.documents.some((d) => d.title === value)).toBe(false);
    if (surface === "url") expect(data.documents.some((d) => d.url === value)).toBe(false);
    if (surface === "handle") expect(data.contacts.some((c) => c.value === value)).toBe(false);
  });

  it("withholds a short name when the listed person has six name tokens", () => {
    const f = fixture("Avery de la Quill Moss Fixtureperson");
    record(f).structureNote = "Minutes prepared by Avery Quill for the unit.";
    expect(build(f).data.organizations.find((o) => o.catalog_key === OLMS_KEY.local).structure_note).toBeNull();
  });

  it.each([
    ["Grant Hall Fixtureperson", "https://social.example/granthall"],
    ["Will Power Fixtureperson", "https://social.example/willpower"],
    ["Avery Peña Fixtureperson", "https://social.example/averypena"],
    ["Ávery Peña Fixtureperson", "https://social.example/averype%C3%B1a"],
    ["Huma Nal Fixtureperson", "https://social.example/humanal"],
    ["Avery Quill Fixtureperson", "https://social.example/avery__quill"],
    ["Avery Quill Fixtureperson", "https://social.example/avery..quill"],
    ["Avery Quill Fixtureperson", "https://social.example/avery-_-quill"],
    ["Avery Quill Fixtureperson", "https://social.example/avery%20quill%20%E6%9D%8E"],
    ["Avery Quill Fixtureperson", "https://social.example/avery%20quill%20%F0%9F%9A%A9"],
    ["May Day Fixtureperson", "https://social.example/mayday7"],
    ["May Day Fixtureperson", "https://social.example/mayday"],
    ["May Day Fixtureperson", "https://social.example/maydayworkers"],
    ["Avery al-Fixtureperson", "https://social.example/averyalliance"],
    ["Huma Nal Fixtureperson", "https://social.example/humanalliance"],
    ["Grant Hall Fixtureperson", "https://social.example/grant.hall"],
    ["Mary Jane Fixtureperson", "https://social.example/maryjane"],
    ["李 文 Fixtureperson", "https://social.example/%E6%9D%8E%E6%96%87"],
  ])("retains a reviewed public handle for %s", (name, value) => {
    const f = fixture(name);
    record(f).social = [value];
    const approved = evidence(f, socialPath(value), value);
    expect(build(f, approved).data.contacts.some((c) => c.value === value)).toBe(true);
    expect(build(f).data.contacts.some((c) => c.value === value)).toBe(false);
    approved.entries[0].classification = "person";
    expect(build(f, approved).data.contacts.some((c) => c.value === value)).toBe(false);
  });

  it.each([
    ["A. North Fixtureperson", "A north-facing office serves the chapter."],
    ["Hope May Fixtureperson", "We hope May brings new office hours."],
    ["Avery bin Fixtureperson", "The Avery bin handles recycling at the union hall."],
    ["May Day Fixtureperson", "May Day events bring members together each spring."],
    ["Will Call Fixtureperson", "Will Call tickets are available at the chapter office."],
    ["Grant Hall Fixtureperson", "Grant Hall hosts chapter meetings each month."],
    ["Avery Peña Fixtureperson", "The Avery Peña Bridge connects the chapter offices."],
    ["Mary Jane Fixtureperson", "The Mary Jane Historical Hall hosts public meetings."],
  ])("preserves reviewed organization prose independently of %s", (name, value) => {
    const f = fixture(name);
    record(f).structureNote = value;
    expect(build(f, evidence(f, "organizations.structure_note", value)).data.organizations.find((o) => o.catalog_key === OLMS_KEY.local).structure_note).toBe(value);
    expect(build(f).data.organizations.find((o) => o.catalog_key === OLMS_KEY.local).structure_note).toBeNull();
  });

  it.each([
    ["Grant Hall Fixtureperson", "Grant Hall"],
    ["Will Power Fixtureperson", "Will Power"],
    ["Avery Peña Fixtureperson", "Ávery Peña"],
    ["李 文 Fixtureperson", "李 文"],
  ])("holds a building address without evidence for %s and accepts reviewed office attribution", (name, address) => {
    const f = fixture(name);
    record(f).offices[0].address = address;
    const baseline = build(baseFixture()).data.contacts.find((c) => c.contact_kind === "office_address");
    const suffix = createHash("sha256").update(`office_address|${address.toLowerCase()}`).digest("hex").slice(0, 12);
    const path = `contacts.${OLMS_KEY.local}~office_address-${suffix}.value`;
    expect(baseline).toBeDefined();
    expect(build(f).data.contacts.some((c) => c.value === address)).toBe(false);
    expect(build(f, evidence(f, path, address, "office_role")).data.contacts.some((c) => c.value === address)).toBe(true);
  });

  it.each([
    ["Avery Quill Fixtureperson", "Avery Quill Tenants Union", "https://social.example/averyquill"],
    ["Ávery Peña Fixtureperson", "Ávery Peña Workers Local", "https://social.example/averype%C3%B1a"],
    ["李 文 Fixtureperson", "李 文 Workers Local", "https://social.example/%E6%9D%8E%E6%96%87"],
  ])("requires evidence even when the organization name resembles %s", (name, organization, value) => {
    const f = fixture(name);
    record(f).name = organization;
    record(f).social = [value];
    expect(build(f).data.contacts.some((c) => c.value === value)).toBe(false);
    expect(build(f, evidence(f, socialPath(value), value)).data.contacts.some((c) => c.value === value)).toBe(true);
  });

  it.each(["record", "organization", "path", "value", "capture", "observation", "classification", "duplicate"])("fails closed on a mismatched or incomplete %s", (fault) => {
    const f = fixture();
    const value = "https://social.example/averyquill";
    record(f).social = [value];
    const proof = evidence(f, socialPath(value), value);
    if (fault === "record") proof.entries[0].record_digest = digest("another record");
    if (fault === "organization") proof.entries[0].catalog_key = OLMS_KEY.national;
    if (fault === "path") proof.entries[0].paths = ["organizations.structure_note"];
    if (fault === "value") proof.entries[0].value_digest = digest("another value");
    if (fault === "capture") delete proof.entries[0].capture;
    if (fault === "observation") proof.entries[0].observation = "";
    if (fault === "classification") proof.entries[0].classification = "unknown";
    if (fault === "duplicate") proof.entries.push({ ...proof.entries[0], classification: "person" });
    expect(build(f, proof).data.contacts.some((c) => c.value === value)).toBe(false);
  });

  it("holds dependent rows with an unknown required source and preserves the unrelated rows", () => {
    const f = fixture();
    const source = "https://exampleworkers1.example/avery-quill";
    record(f).subunits[0].source = source;
    const out = build(f);
    expect(out.data.subunits.some((s) => s.name === "Northside Chapter")).toBe(false);
    expect(out.data.subunits.some((s) => s.name === "Retirees")).toBe(true);
    expect(out.data.documents.some((d) => d.url.endsWith("northside-agreement.pdf"))).toBe(true);
    expect(out.dropReport["short_name.held.subunits:unknown"]).toBe(1);
    expect(out.dropReport["short_name.held.seat_outlines:unknown"]).toBe(3);
    expect(out.dropReport["short_name.held.document_subunits:unknown"]).toBe(2);
    if (mode === "prefill") {
      expect(out.subunitContacts).toEqual([]);
      expect(out.staffNotes.some((n) => n.subunitKey !== null)).toBe(false);
    }
  });

  it("keeps the pre-existing full-name veto even with a reviewed organization assertion", () => {
    const f = fixture("Avery Quill");
    const value = "https://social.example/averyquill";
    record(f).social = [value];
    expect(build(f, evidence(f, socialPath(value), value)).data.contacts.some((c) => c.value === value)).toBe(false);
  });

  it("holds a person-attributed document URL together with its links", () => {
    const f = fixture();
    const value = "https://exampleworkers1.example/averyquill.pdf";
    f.documents[0].url = value;
    const key = documentKey(OLMS_KEY.local, value);
    const out = build(f, evidence(f, `documents.${key}.url`, value, "person"));
    expect(out.data.documents.some((d) => d.document_key === key)).toBe(false);
    expect(out.data.document_subunits.some((l) => l.document_key === key)).toBe(false);
    expect(out.dropReport["short_name.held.documents:person"]).toBe(1);
  });

  it("holds a rejected seat's own-site prefill attachment with its title", () => {
    const f = fixture();
    const title = "Avery Quill representative";
    record(f).leaders[0].title = title;
    const out = build(f);
    expect(out.data.seat_outlines.some((seat) => seat.title === title)).toBe(false);
    if (mode === "prefill") {
      expect(out.staffNotes.some((note) => note.title === title)).toBe(false);
      expect(out.dropReport["short_name.held.prefill_staff_notes:unknown"]).toBe(1);
    }
  });
});
