import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { LEGAL_DOCUMENTS, LEGAL_PAGE_KEYS, LEGAL_SITE_ORIGIN, legalDocument, legalPlainText, legalSiteUrl } from './legalDocuments';

// Union Ground has no published website, legal entity statement, or
// support mailbox yet. The in-app reader must therefore describe this build
// honestly and must never borrow a sibling product's identity or addresses.
// When Union Ground publishes its own instruments, pin the reader to them
// here the way Union Ground pins its reader to its web catalogue.

const allText = (key: (typeof LEGAL_PAGE_KEYS)[number]) => legalPlainText(LEGAL_DOCUMENTS[key]);

// The sibling product's names and account identifiers are listed only as
// digests (config/sample-backend.json, scripts/lib/denied-identity.mjs).
const deniedTokenDigests = new Set((JSON.parse(
  readFileSync(new URL('../../../../config/sample-backend.json', import.meta.url), 'utf8'),
) as { forbiddenIdentityTokenSha256: string[] }).forbiddenIdentityTokenSha256);
const deniedIdentityTokensIn = (text: string) => (text.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? [])
  .flatMap((token) => [token, ...token.split('-')])
  .filter((token) => deniedTokenDigests.has(createHash('sha256').update(`union-ground/deny-list/v1:${token}`).digest('hex')));

describe('native legal reader', () => {
  it('keeps every legal route the app links to', () => {
    expect(LEGAL_PAGE_KEYS).toEqual(['privacy', 'terms', 'accessibility', 'accessibility-statement', 'about', 'ai-disclosure', 'retention']);
    for (const key of LEGAL_PAGE_KEYS) {
      expect(legalDocument(key)?.key).toBe(key);
      expect(LEGAL_DOCUMENTS[key].sections.length).toBeGreaterThan(0);
    }
    expect(legalDocument('dues')).toBeNull();
  });

  it('names no sibling product, company, site, or mailbox', () => {
    for (const key of LEGAL_PAGE_KEYS) {
      const text = allText(key);
      expect(text, key).not.toMatch(/unionground\.net|sibling|@/i);
      expect(deniedIdentityTokensIn(text), key).toEqual([]);
      expect(LEGAL_DOCUMENTS[key].contactEmail, key).toBe('');
      expect(LEGAL_DOCUMENTS[key].instrument ?? null, key).toBeNull();
      expect(text.startsWith('Union Ground · '), key).toBe(true);
    }
  });

  it('opens no website until Union Ground publishes one', () => {
    expect(LEGAL_SITE_ORIGIN).toBeNull();
    for (const key of LEGAL_PAGE_KEYS) expect(legalSiteUrl(LEGAL_DOCUMENTS[key])).toBeNull();
  });

  it('states what the preview does and does not do', () => {
    const privacy = allText('privacy');
    expect(privacy).toContain('fictional people and records');
    expect(privacy).toContain('Nothing you enter is sent to a Union Ground server.');
    expect(privacy).toContain('does not register for remote push notifications');
    expect(allText('ai-disclosure')).toContain('not live AI');
    expect(allText('terms')).toContain('A card majority shown in the app is not certification or recognition.');
    for (const key of LEGAL_PAGE_KEYS) {
      expect(LEGAL_DOCUMENTS[key].notice, key).toContain('formal policies are not published yet');
    }
  });

  // The About page states that
  // Union Ground stands alone instead of naming another product.
  it('describes Union Ground as a separate product without naming another one', () => {
    const about = LEGAL_DOCUMENTS.about.sections.find((section) => section.heading === 'A separate product');
    expect(about?.body).toBe('Union Ground is built for workers forming a union. It shares no members, data, hosting or sign-in with any other product.');
    expect(LEGAL_DOCUMENTS.about.sections.map((section) => section.heading)).not.toContain('A sibling of Union Ground');
    expect(LEGAL_DOCUMENTS.about.notice).toContain('Content last reviewed: 2026-10-15.');
  });

  it('keeps existing-union concepts out of the reader', () => {
    for (const key of LEGAL_PAGE_KEYS) {
      expect(allText(key), key).not.toMatch(/\b(steward|grievance|chapter|dues|Weingarten)\b/i);
    }
  });
});
