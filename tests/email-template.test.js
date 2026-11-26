// @vitest-environment node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CHROME, EYEBROW, renderEmail, renderText, settingsUrlFor } from "../api/_lib/emailTemplate.js";
import { TEMPLATES } from "../api/notifications-dispatch.js";
import { deskInvitationNames, invitationEmail, sendInvitationEmail, signInPasswordEmail } from "../api/_lib/memberInvitations.js";
import { NOTIFICATION_TOPIC_KEYS } from "../src/lib/memberApi.js";

// F1 — the mailer sent `text:` only, so 38 bilingual comps were art nobody
// received. This file guards the JOIN between the mailer and the shell, which
// is where every defect in the dropped-in version lived: each half read
// correctly on its own and the two did not agree about anything.

const APP_URL = "https://app.unionground.test/m";

describe("invitation identity and next steps", () => {
  afterEach(() => vi.unstubAllGlobals());

  for (const locale of ["en", "es"]) {
    for (const source of ["administrator", "scim", "founder"]) {
      it(`names the organization and truthful ${source} source in ${locale}`, () => {
        const mail = invitationEmail(locale, "https://app.unionground.test/app/invite#invite=secret", null, {
          organization: "Example Workers", inviter: "Alex Rivera", source,
        });
        expect(mail.subject).toContain("Example Workers");
        const attribution = locale === "es" ? {
          administrator: "Invitación enviada por Alex Rivera a través de Union Ground.",
          scim: "Esta invitación fue creada por el sistema de acceso de tu organización.",
          founder: "Union Ground te invita a configurar Example Workers como su primera persona administradora.",
        } : {
          administrator: "Invitation sent by Alex Rivera through Union Ground.",
          scim: "This invitation was created by your organization's sign-in system.",
          founder: "Union Ground is inviting you to set up Example Workers as its first administrator.",
        };
        const htmlText = mail.html.replaceAll("&#39;", "'");
        for (const body of [mail.text, htmlText]) {
          expect(body).toContain("Example Workers");
          expect(body).toContain(attribution[source]);
          expect(body).toContain(locale === "es" ? "se crea tu cuenta" : "creates your account");
          expect(body).toContain(locale === "es" ? "contraseña de acceso en otro correo" : "email your sign-in password separately");
          expect(body).toContain(locale === "es" ? "entra en el sitio web o en la app" : "sign in on the website or phone app");
          expect(body).toContain(locale === "es" ? "15 minutos" : "15 minutes");
          expect(body).toContain(locale === "es" ? "funciona una sola vez" : "works once");
          if (source !== "administrator") expect(body).not.toContain("Alex Rivera");
        }
        expect(mail.text).not.toMatch(/\{organization\}|\{inviter\}/);
      });
    }
  }

  it("escapes display names in HTML and keeps email addresses out of inviter attribution", () => {
    const mail = invitationEmail("en", "https://app.unionground.test/app/invite#invite=secret", null, {
      organization: 'Workers @ <North> & "West"', inviter: "admin@example.invalid", source: "administrator",
    });
    expect(mail.subject).toContain('Workers @ <North> & "West"');
    expect(mail.text).toContain('Workers @ <North> & "West"');
    expect(mail.html).toContain("Workers @ &lt;North&gt; &amp; &quot;West&quot;");
    expect(mail.html).not.toContain("<North>");
    for (const body of [mail.text, mail.html]) {
      expect(body).not.toContain("admin@example.invalid");
      expect(body).toContain("Invitation sent by an administrator through Union Ground.");
    }
  });

  it.each(["Example Workers", "Workers @ Home Union"])("reads trusted caller names for %s using the caller token", async (organization) => {
    const id = "11111111-1111-4111-8111-111111111111";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id }) })
      .mockResolvedValueOnce({ ok: true, json: async () => [{
        full_name: "Alex Rivera", chapters: { organizations: { name: organization } },
      }] });
    vi.stubGlobal("fetch", fetchMock);
    expect(await deskInvitationNames("https://project.supabase.co", "publishable", "caller-token"))
      .toEqual({ organization, inviter: "Alex Rivera", source: "administrator" });
    expect(fetchMock.mock.calls[0][0]).toBe("https://project.supabase.co/auth/v1/user");
    expect(fetchMock.mock.calls[1][0]).toBe(`https://project.supabase.co/rest/v1/member_profiles?select=full_name,chapters(organizations!chapters_organization_id_fkey(name))&id=eq.${id}&limit=1`);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.headers).toMatchObject({ apikey: "publishable", Authorization: "Bearer caller-token" });
    }
  });

  it("does not guess an organization when a caller-scoped name read fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({
      id: "11111111-1111-4111-8111-111111111111",
    }) }).mockResolvedValueOnce({ ok: true, json: async () => [{ full_name: "Alex" }] }));
    await expect(deskInvitationNames("https://project.supabase.co", "publishable", "caller-token"))
      .rejects.toThrow("invitation-names-unavailable");
  });

  it.each([null, {}, { id: "not-a-user-id" }])("stops before profile reads when Auth does not identify a caller: %j", async (user) => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => user });
    vi.stubGlobal("fetch", fetchMock);
    await expect(deskInvitationNames("https://project.supabase.co", "publishable", "caller-token"))
      .rejects.toThrow("invitation-names-unavailable");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://project.supabase.co/auth/v1/user");
  });

  it.each([null, {}, [], [{ full_name: "First" }, { full_name: "Second" }]])("refuses missing or ambiguous profile results: %j", async (rows) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "11111111-1111-4111-8111-111111111111" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => rows });
    vi.stubGlobal("fetch", fetchMock);
    await expect(deskInvitationNames("https://project.supabase.co", "publishable", "caller-token"))
      .rejects.toThrow("invitation-names-unavailable");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([url]) => String(url).startsWith("https://project.supabase.co/"))).toBe(true);
  });

  const serviceMail = {
    resendKey: "mail-key", from: "Union Ground <notify@example.invalid>", to: "invitee@example.invalid",
    locale: "en", link: "https://app.unionground.test/app/invite#invite=secret", invitationId: "invitation", deliveryVersion: 1,
    names: { source: "scim" },
    organizationLookup: {
      supabaseUrl: "https://project.supabase.co", serviceKey: "sb_secret_test",
      organizationId: "11111111-1111-4111-8111-111111111111",
    },
  };

  it.each([undefined, "not-an-organization-id"])("refuses an invalid service organization id before any read or mail: %j", async (organizationId) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(sendInvitationEmail({
      ...serviceMail, organizationLookup: { ...serviceMail.organizationLookup, organizationId },
    })).rejects.toThrow("invitation-names-unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([null, "", "   ", "Unsafe\nOrganization"])("does not send mail when the stored organization has no usable name: %j", async (name) => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [{ name }] });
    vi.stubGlobal("fetch", fetchMock);
    await expect(sendInvitationEmail(serviceMail)).rejects.toThrow("invitation-names-unavailable");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("/rest/v1/organizations?select=name&");
  });

  it.each(["Example Workers", "Workers @ Home Union"])("renders SCIM attribution for %s using its authenticated organization id", async (organization) => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => [{ name: organization }] })
      .mockResolvedValueOnce({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const organizationId = "11111111-1111-4111-8111-111111111111";
    expect(await sendInvitationEmail({
      resendKey: "mail-key", from: "Union Ground <notify@example.invalid>", to: "invitee@example.invalid",
      locale: "es", link: "https://app.unionground.test/app/invite#invite=secret", invitationId: "invitation", deliveryVersion: 1,
      names: { source: "scim" }, organizationLookup: { supabaseUrl: "https://project.supabase.co", serviceKey: "sb_secret_test", organizationId },
    })).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe(`https://project.supabase.co/rest/v1/organizations?select=name&id=eq.${organizationId}&limit=1`);
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ apikey: "sb_secret_test", "User-Agent": "UnionGround-Server/1.0" });
    const mail = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(mail.from).toBe("Union Ground <notify@example.invalid>");
    expect(mail.subject).toContain(organization);
    expect(mail.text).toContain(organization);
    expect(mail.html).toContain(organization);
    expect(mail.text).toContain("sistema de acceso de tu organización");
    expect(mail.text).not.toContain("sb_secret_test");
  });
});

