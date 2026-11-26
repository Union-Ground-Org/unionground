// Structural declarations for apps/mobile, which imports the catalogue-free
// source-line model (REQ-UG-PROVENANCE-CONTRACT-20261012).
export declare const SOURCE_LINE_TIME_ZONE: 'America/New_York';

export interface SourceLineEntry {
  publisher: string;
  href: string;
  title: string | null;
  retrieved: string;
}

export type SourceLineInput =
  | (SourceLineEntry & { key: string })
  | { key: string; reference: string };

export interface SourceLineModel extends SourceLineEntry {
  inputs: SourceLineInput[];
}

export declare function formatRetrievedDate(value: unknown, lang?: 'en' | 'es'): string | null;

export declare function sourceLineModel(
  provenance: unknown,
  options?: { lang?: 'en' | 'es'; inputs?: unknown[] },
): SourceLineModel | null;
