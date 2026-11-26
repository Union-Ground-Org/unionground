// Pure chapter-lifecycle shaping for the native Partners workspace. The
// service layer owns transport; every decision that can be stated without a
// network call lives here so it can be proven without one.
import { registrySearchPlan } from '../../../../src/features/unionCatalog/registryQuery.js';
export { unionOrganizationSearchPattern } from '../../../../src/features/unionCatalog/registryQuery.js';

export type MobileChapterBindingStatus = 'requested' | 'verified' | 'rejected';

export type MobileChapterBinding = {
  chapterID: string;
  unionOrgID: string;
  organizationName: string;
  status: MobileChapterBindingStatus;
  publicNote: string;
};

export type MobileUnionOrganization = {
  id: string;
  name: string;
  location: string;
  affiliation: string;
};

export type MobileHandshakeDocument = {
  id: string;
  title: string;
  documentType: string;
  updatedAt: string;
};

const BINDING_STATUSES: MobileChapterBindingStatus[] = ['requested', 'verified', 'rejected'];

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function firstEmbedded(value: unknown): Record<string, unknown> | null {
  const row = Array.isArray(value) ? (value as unknown[])[0] : value;
  return row && typeof row === 'object' ? row as Record<string, unknown> : null;
}

// A binding row is only honest when its chapter, organization and status are
// all present. Anything else is reported as "no binding", never as a guess.
export function normalizeChapterBinding(row: unknown): MobileChapterBinding | null {
  if (!row || typeof row !== 'object') return null;
  const record = row as Record<string, unknown>;
  const status = text(record.status) as MobileChapterBindingStatus;
  const chapterID = text(record.chapter_id);
  const unionOrgID = text(record.union_org_id);
  if (!chapterID || !unionOrgID || !BINDING_STATUSES.includes(status)) return null;
  const organization = firstEmbedded(record.union_orgs);
  return {
    chapterID,
    unionOrgID,
    organizationName: text(organization?.name) || unionOrgID,
    status,
    publicNote: text(record.public_note),
  };
}

export function normalizeUnionOrganizations(rows: unknown): MobileUnionOrganization[] {
  return (Array.isArray(rows) ? rows as unknown[] : []).flatMap((value) => {
    const row = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
    if (!text(row.id) || !text(row.name)) return [];
    const local = text(row.local_number);
    const designation = text(row.designation) || 'Local';
    const name = text(row.name);
    const localLabel = local ? `${designation} ${local}` : '';
    return [{
      id: text(row.id),
      name: localLabel && !name.toLowerCase().includes(localLabel.toLowerCase()) ? `${name} · ${localLabel}` : name,
      location: [text(row.city), text(row.state)].filter(Boolean).join(', '),
      affiliation: text(row.affiliation),
    }];
  });
}

export function normalizeHandshakeDocuments(rows: unknown): MobileHandshakeDocument[] {
  return (Array.isArray(rows) ? rows as unknown[] : []).flatMap((value) => {
    const row = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
    if (!text(row.id) || !text(row.title) || !text(row.updated_at)) return [];
    return [{
      id: text(row.id),
      title: text(row.title),
      documentType: text(row.document_type),
      updatedAt: text(row.updated_at),
    }];
  });
}

// Numeric local queries (including Local 1) and city/affiliation/name searches
// share the public catalog's plan without importing its browser transport.
export function unionOrganizationSearchable(query: string): boolean {
  return registrySearchPlan(query).searchable;
}

export function bindingPillState(status: MobileChapterBindingStatus): 'done' | 'attention' | 'queued' {
  if (status === 'verified') return 'done';
  if (status === 'rejected') return 'attention';
  return 'queued';
}

// Only an active, explicitly docs-only handshake may carry a document, and a
// document must actually be chosen. The RPC enforces the same rule; the screen
// must not offer an action the server will refuse.
export function canShareHandshakeDocument(
  item: { status: string; dataScope: string },
  documentID: string,
): boolean {
  return item.status === 'active' && item.dataScope === 'docs_only' && documentID !== '';
}

// After a refresh, keep the reader's chosen document when it still exists;
// otherwise fall back to the newest one rather than leaving a stale identity.
export function retainedDocumentSelection(documents: MobileHandshakeDocument[], current: string): string {
  return documents.some((document) => document.id === current) ? current : documents[0]?.id ?? '';
}