describe("the shell agrees with the mailer", () => {
  it("keys its eyebrows on the mailer's own kinds", () => {
    // The defect that made this test necessary. The drop-in keyed on singular
    // names — deadline, case, form, vote, event — and the dispatcher passes
    // TEMPLATES' plural keys, so EVERY kind missed and fell through to the
    // `cases` default: a deadline notice went out headed "CASE UPDATE" and a
    // vote notice went out headed "CASE UPDATE". Nothing threw, nothing
    // logged, and the rendered mail looked plausible.
    expect(Object.keys(EYEBROW).sort()).toEqual(Object.keys(TEMPLATES).sort());
  });

  it("covers every persistable topic, because the caps burn before sendability is checked", () => {
    // Two incomplete maps agreeing with each other is how the tasks topic
    // shipped enqueueable but unsendable: the enqueue trigger inserts
    // delivery rows and increments the per-recipient and org rate caps
    // BEFORE dispatch consults these maps, so a topic missing here does not
    // stay silent — it burns the budget that protects real mail. The
    // canonical topic list is the third party both maps must answer to.
    expect(Object.keys(TEMPLATES).sort()).toEqual([...NOTIFICATION_TOPIC_KEYS].sort());
    expect(Object.keys(EYEBROW).sort()).toEqual([...NOTIFICATION_TOPIC_KEYS].sort());
  });

  it("documents the live mailer kind set, not a stale count", () => {
    // DEBT-UG-EMAILTEMPLATE-JS-HEADER-AND-JSDOC-STILL-SAY-FIVE-MAILER-TEMPLATES-BUT-THE-20260921:
    // the header said "five mailer templates" and the @param union listed five
    // kinds long after the mailer grew to nine.
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../api/_lib/emailTemplate.js"), "utf8");
    const union = source.match(/@param \{((?:"[a-z]+"\|?)+)\} o\.kind\b/);
    expect(union, "renderEmail JSDoc lost its o.kind union").not.toBeNull();
    const documented = [...union[1].matchAll(/"([a-z]+)"/g)].map((match) => match[1]);
    expect(documented.sort()).toEqual(Object.keys(TEMPLATES).sort());
    expect(source).not.toMatch(/\b(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+) mailer templates?\b/i);
  });

  it("gives every kind a distinct eyebrow in both locales", () => {
    // Set equality catches the fall-through in the other direction too: a map
    // whose values are all the default would satisfy the key check above.
    for (const locale of ["en", "es"]) {
      const eyebrows = Object.values(EYEBROW).map((entry) => entry[locale]);
      expect(eyebrows.every(Boolean), `missing ${locale} eyebrow`).toBe(true);
      expect(new Set(eyebrows).size, `${locale} eyebrows are not distinct`).toBe(eyebrows.length);
    }
  });

  it("carries no dues eyebrow, because Union Ground leaves dues out", () => {
    expect(EYEBROW).not.toHaveProperty("dues");
    expect(TEMPLATES).not.toHaveProperty("dues");
    expect([...NOTIFICATION_TOPIC_KEYS]).not.toContain("dues");
  });

  it("heads each kind with Union Ground's organizing words, never the existing-union ones", () => {
    expect(EYEBROW.cases).toEqual({ en: "ISSUE UPDATE", es: "NOVEDAD DEL ASUNTO" });
    expect(EYEBROW.events).toEqual({ en: "CAMPAIGN MEETING", es: "REUNIÓN DE LA CAMPAÑA" });
    expect(EYEBROW.appointments).toEqual({ en: "ONE-ON-ONE", es: "REUNIÓN INDIVIDUAL" });
    expect(EYEBROW.workload).toEqual({ en: "WORKPLACE LOG", es: "REGISTRO DEL CENTRO DE TRABAJO" });
    expect(EYEBROW.messages).toEqual({ en: "CAMPAIGN CHANNELS", es: "CANALES DE LA CAMPAÑA" });
    const english = JSON.stringify(Object.values(EYEBROW).map((entry) => entry.en));
    expect(english).not.toMatch(/CASE|CHAPTER|APPOINTMENT|WORKLOAD|GRIEVANCE|DUES/);
  });

  it("renders the right eyebrow for each kind", () => {
    // Against the renderer, not the table: a table pin says nothing about
    // whether renderEmail ever reads it.
    for (const [kind, entry] of Object.entries(EYEBROW)) {
      const html = renderEmail({ kind, lang: "en", subject: "S", body: "B", appUrl: APP_URL });
      expect(html, `${kind} rendered the wrong eyebrow`).toContain(`>${entry.en}<`);
    }
  });
});

