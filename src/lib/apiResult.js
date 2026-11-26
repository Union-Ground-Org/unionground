// One result contract for every PostgREST/RPC read in the client layer.
//
// memberApi and lifecycleApi each carried a private helper called requireData
// with OPPOSITE null-data semantics — memberApi's returned [] for a null
// payload, lifecycleApi's threw — so the same name meant two different things
// depending on which file you happened to be reading. The distinction is real,
// so it lives in the name instead: requireRow is for a single row or aggregate
// whose absence is a failure. (memberApi keeps its own list reader, requireData,
// which returns [] for an empty list.)
//
// It preserves the PostgREST error code, which is the one thing a caller
// actually needs and a bare message string throws away: 42501 (the RLS policy
// or column grant refused this caller) reads completely differently from a
// transport failure, and only the code tells them apart.
function readFailure(result, label) {
  const error = new Error(`${label}: ${result.error.message}`, { cause: result.error });
  error.code = result.error.code || "";
  error.details = result.error.details || "";
  error.hint = result.error.hint || "";
  error.status = result.status;
  return error;
}

export function requireRow(result, label) {
  if (result.error) throw readFailure(result, label);
  if (!result.data) throw new Error(`${label}: no data returned`);
  return result.data;
}
