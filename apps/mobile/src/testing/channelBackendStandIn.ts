// TEST-UG-PHONE-TESTS-EXECUTE-SCREENS-ON-ONE-SHARED-STAND-IN-20261111 (#8319):
// a chapter-channel backend for screen tests that KEEPS WRITES: an insert is
// stored and every later read sees it, the way the hosted tables do. A post
// that renamed its channel (#8236) only shows after a refresh reads back what
// the post wrote, so a fixture that already holds the expected row cannot
// catch it. Pass `client` where the screen asks for the Supabase client.
type Row = Record<string, unknown>;

export function createChannelBackend(seed: Record<string, Row[]>, viewerID = 'member-a') {
  const rows: Record<string, Row[]> = {
    chapter_spaces: [], chapter_threads: [], chapter_space_reads: [], chapter_channel_polls: [],
    chapter_thread_posts: [], member_message_reactions: [],
    ...Object.fromEntries(Object.entries(seed).map(([table, list]) => [table, list.map((row) => ({ ...row }))])),
  };
  const writes: { table: string; row: Row }[] = [];
  let sequence = 0;

  function query(table: string) {
    const ins: { column: string; values: Set<unknown> }[] = [];
    const eqs: { column: string; value: unknown }[] = [];
    const isNull: string[] = [];
    const orders: { column: string; ascending: boolean }[] = [];
    let limit: number | null = null;
    let inserted: Row | null = null;
    const read = (): Row[] => {
      let found = (rows[table] ?? []).filter((row) => ins.every(({ column, values }) => values.has(row[column]))
        && eqs.every(({ column, value }) => !(column in row) || row[column] === value)
        && isNull.every((column) => column.includes('.') || row[column] == null));
      for (const { column, ascending } of [...orders].reverse()) {
        found = [...found].sort((a, b) => (String(a[column] ?? '') < String(b[column] ?? '') ? -1 : String(a[column] ?? '') > String(b[column] ?? '') ? 1 : 0) * (ascending ? 1 : -1));
      }
      return limit === null ? found : found.slice(0, limit);
    };
    const store = (row: Row): Row => {
      sequence += 1;
      const stored = table === 'chapter_threads'
        ? { status: 'open', created_at: `2026-11-11T12:${String(sequence).padStart(2, '0')}:00.000Z`, ...row, id: `thread-${sequence}` }
        : table === 'chapter_thread_posts'
          ? { author_id: viewerID, author_name: 'Worker A', author_initials: 'MA', author_role: null, body_es: null, created_at: `2026-11-11T12:${String(sequence).padStart(2, '0')}:30.000Z`, ...row, id: `post-${sequence}` }
          : { ...row, id: row.id ?? `${table}-${sequence}` };
      (rows[table] ??= []).push(stored);
      writes.push({ table, row: stored });
      return stored;
    };
    const builder = {
      select: () => builder,
      in: (column: string, values: unknown[]) => { ins.push({ column, values: new Set(values) }); return builder; },
      eq: (column: string, value: unknown) => { eqs.push({ column, value }); return builder; },
      is: (column: string, value: unknown) => { if (value === null) isNull.push(column); return builder; },
      or: () => builder,
      order: (column: string, options?: { ascending?: boolean }) => { orders.push({ column, ascending: options?.ascending !== false }); return builder; },
      limit: (value: number) => { limit = value; return builder; },
      insert: (row: Row | Row[]) => { inserted = Array.isArray(row) ? row[0] ?? {} : row; return builder; },
      upsert: (row: Row | Row[]) => { for (const one of Array.isArray(row) ? row : [row]) store(one); return builder; },
      update: () => builder,
      delete: () => builder,
      single: async () => (inserted ? { data: store(inserted), error: null } : { data: read()[0] ?? null, error: null }),
      maybeSingle: async () => (inserted ? { data: store(inserted), error: null } : { data: read()[0] ?? null, error: null }),
      then: (resolve: (value: { data: unknown; error: null }) => unknown, reject?: (reason: unknown) => unknown) => {
        const data = inserted ? [store(inserted)] : read();
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  const realtime = { on: () => realtime, subscribe: () => realtime };
  return {
    rows,
    writes,
    client: {
      auth: { getSession: async () => ({ data: { session: { user: { id: viewerID } } } }) },
      from: (table: string) => query(table),
      channel: () => realtime,
      removeChannel: async () => undefined,
      rpc: async () => ({ data: null, error: null }),
    },
  };
}
