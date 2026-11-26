// Structural declarations for apps/mobile, which imports the React-free
// no-dues navigation rule.
export function loadOrganizationRunsDues(client: { rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }> }): Promise<boolean | null>;
export function withoutDuesNav<T extends { key?: string } | null | undefined>(items: T[], runsDues: boolean | null): T[];
