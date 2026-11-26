// A server boundary that deduplicates writes by operation key, the way the
// database functions and providers do, and can lose a response after the
// write took effect. Tests replay, duplicate and fail-after-effect a write,
// then check the effect happened once (src/lib/operationKey.js).
export class LostResponseError extends Error {
  constructor() {
    super("The write took effect but its response was lost.");
    this.name = "LostResponseError";
  }
}

export function createEffectLedger() {
  const answers = new Map();
  const effects = [];
  const keys = [];
  let losing = 0;
  return {
    effects,
    // Every key the server saw, in order, including repeats.
    keys,
    // The next count writes take effect and then fail as if the network dropped.
    loseNextResponses(count = 1) { losing += count; },
    async perform(key, payload) {
      if (typeof key !== "string" || !key) throw new Error("A write reached the server without an operation key");
      keys.push(key);
      if (!answers.has(key)) {
        const answer = { id: key, effect: effects.length + 1 };
        answers.set(key, answer);
        effects.push({ key, payload });
      }
      if (losing > 0) {
        losing -= 1;
        throw new LostResponseError();
      }
      return answers.get(key);
    },
  };
}

// One attempt whose response is lost after the write, then the retry a person
// makes after the error. Returns the retry's answer.
export async function retryAfterLostResponse(ledger, attempt) {
  ledger.loseNextResponses(1);
  await attempt().then(
    () => { throw new Error("The first attempt was expected to lose its response"); },
    (error) => { if (!(error instanceof LostResponseError)) throw error; },
  );
  return attempt();
}

// The same write delivered twice at once (a double tap, a replayed request).
export async function deliverTwice(attempt) {
  return Promise.all([attempt(), attempt()]);
}
