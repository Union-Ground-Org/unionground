// Shared member-session backend double for the confirmed-writes and
// session-continuation suites. Responses freeze when transport starts.
// Reading current server rows at completion would hide stale epochs.
//
// Suite options are the three behaviors the copies had diverged on:
//   persistTaskWrites — chapter_tasks inserts can be stored (still gated by state.persistTaskWrites)
//   messageActions — route get_member_message_actions and react actions
//   captureInserts — capture insert writes as well as upserts
export function createMemberBackendHarness({
  persistTaskWrites = false,
  messageActions = false,
  captureInserts = false,
} = {}) {
  const state = {
    session: null,
    loader: null,
    pending: [],
    operations: [],
    rows: {},
    hold: false,
    subscribers: [],
    feeds: [],
    liveSequences: new Map(),
  };
  const user = (id) => ({ id, email: `${id}@example.test` });
  const controlled = new Set([
    "table:member_rights_progress",
    "table:member_notifications",
    "table:member_conversations",
    "table:member_guide_threads",
    "rpc:get_member_rewards_summary",
  ]);
  const execute = (resource, loader = state.loader, member = state.session?.user) => {
    // A fixture that names its people (state.profiles, keyed by user id)
    // answers their own profile; suites without one keep the model profile.
    const row = resource === "table:member_profiles" && state.profiles?.[member.id]
      ? state.profiles[member.id]
      : resource === "table:member_profiles"
      ? {
        id: member.id,
        first_name: member.id === "model-b" ? "NewIdentity" : "Model",
        full_name: member.id,
        initials: "MT",
        language: "en",
        chapter_id: "chapter-model",
      }
      : resource === "rpc:get_member_rewards_summary"
        ? { totalPoints: 100 }
        : state.rows[resource] ?? (resource.startsWith("rpc:") ? null : []);
    const operation = {
      immediate: !(state.hold && controlled.has(resource)) && state.holdResource !== resource,
      resource,
      loader,
      epoch: loader?.inspect().get(resource)?.epoch ?? 0,
      data: structuredClone(row),
      liveSequence: state.liveSequences.get(loader) ?? 0,
    };
    state.operations.push(operation);
    if (state.fail === resource) return Promise.resolve({ data: null, error: { message: "model failure" } });
    // A server refusal with its code (for example 42501 for a role the
    // fixture person does not hold), keyed by resource.
    if (state.errors?.[resource]) return Promise.resolve({ data: null, error: structuredClone(state.errors[resource]) });
    if (operation.immediate) return Promise.resolve({ data: operation.data, error: null });
    return new Promise(resolve => state.pending.push({ ...operation, resolve }));
  };
  // A created task as the server would store it. Task rows are written through
  // create_chapter_task (REQ-UG-LEARNING-PERIOD-TASKS-20261103); the
  // direct insert stays emulated for suites that still model it.
  const persistTask = (fields) => {
    const saved = {
      ...fields,
      id: "new-task",
      created_by: "model-a",
      assignee_id: "model-a",
      chapter_id: "chapter-model",
      created_at: "2026-09-07T01:00:00Z",
      updated_at: "2026-09-07T01:00:00Z",
    };
    state.rows["table:chapter_tasks"] = [saved];
    return saved;
  };
  const taskRpc = (name, args) => (persistTaskWrites && state.persistTaskWrites && name === "create_chapter_task"
    ? Promise.resolve({ data: [persistTask(args?.p_fields ?? {})], error: null })
    : null);
  const capturesWrite = (key) => (captureInserts ? key === "upsert" || key === "insert" : key === "upsert");
  const client = {
    from(table) {
      let query;
      let write;
      query = new Proxy({}, {
        get(_target, key) {
          if (key === "then") {
            return (resolve, reject) => {
              if (persistTaskWrites && write && table === "chapter_tasks" && state.persistTaskWrites) {
                return Promise.resolve({ data: persistTask(write), error: null }).then(resolve, reject);
              }
              if (write && state.failAfterRightsWrite) {
                if (table === "member_rights_progress") {
                  state.rows["table:member_rights_progress"] = [structuredClone(write)];
                  state.fail = "table:member_rights_progress";
                }
                return Promise.resolve({ data: null, error: null }).then(resolve, reject);
              }
              return execute(`table:${table}`).then(resolve, reject);
            };
          }
          return (...args) => {
            if (capturesWrite(key)) write = args[0];
            return query;
          };
        },
      });
      return query;
    },
    auth: {
      getSession: async () => ({ data: { session: state.session }, error: null }),
      onAuthStateChange(callback) {
        state.auth = callback;
        return { data: { subscription: { unsubscribe() {} } } };
      },
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal1", nextLevel: "aal1" }, error: null }),
      },
    },
    channel(name) {
      const channel = {
        on(_type, filter, callback) {
          state.feeds.push({ name, filter, callback });
          return channel;
        },
        subscribe(callback) {
          state.subscribers.push(callback);
          state.namedSubscribers[name] = callback;
          return channel;
        },
        unsubscribe() {},
      };
      return channel;
    },
    removeChannel() {},
    realtime: { setAuth() {} },
  };
  client.rpc = messageActions
    ? async (name, args) => {
      const actionState = () => ({
        canEdit: false,
        saved: false,
        reminders: [],
        reactions: (state.rows["rpc:list_member_message_reactions"] ?? [])
          .filter(row => row.actor_id === state.session.user.id && row.private_message_id === args.p_message_id)
          .map(row => row.reaction),
      });
      if (name === "get_member_message_actions") {
        return { data: { ...actionState(), canEdit: Boolean(state.canEdit) }, error: null };
      }
      if (name === "act_on_member_message" && args.p_action === "react") {
        const result = await client.rpc("toggle_member_message_reaction", {
          p_source_kind: args.p_source_kind,
          p_message_id: args.p_message_id,
          p_reaction: args.p_value,
        });
        return result.error ? result : { data: { result: result.data, state: actionState() }, error: null };
      }
      return taskRpc(name, args) ?? execute(`rpc:${name}`);
    }
    : (name, args) => taskRpc(name, args) ?? execute(`rpc:${name}`);
  const scopedClient = (member, loader) => ({
    ...client,
    from(table) {
      let query;
      query = new Proxy({}, {
        get(_target, key) {
          if (key === "then") return (resolve, reject) => execute(`table:${table}`, loader(), member).then(resolve, reject);
          return () => query;
        },
      });
      return query;
    },
    rpc: (name) => execute(`rpc:${name}`, loader(), member),
  });
  return { state, client, user, scopedClient };
}
