// BUG-UG-CHAPTER-NOTICE-PUBLISH-NOT-EXACTLY-ONCE-20261119 (#9220):
// both notice publishers (publish_member_broadcast and
// publish_chapter_office_notice) answer a repeat of an operation key with the
// notice they already published, so a Send pressed again after a lost reply
// cannot reach members twice.
//
// The key belongs to the draft, not to the notice's words (#9225, the Sol read
// of c9ce9d6c). A composer starts one draft key on its first Post, keeps it
// through every uncertain retry, however long the person waits and whatever
// the server refused in between (round 1, r1s1 and r1s2), and ends it when
// the notice is confirmed posted or the draft is abandoned. A composer that
// was left and reopened, or a new notice with the same words, is a new draft
// with a new key. Each composer holds its draft in its own state, so nothing
// outlives the page section or the signed-in person that started it.

function defaultRandomUUID() {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  throw Object.assign(new Error("secure id generator unavailable"), { code: "UUID_UNAVAILABLE" });
}

function mintedKey(value) {
  if (typeof value !== "string" || !value) throw new Error("The UUID source produced no operation key");
  return value;
}

// One draft's key: start() mints it on the first try and returns the same
// key on every later try by the same person; confirm() after a confirmed
// publication and cancel() when the draft is abandoned both end it. A try by
// another signed-in person (a sign-out and sign-in in the same page) starts a
// new key: receipts are bound to the person on the server too.
export function createNoticeDraft(randomUUID = defaultRandomUUID) {
  let key = null;
  let owner = null;
  return Object.freeze({
    start(actor = null) {
      if (key && actor !== owner) key = null;
      owner = actor;
      key ??= mintedKey(randomUUID());
      return key;
    },
    held() {
      return key;
    },
    confirm() {
      key = null;
    },
    cancel() {
      key = null;
    },
  });
}

// The publishers refuse a draft key that already published a different
// notice (22023, member_operations_replay). That refusal proves the first
// version was posted: the composer says so and ends the draft, so the next
// Post sends the edited version as a new notice.
const KEY_REUSED = "idempotency key reused for a different request";
export function noticeKeyReused(error) {
  if (!error) return false;
  if (error.keyReused === true) return true;
  return error.code === "22023" && String(error.message ?? "").includes(KEY_REUSED);
}

// send makes the call with the function named literally, so the RPC name
// guards (scripts/lib/pr1815-read-rpc-drift.mjs) still read it at the caller.
// operationKey is the draft's key; a caller with no draft gets a key of its
// own for this one call, which deduplicates nothing and suppresses nothing.
//
// Every send carries the key. The keyed publishers of
// 20261119180000 are applied on SAMPLE and Production, so a 404, PGRST202 or
// 42883 answer is a failure like any other: the composer shows it and keeps
// the draft's key for the next Post. It is never sent again without the key,
// which could post the notice a second time with nothing to match it.
export async function publishNoticeOnce(args, send, operationKey) {
  const key = operationKey ?? mintedKey(defaultRandomUUID());
  const result = await send({ ...args, p_idempotency_key: key });
  return result?.error && noticeKeyReused(result.error) ? { ...result, keyReused: true } : result;
}
