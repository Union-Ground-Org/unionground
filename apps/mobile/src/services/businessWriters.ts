import type { SupabaseClient } from '@supabase/supabase-js';
import type { MobileSessionWriter } from './supabase';

// #9254(b): the composing screen supplies batch (a)'s writer. This seam never
// obtains an identity from the mutable client and has no unbound fallback.
export async function businessRpc(
  writer: MobileSessionWriter,
  name: string,
  args: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const client = await writer.client();
  const request = client.rpc(name, args);
  const { data, error, status }: { data: unknown; error: unknown; status?: unknown } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw attachBusinessRpcProvenance(error, status);
  return data;
}

// #9240 pull request D2: where a refusal came from. postgrest-js hands back
// any non-2xx JSON body as the error, whoever sent it (PostgREST, or a gateway
// in front of it), and a transport failure as an object with an empty code.
// The response status is on the result, not on the error. A caller that must
// tell a refusal PostgREST made (its call rolled back or never ran) from a
// gateway's answer (which may follow a commit) reads these two fields. They
// are added to the same error object and are not enumerable, so every other
// caller sees the error exactly as before: same object, same fields, same
// JSON.
export type BusinessRpcProvenance = {
  // The HTTP status of the answer; 0 when none arrived or none was reported.
  httpStatus: number;
  // The body has PostgREST's own error shape: a non-empty code and a message,
  // plus details and hint, each a string or null.
  postgrestShape: boolean;
};
const PROVENANCE: unique symbol = Symbol('businessRpcProvenance');
type ProvenanceCarrier = { [PROVENANCE]?: BusinessRpcProvenance };

function hasPostgrestErrorShape(error: object): boolean {
  const text = (value: unknown) => typeof value === 'string';
  const textOrNull = (value: unknown) => value === null || typeof value === 'string';
  const code: unknown = Reflect.get(error, 'code');
  return text(code) && code !== '' && text(Reflect.get(error, 'message'))
    && Object.hasOwn(error, 'details') && textOrNull(Reflect.get(error, 'details'))
    && Object.hasOwn(error, 'hint') && textOrNull(Reflect.get(error, 'hint'));
}

export function attachBusinessRpcProvenance<T>(error: T, status: unknown): T {
  if (!error || typeof error !== 'object' || !Object.isExtensible(error)) return error;
  const provenance: BusinessRpcProvenance = {
    httpStatus: typeof status === 'number' && Number.isInteger(status) ? status : 0,
    postgrestShape: hasPostgrestErrorShape(error),
  };
  Object.defineProperty(error, PROVENANCE, { value: provenance, enumerable: false, configurable: true });
  return error;
}

// null for anything that did not come through businessRpc's refusal path.
export function businessRpcProvenance(error: unknown): BusinessRpcProvenance | null {
  return error && typeof error === 'object' ? (error as ProvenanceCarrier)[PROVENANCE] ?? null : null;
}

// Keep stateful RPC factories (retry keys, acknowledgement caches) alive.
// Their command transport resolves batch (a)'s writer for each dispatch. The
// read-only Auth facade is for existing sensitive-content HTTP adapters: it
// returns the same checked session, never a late shared-session token.
export function bindBusinessApi<T extends object>(
  client: SupabaseClient,
  writer: MobileSessionWriter,
  factory: (bound: SupabaseClient) => T,
  readRpcNames: readonly string[],
): T {
  const commandClient: unknown = {
    rpc: (name: string, args: Record<string, unknown> = {}) => readRpcNames.includes(name)
      ? client.rpc(name, args)
      : writer.client().then((bound) => bound.rpc(name, args)),
    auth: { getSession: async () => ({ data: { session: await writer.session() }, error: null }) },
  };
  return factory(commandClient as SupabaseClient);
}

// Civic's table API has no mutable retry-key cache. Its complete query builder
// is constructed after the checked client is available, so .from/.select/.eq
// retain the SDK's real thenable behavior without a generic builder proxy.
export function bindBusinessTableApi<T extends object>(
  client: SupabaseClient,
  writer: MobileSessionWriter,
  factory: (bound: SupabaseClient) => T,
  readMethods: readonly string[],
): T {
  const readers = factory(client);
  const entries: [string, unknown][] = Object.entries(readers);
  return Object.fromEntries(entries.map(([name, value]) => {
    if (typeof value !== 'function' || readMethods.includes(name)) return [name, value];
    return [name, async (...args: unknown[]) => {
      let clientForWriter: SupabaseClient;
      try { clientForWriter = await writer.client(); }
      catch { return { ok: false, error: 'The composing account is no longer signed in.' }; }
      const bound = factory(clientForWriter);
      const operation: unknown = Reflect.get(bound, name);
      if (typeof operation !== 'function') throw new Error('Business operation unavailable.');
      return Reflect.apply(operation, bound, args) as unknown;
    }];
  })) as T;
}
