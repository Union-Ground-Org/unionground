export type AuditAdvisory = { id: string; package: string; severity: string; range: string; url: string };
export type AuditException = { id: string; package: string; severity: string; range: string; reason: string; approved: string; expires: string };
export type BuildToolAdvisory = { id: string; package: string; severity: string; range: string; reached_only_through: string[]; reason: string; approved: string };
export type PackageLock = { packages?: Record<string, { name?: string; version?: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string>; devDependencies?: Record<string, string>; link?: boolean; resolved?: string }> };
export type AuditReport = {
  vulnerabilities?: Record<string, { via?: Array<string | { source?: number; name?: string; url?: string; severity?: string; range?: string }> }>;
  metadata?: { vulnerabilities?: { total?: number } };
};

export function reportAdvisories(report: AuditReport): AuditAdvisory[];
export function reachableInProduction(lock: PackageLock, target: string, blocked?: string[], options?: { includeDev?: boolean }): boolean;
export function buildToolPathProven(lock: PackageLock, target: string, buildTools: string[]): boolean;
export function evaluateAudit(report: AuditReport, exceptions: AuditException[], today: string, options?: { buildTool?: BuildToolAdvisory[]; lock?: PackageLock | null }): {
  failures: AuditAdvisory[];
  tolerated: AuditAdvisory[];
  expired: AuditException[];
  unused: AuditException[];
  buildTool: AuditAdvisory[];
  unusedBuildTool: BuildToolAdvisory[];
};
export function validatedAuditReport(report: unknown, status: number | null, label?: string): AuditReport;
export function auditCommand(options: {
  document: { schema: number; exceptions: AuditException[]; build_tool_advisories?: BuildToolAdvisory[] };
  lock: PackageLock | null;
  today: string;
  runAudit: (args: string[]) => AuditReport;
  blockFull?: boolean;
  out?: (line: string) => void;
  err?: (line: string) => void;
  summary?: ((text: string) => void) | null;
}): 0 | 1;
export type AuditDocument = { schema: number; exceptions: AuditException[]; build_tool_advisories?: BuildToolAdvisory[] };
export type MergeBaseAudit = { readable: false; reason: string }
  | { readable: true; mergeBase: string; document: AuditDocument; lock: PackageLock | null; runAudit: (args: string[]) => AuditReport; cleanup?: () => void };
export function introducedAuditCommand(options: Parameters<typeof auditCommand>[0] & { loadBase?: (() => MergeBaseAudit) | null }): 0 | 1;
export function mergeBaseAudit(options: {
  cwd: string;
  base: string | undefined;
  headAudit: (args: string[]) => AuditReport;
  scratch?: string;
  files?: (options: { cwd: string; base: string | undefined; paths: string[] }) => { readable: false; reason: string } | { readable: true; mergeBase: string; files: Record<string, { unchanged: boolean; text: string }> };
}): MergeBaseAudit;
