import type { SourceLink } from './catalogSearch.js';
export { buildRegistryQuery, parseRegistryQuery, quotedFilterValue, normalizeRegistryFilters, registrySearchPlan, REGISTRY_LEVELS, REGISTRY_STATES, REGISTRY_PAGE_SIZE, REGISTRY_MAX_PAGES } from './registryQuery.js';
export type RegistryRow = {
  id: string; name: string; affiliation: string | null; designation: string | null; localNumber: string | null;
  level: string; city: string | null; state: string | null; website: SourceLink | null;
  membersLatest: number | null; membersYear: number | null; parentName: string | null;
};
export declare function websiteFromRow(value: unknown): SourceLink | null;
export declare function normalizeRegistryRow(value: unknown): RegistryRow | null;
export declare function searchRegistry(client: unknown, query: string, filters?: Record<string, unknown>): Promise<{ rows: RegistryRow[]; total: number; plan: unknown }>;
export declare function registryPageCount(total: number): number;