describe("the links resolve", () => {
  it("does not double the member prefix", () => {
    // APP_URL already ends in /m. The drop-in appended `/m/settings`, so both
    // the footer link and the List-Unsubscribe header pointed at /m/m/settings
    // — a 404 on the one link a member follows when they want the mail to stop.
    expect(settingsUrlFor(APP_URL)).toBe("https://app.unionground.test/m/settings");
    expect(settingsUrlFor("https://app.unionground.test/m/")).toBe("https://app.unionground.test/m/settings");
    expect(renderEmail({ kind: "cases", lang: "en", subject: "S", body: "B", appUrl: APP_URL }))
      .not.toContain("/m/m/");
  });

  it("puts the logo at the site root, not under the member prefix", () => {
    // vercel.json serves /design outside the SPA catch-all; /m/design is the
    // app, which answers with the SPA shell rather than a PNG.
    const html = renderEmail({ kind: "cases", lang: "en", subject: "S", body: "B", appUrl: APP_URL });
    expect(html).toContain('src="https://app.unionground.test/design/email-logo.png"');
  });

  it("makes no third-party request from the member's inbox", () => {
    // The drop-in loaded Archivo from fonts.googleapis.com — a request fired by
    // the mail client on open, i.e. a read receipt for a third party on union
    // mail, in an app that self-hosts its fonts specifically to avoid that.
    const html = renderEmail({ kind: "cases", lang: "en", subject: "S", body: "B", appUrl: APP_URL });
    const hosts = [...new Set([...html.matchAll(/https?:\/\/([^/"'\s>]+)/g)].map(([, host]) => host))].sort();
    expect(hosts, "an outbound email must reference no host but our own").toEqual(["app.unionground.test"]);
  });
});

describe("the footer claims only what it can", () => {
  it("omits the postal line rather than inventing an address", () => {
    // A wrong street address in a bulk-mail footer is a claim about a real
    // organisation, printed under its name, that the organisation did not make.
    // The drop-in hardcoded one that appears nowhere else in this repo.
    const html = renderEmail({ kind: "cases", lang: "en", subject: "S", body: "B", appUrl: APP_URL });
    expect(html).not.toMatch(/\d+ [A-Z][a-z]+ (Ave|St|Street|Road|Rd)/);
    expect(renderText({ body: "B", appUrl: APP_URL, lang: "en" })).not.toMatch(/Boston, MA/);
  });

  it("renders the postal line when the deployment supplies one", () => {
    const address = "Harborview Care United · 123 Example Way, Somewhere, MA 00000";
    expect(renderEmail({ kind: "cases", lang: "en", subject: "S", body: "B", appUrl: APP_URL, address }))
      .toContain("123 Example Way");
    expect(renderText({ body: "B", appUrl: APP_URL, lang: "en", address })).toContain("123 Example Way");
  });
});

describe("bilingual chrome", () => {
  it("calls a campaign a campaña, never a capítulo or a sección", () => {
    // The locked glossary (src/lib/i18n.js), per the Bilingual design pass:
    // chapter → capítulo, «Not "sección"». An earlier sweep inverted the
    // ruling and this test enforced the inversion — in the one surface a
    // member cannot report a wording problem from, because it arrives in
    // their inbox already sent.
    const spanish = JSON.stringify([CHROME.es, ...Object.values(EYEBROW).map((e) => e.es)]);
    expect(spanish.toLowerCase()).not.toContain("sección");
    expect(spanish.toLowerCase()).not.toContain("seccion");
    expect(spanish.toLowerCase()).not.toContain("capítulo");
    expect(EYEBROW.events.es).toContain("CAMPAÑA");
  });

  it("names the product, never a specific organization, in the mail chrome", () => {
    for (const lang of ["en", "es"]) {
      expect(CHROME[lang].org).toBe("UNION GROUND");
      const html = renderEmail({ kind: "cases", lang, subject: "S", body: "B", appUrl: APP_URL });
      // The wordmark beside the logo is the product's own, never a retired name.
      expect(html).toContain(">UNION&nbsp;GROUND</td>");
      expect(html).not.toMatch(/PRE(?:&nbsp;|\s)?SOLID|UNION(?:&nbsp;|\s)BASE/i);
      expect(html).not.toMatch(/509|SEIU|Local 509/i);
      expect(renderText({ body: "B", appUrl: APP_URL, lang })).not.toMatch(/509|SEIU|Local 509/i);
    }
  });

  it("keeps default invitation and password copy free of hard-coded organization identities", () => {
    for (const lang of ["en", "es"]) {
      const invite = invitationEmail(lang, "https://app.unionground.test/invite#invite=x", "https://app.unionground.test");
      const password = signInPasswordEmail(lang, "p", "https://app.unionground.test");
      for (const part of [invite.subject, invite.text, invite.html, password.subject, password.text, password.html]) {
        expect(part).not.toMatch(/509|SEIU|Local 509/i);
      }
      expect(invite.html).toContain("UNION GROUND");
    }
  });

  it("ends the invitation and first-password emails with the website and phone links", () => {
    for (const lang of ["en", "es"]) {
      const invite = invitationEmail(lang, "https://app.unionground.test/invite#invite=x", "https://app.unionground.test");
      const password = signInPasswordEmail(lang, "p", "https://app.unionground.test");
      for (const mail of [invite, password]) {
        expect(mail.html).toContain('<img src="cid:union-ground-app-qr" width="132" height="132"');
        expect(mail.html).toContain('href="https://app.unionground.test/"');
        expect(mail.html).toContain('href="https://app.unionground.test/get-app"');
        expect(mail.text).toContain("https://app.unionground.test/get-app");
        // No phone app is downloadable yet (src/lib/appDownloads.js), so no
        // store link is offered.
        expect(mail.html).not.toMatch(/apple\.com|play\.google\.com/);
      }
      // The QR block never repeats the private invitation link.
      expect(invite.html.match(/invite#invite=/g)).toHaveLength(1);
    }
    // A password reissue sends no app origin and keeps the plain email.
    const reissue = signInPasswordEmail("en", "p");
    expect(reissue.html).not.toContain("cid:");
    expect(reissue.text).not.toContain("/get-app");
  });

  // REQ-UG-SELF-SERVICE-PASSWORD-RESET-20261006 (reissue half).
  it("says a reissued password replaces earlier ones and when it was sent, in Eastern time", () => {
    const sentAt = new Date("2026-10-06T22:58:10Z");
    const english = signInPasswordEmail("en", "p", undefined, { reissuedAt: sentAt });
    const line = /This password replaces any temporary password sent to you before\. Sent October 6, 2026(,| at) 6:58:10\.000\sPM EDT \(2026-10-06 22:58:10\.000 UTC\)\. If you have several of these emails, only the newest one works\./;
    expect(english.subject).toBe("Your new Union Ground sign-in password");
    expect(english.text).toMatch(line);
    expect(english.html).toMatch(line);
    const spanish = signInPasswordEmail("es", "p", undefined, { reissuedAt: new Date("2026-12-06T22:58:40Z") });
    expect(spanish.subject).toBe("Tu nueva contraseña de Union Ground");
    // ICU versions differ on the Spanish joiner (", " or " a las "), so read
    // the date and time rather than the exact punctuation between them.
    expect(spanish.text).toMatch(/Esta contraseña reemplaza cualquier contraseña temporal que te hayamos enviado antes\. Enviada el 6 de diciembre de 2026(,| a las) 5:58:40\.000\sp\.\s?m\. EST \(2026-12-06 22:58:40\.000 UTC\)\. Si tienes varios de estos correos, solo funciona el más reciente\./);
    // The first password after an invitation replaces nothing and says nothing of it.
    const first = signInPasswordEmail("en", "p", "https://app.unionground.test");
    expect(first.subject).toBe("Your Union Ground sign-in password");
    expect(first.text).not.toMatch(/replaces|newest/);
    // Two reissues in the same minute must not print the same time.
    const later = signInPasswordEmail("en", "p", undefined, { reissuedAt: new Date("2026-10-06T22:58:40Z") });
    expect(later.text).toMatch(/Sent October 6, 2026(,| at) 6:58:40\.000\sPM EDT \(2026-10-06 22:58:40\.000 UTC\)\./);
    expect(later.text).not.toBe(english.text);
  });

  it.each(["en", "es"])("distinguishes password reissues within one second in %s", (locale) => {
    const earlier = signInPasswordEmail(locale, "p", undefined, {
      reissuedAt: new Date("2026-10-06T22:58:10.100Z"),
    });
    const later = signInPasswordEmail(locale, "p", undefined, {
      reissuedAt: new Date("2026-10-06T22:58:10.400Z"),
    });
    for (const format of ["text", "html"]) {
      expect(earlier[format]).toContain("6:58:10.100");
      expect(later[format]).toContain("6:58:10.400");
      expect(later[format]).not.toBe(earlier[format]);
    }
  });

  // BUG-UG-REISSUE-SENT-TIME-FALLBACK-HOUR-20261008: on November 1,
  // 2026 the later reissue reads 1:30:10 AM EST and the earlier 1:30:50 AM
  // EDT; the UTC instant beside each lets a member put them in order.
  it.each([
    ["en", /Sent November 1, 2026(,| at) 1:30:50\.000\sAM EDT \(2026-11-01 05:30:50\.000 UTC\)\./,
      /Sent November 1, 2026(,| at) 1:30:10\.000\sAM EST \(2026-11-01 06:30:10\.000 UTC\)\./],
    ["es", /Enviada el 1 de noviembre de 2026(,| a las) 1:30:50\.000\sa\.\s?m\. EDT \(2026-11-01 05:30:50\.000 UTC\)\./,
      /Enviada el 1 de noviembre de 2026(,| a las) 1:30:10\.000\sa\.\s?m\. EST \(2026-11-01 06:30:10\.000 UTC\)\./],
  ])("orders reissues sent in the repeated fall-back hour in %s", (locale, firstLine, secondLine) => {
    const first = signInPasswordEmail(locale, "p", undefined, { reissuedAt: new Date("2026-11-01T05:30:50Z") });
    const second = signInPasswordEmail(locale, "p", undefined, { reissuedAt: new Date("2026-11-01T06:30:10Z") });
    const stamp = (email) => /\((\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}) UTC\)/.exec(email.text)[1];
    for (const format of ["text", "html"]) {
      expect(first[format]).toMatch(firstLine);
      expect(second[format]).toMatch(secondLine);
    }
    // The printed instants sort in the order the emails were sent.
    expect(stamp(first) < stamp(second)).toBe(true);
  });

  it("holds the glossary across every shipping surface, not just this chrome", () => {
    // Sol-review finding 2 on the capítulo sweep: the assertion above only
    // sees CHROME/EYEBROW, so an inverted string in the i18n catalogue or a
    // dispatcher subject would ship unnoticed. Scan the sources themselves,
    // comments stripped (the glossary comments legitimately NAME the banned
    // word). Seeded DB copy is pinned by migration
    // 20260731214500_notification_copy_capitulo.sql; design-source passes
    // are unserved historical handoffs and deliberately out of scope.
    // (Union on the gap-2 chain: #2125 adds clause.quickref.section, the
    // numbered SECTION of a contract article next to "Artículo", moved out of
    // ClauseQuickReference.jsx into this catalogue on 2026-09-17.)
    // Exact strings are allowlisted, never a key prefix or a loosened regex: a
    // chapter miscalled a "sección" still fails, because it would be a string
    // that is not on this list. Every entry uses the word in its
    // document-section sense, which the glossary explicitly permits —
    // hub.sections ("Organizing sections", an aria-label for the hub's tab
    // GROUPS), and the SAMPLE Voice studio's survey-section builder, whose
    // copy moved out of DemoVoiceStudio.jsx/DemoVoiceMember.jsx and into this
    // catalogue on 2026-09-17 (the locale-ternary repair) and so came under
    // this scan for the first time. None of them names an organisational unit.
    const allowed = [
      '"hub.sections": "Secciones de organización"',
      '"voiceDemo.addSection": "Agregar sección"',
      '"voiceDemo.instrumentSummary": "Instrumento de {count} preguntas · se muestran {sections} secciones de ejemplo"',
      '"voiceDemo.newSection": "Nueva sección"',
      '"voiceDemo.sectionN": "Sección {n}"',
      '"voiceDemo.sectionOf": "Sección {current} de {total}"',
      '"voiceDemo.sections": "secciones"',
      '"voiceDemo.voiceStudioSections": "Secciones del estudio de Voz"',
      '"clause.quickref.section": "Sección"',
      // The member engagement survey stepper, in the same document-section
      // sense the SAMPLE Voice studio's builder already uses
      // (UX-UG-MEMBER-ENGAGEMENT-CHROME-ENGLISH-ONLY-20260920).
      '"engagement.member.sectionsLabel": "Secciones de la encuesta"',
      '"engagement.member.sectionNumber": "Sección {number}"',
    ];
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    for (const path of ["src/lib/i18n.js", "api/_lib/emailTemplate.js", "api/notifications-dispatch.js"]) {
      let code = readFileSync(join(root, path), "utf8").replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const ok of allowed) code = code.replace(ok, "");
      expect(/secci[oó]n/i.test(code), `${path} says "sección" outside a comment or the allowlist`).toBe(false);
    }
  });

  it("falls back to English for an unknown locale rather than rendering blanks", () => {
    const html = renderEmail({ kind: "cases", lang: "fr", subject: "S", body: "B", appUrl: APP_URL });
    expect(html).toContain(CHROME.en.cta);
    expect(html).toContain('<html lang="en"');
  });

  it("renders the Spanish chrome for es", () => {
    const html = renderEmail({ kind: "events", lang: "es", subject: "S", body: "B", appUrl: APP_URL });
    expect(html).toContain(CHROME.es.cta);
    expect(html).toContain(CHROME.es.why);
    expect(html).toContain('<html lang="es"');
  });
});

describe("the renderer escapes what it interpolates", () => {
  it("escapes the subject and body", () => {
    // Both are repo constants today. They will not always be: the moment a
    // notification carries a case reference or a form name, an unescaped
    // renderer becomes an injection point into the member's mail client.
    const html = renderEmail({
      kind: "cases",
      lang: "en",
      subject: '<script>alert("x")</script>',
      body: "a & b < c",
      appUrl: APP_URL,
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("a &amp; b &lt; c");
  });
});

describe("text and html cannot disagree about the message", () => {
  it("keeps the mailer's own paragraph as the body of both", () => {
    const { body } = TEMPLATES.deadlines.en;
    const html = renderEmail({ kind: "deadlines", lang: "en", subject: "S", body, appUrl: APP_URL });
    const text = renderText({ body, appUrl: APP_URL, lang: "en" });
    expect(html).toContain(body);
    expect(text.startsWith(body)).toBe(true);
  });
});

// BUG-UG-PASSWORD-EMAIL-LABEL-RUNS-INTO-SECRET-20261003: read as
// text, the label and the password used to run together
// ("Temporary password2xOrs..."), so the secret was easy to copy wrong.
describe("password email label and secret", () => {
  // A plainly fake value: a real one would look like a leaked key to the secret scan.
  const SECRET = "aaaa-bbbb-cccc-dddd-eeee";
  it.each([["en", "Temporary password"], ["es", "Contraseña temporal"]])("keeps the %s label apart from the password", (lang, label) => {
    const email = signInPasswordEmail(lang, SECRET, "https://app.unionground.test");
    expect(email.html).toContain(`>${SECRET}</p>`);
    expect(email.html).not.toMatch(new RegExp(`${label}</span>${SECRET}`));
    const asText = email.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(asText).toContain(`${label}: ${SECRET}`);
    expect(email.text).toContain(`${label}: ${SECRET}`);
  });
});
