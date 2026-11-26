// The recorded judge contract of tests/fixtures/compass-recorded-judge-contract.js
// with the two digests that bind the judge's endpoint host re-recorded for the
// fictional stand-in mesh host that tests/compass-live-evals.test.js declares
// (Union Ground approves no mesh host of its own). Every candidate, case,
// source and complete judge-prompt digest is the unchanged oracle; only the
// configuration digest and the digest over all recorded verdict bindings
// (which embeds the configuration digest) move with the host.
import { RECORDED_COMPASS_JUDGE_CONTRACT as RECORDED } from "../fixtures/compass-recorded-judge-contract.js";

export const RECORDED_COMPASS_JUDGE_CONTRACT = Object.freeze({
  ...RECORDED,
  judge_configuration_digest_sha256: "e66c36a782cd89686f79de2893b3a4a1e35b780a8c9c1cbe30b075b9f5d35be9",
  recorded_verdict_bindings_digest_sha256: "bb87fe616785af196b8241a4cf692adb7f2e3bc2b1dbd888f2fec03efa011bf6",
});
