// REQ-UG-HOLD-LEARNING-PERIOD-OFFER-UNTIL-RELEASE-20261112 (#8581):
// the learning period offer is held until its release day
// (the hold_learning_period_offer migration), so no organization can start
// one. A proof of the period itself releases the switch inside its own open
// transaction; its rollback puts the hold back.
export const LEARNING_PERIOD_SWITCH = "features.guidance_onboarding.learning_period";

export async function releaseLearningPeriodHold(client) {
  const { rowCount } = await client.query(
    "update public.platform_setting_definitions set release_at = null where key = $1",
    [LEARNING_PERIOD_SWITCH],
  );
  if (rowCount !== 1) throw new Error(`expected the ${LEARNING_PERIOD_SWITCH} definition, found ${rowCount}`);
}

// For a proof that must commit its start: release the switch, run, and put the
// release time back in the same transaction, so the commit leaves it as it was.
export async function whileLearningPeriodReleased(client, run) {
  const { rows } = await client.query(
    "select release_at::text as release_at from public.platform_setting_definitions where key = $1 for update",
    [LEARNING_PERIOD_SWITCH],
  );
  if (rows.length !== 1) throw new Error(`expected the ${LEARNING_PERIOD_SWITCH} definition, found ${rows.length}`);
  await releaseLearningPeriodHold(client);
  try {
    return await run();
  } finally {
    await client.query("update public.platform_setting_definitions set release_at = $2::timestamptz where key = $1",
      [LEARNING_PERIOD_SWITCH, rows[0].release_at]);
  }
}
