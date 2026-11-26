export type CatalogRpcClient = {
  rpc(name: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
};
export type SourceLink = { href: string; host: string };
export type CatalogRow = {
  id: string; key: string; name: string; registryOnly: boolean;
  affiliation: string | null; designation: string | null; localNumber: string | null;
  level: string; city: string | null; state: string | null; website: SourceLink | null;
  membersLatest: number | null; membersYear: number | null; parentName: string | null;
};
export type PublishedCatalogProfile = {
  found: true;
  organization: { key: string | null; name: string | null; affiliation: string | null; designation: string | null;
    localNumber: string | null; level: string; city: string | null; state: string | null; website: SourceLink | null;
    membersLatest: number | null; membersYear: number | null; confidence: string | null; researchedOn: string | null };
  parents: { key: string; parentKey: string | null; parentName: string | null; parentLabel: string | null; certainty: string | null }[];
  children: { key: string; name: string | null; edgeKind: string | null; certainty: string | null }[];
  childrenTotal: number;
  subunits: { key: string; name: string | null; kind: string | null; kindLabel: string | null }[];
  seats: { key: string; title: string | null; seatClass: string | null; listed: number; vacant: number }[];
  contacts: { key: string; kind: string; value: string; link: SourceLink | null }[];
  /** 'members': the reader has no account, so no document carries a link. */
  documentLinks: 'members' | 'included';
  documents: { key: string; kind: string | null; title: string | null; link: SourceLink | null; asOf: string | null }[];
  coverage: { band: string | null; checklist: Record<string, boolean>; lastResearched: string | null } | null;
  sources: SourceLink[];
};
export type CatalogProfile = PublishedCatalogProfile | { found: false };
export declare const CATALOG_KEY_PATTERN: RegExp;
export declare function catalogSearchPlan(query: string, filters?: Record<string, unknown>, page?: number, catalog?: string): { source: string; query: string; args: Record<string, string | number | null> | null };
export declare function isMissingRpcError(error: unknown): boolean;
export declare function normalizeCatalogRow(row: unknown): CatalogRow | null;
export declare function normalizeCatalogProfile(data: unknown): CatalogProfile;
export declare function probeCatalogStatus(client: CatalogRpcClient): Promise<{ catalog: 'live' | 'fallback'; status: { dataAsOf: string | null; releasedOn: string | null; releaseLabel: string | null } | null }>;
export declare function searchCatalog(client: CatalogRpcClient, args: Record<string, unknown> | null): Promise<{ rows: CatalogRow[]; total: number; totalCapped: boolean; hasNext: boolean }>;
export declare function loadCatalogProfile(client: CatalogRpcClient, key: string): Promise<CatalogProfile>;
export declare function loadCatalogProfile<T>(client: CatalogRpcClient, key: string, normalize: (data: unknown) => T): Promise<T>;
export declare function searchCatalogKeys(client: CatalogRpcClient, query: string, options?: { catalogOnly?: boolean }): Promise<{ key: string; name: string; city: string | null; state: string | null }[]>;
export declare function dateOnly(value: unknown): string | null;
export declare function cleanCatalogQuery(value: unknown): string;
export declare function catalogPageCount(total: number): number;
export declare function formatCatalogDate(value: string, language: string): string;
