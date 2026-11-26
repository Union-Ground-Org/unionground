// One read, three outcomes kept apart: loaded, empty and failed
// (SYS-UG-SHARED-SWALLOWED-ERROR-GUARD-20261113). A catch that turns
// a failed read into an empty list shows "nothing here" when there may be
// something; the person cannot tell, cannot retry, and monitoring never sees
// it. Platform-neutral, so the native app imports it as is.
export const READ_STATES = Object.freeze({ loading: "loading", loaded: "loaded", empty: "empty", failed: "failed" });

export const READ_LOADING = Object.freeze({ state: READ_STATES.loading, value: null, error: null });

function nothing(value) {
  return value == null || (Array.isArray(value) && value.length === 0);
}

// Never rejects: the failure is the "failed" state, with the error kept.
// isEmpty decides what an answered read with nothing in it looks like.
export async function readResult(read, { isEmpty = nothing } = {}) {
  try {
    const value = await read();
    return { state: isEmpty(value) ? READ_STATES.empty : READ_STATES.loaded, value, error: null };
  } catch (error) {
    return { state: READ_STATES.failed, value: null, error };
  }
}
