// Independent oracle for the deterministic Compass evaluation lane. These
// literals must be deliberately re-recorded whenever any candidate, case,
// source, complete dispatched judge prompt, or judge configuration changes.
// Re-recorded 2026-10-04 for REQ-UG-COMPASS-EVAL-HARNESS-REPAIRS-20261004:
// judge prompt v4 sees source title, reference and organization; Spanish and
// tenant-isolation families; the duplicate bounded-output case was dropped.
export const RECORDED_COMPASS_JUDGE_CONTRACT = Object.freeze({
  schema: 1,
  judge_prompt_version: "compass-semantic-entailment-v4",
  source_digest_sha256: "48f32d6a5b5bbc50a928d9997871e1784b669ed44becbe3f236a9754607bb8b2",
  judge_configuration_digest_sha256: "f4ced4811d85197a84729e97354876909be06c6f444b055aa3849156f283b195",
  case_digest_sha256: Object.freeze({
    "prompt-injection": "a2f9df953f473fbf4a97be3de42678d86ed86d371b68914fa85bda96ead1fdc1",
    "sensitive-echo": "aee02390fd7d9b92c4283dfaedd836ed2a5c2b7b674b47ef5f65011b274e7b72",
    "unsupported-legal-conclusion": "9dac732889861b31162880aa859db7163f1a4fe9edd358bc6531a6f3371c0faf",
    citation: "e49f4c5c47521da0df1d7e2a94533f78b5f499b05dfd1449a1bd9db6d521cd0f",
    refusal: "cb8b88abc231f8af268cd15cc0a03494305abfbf4d0bdb2c098b8bda6dfd0e3f",
    "spanish-source": "b373f4a6de8bb3e459f1f93b2dc48ba72047871ab7ef3d8b7a1ed6417d347fa8",
    "spanish-question": "615d1c996c6ed2a1f2ef644386427efcc35ebc10b4ae5aa31c279e203c11026c",
    "tenant-own-article": "8af13230d33a6e0db711c38ff25eab17f7c48e27472b17097b2eee287ae44d5c",
    "tenant-other-contract": "edb7c5430b952d6a8ed7cc2e1d97c6f88c42c4f9fb303b89d89afca32b49080f",
  }),
  judge_prompt_digest_sha256: Object.freeze({
    "prompt-injection": "090976a7d23af1446b372425aaf4d432d819f52237c0799194df3f4e0adf7e5d",
    "sensitive-echo": "6f450ea2389fa0487a5ff3272e5d8be69914f8c94c45b2332a77e35b0dca74cb",
    "unsupported-legal-conclusion": "5629ae16e523c735dd7daef6b637aaab8df5eda761fe6db489b5c35b28ed2030",
    citation: "07ed126d24950d9a302af034109cab08bc54463eee34912a8f205b04814a110f",
    refusal: "a90116785195bf22c7182368de50cedab6884f868a197154316b06ec35867397",
    "spanish-source": "dc2b8c04a2cd001b1d7260e365713f83c47038a46fdac29d4f9fa1ad08438d7d",
    "spanish-question": "4920ba252a877aaff46313e4d2a502008d746bc4b3e8a0da00351bd9cdb54d63",
    "tenant-own-article": "1d3fbaebc3b93529ffcef26a2d5d2aa1a714b5080abffc65f05088a6e382b502",
    "tenant-other-contract": "6c158350db5eeae414db370d14be09ff009fd55d4e1ce0a5011d18f35bbc3186",
  }),
  recorded_verdict_count: 243,
  recorded_verdict_bindings_digest_sha256: "a8c58e8a600d3f2bbb360228b9c2a2f5760c40278476cbfaba70d152c1274828",
});
