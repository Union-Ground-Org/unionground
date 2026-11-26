import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { BALLOT_FINAL_HINT, BALLOT_RECEIPT_SENTENCE, BALLOT_STORAGE_SENTENCE, ballotCastConfirmation } from './ballotDisclosure';

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

// REQ-UG-LOVABLE-AUDIT-NATIVE-FIXES-BALLOT-FIRST-20261103, audit P0
// MOB-COORDINATOR-04.
describe('secret-ballot wording', () => {
  it('says what the vote service stores: an unlinked choice and a participation receipt', () => {
    expect(BALLOT_STORAGE_SENTENCE).toContain('Secret vote.');
    expect(BALLOT_STORAGE_SENTENCE).toContain('without your name, worker ID or the time you voted');
    expect(BALLOT_STORAGE_SENTENCE).toContain('keeps only a dated receipt that shows you voted, never how');
    expect(BALLOT_STORAGE_SENTENCE).toContain('Votes are final.');
    expect(BALLOT_RECEIPT_SENTENCE).toBe('Your choice is not stored with your name. The receipt shows that you voted, not how.');
  });

  it('matches the storage the migrations define', () => {
    const migration = read('../../../../supabase/migrations/20260808230000_ballot_secrecy_unlinkable_votes.sql');
    const table = migration.match(/create table public\.member_ballot_choices \(([\s\S]*?)\n\);/)?.[1] ?? '';
    expect(table).toContain('ballot_id text not null');
    expect(table).toContain('option_id text not null');
    // No member and no time on the choice row: the sentence depends on both.
    expect(table).not.toMatch(/user_id|member_id|_at\b|timestamptz/);
    // Gate round 1 on #6996: no later migration may add a column to the choice
    // table or redefine the cast, or this sentence must be checked again.
    const migrations = readdirSync(fileURLToPath(new URL('../../../../supabase/migrations/', import.meta.url))).filter((name) => name.endsWith('.sql')).sort();
    const migrationText = (name: string) => read(`../../../../supabase/migrations/${name}`);
    const castDefinitions = migrations.filter((name) => /function public\.submit_ballot_vote\(/i.test(migrationText(name)));
    expect(castDefinitions.at(-1)).toBe('20260924160000_vote_campaign_organization_boundary.sql');
    for (const name of migrations) {
      expect(migrationText(name), name).not.toMatch(/alter table public\.member_ballot_choices\s+add\s+(?!constraint\b)/i);
      expect(migrationText(name), name).not.toMatch(/member_ballot_choices[^;]*voted_at/i);
    }
    const submit = read('../../../../supabase/migrations/20260924160000_vote_campaign_organization_boundary.sql');
    expect(submit).toContain('insert into public.member_ballot_choices (ballot_id, option_id, stress_run_id)');
    expect(submit).toContain('code := private.issue_ballot_receipt(p_ballot_id, caller);');
  });

  it('never says the choice is recorded on the worker record, on the live or the preview screen', () => {
    const feature = read('../features/FeatureScreen.tsx');
    expect(feature).not.toContain('Choices are recorded on your authorized worker record');
    expect(feature).not.toContain('voterless');
    expect(feature.match(/<Body muted>\{BALLOT_STORAGE_SENTENCE\}<\/Body>/g)?.length).toBe(2);
  });

  it('confirms the choice and its finality before the vote is cast', () => {
    expect(ballotCastConfirmation('Yes')).toEqual({
      title: 'Cast your vote?',
      body: "You are voting: Yes. You can't change your vote after you cast it.",
      confirmLabel: 'Cast vote',
      cancelLabel: 'Go back',
    });
    expect(BALLOT_FINAL_HINT).toContain('You confirm before anything is sent.');
    const live = read('../features/FeatureScreen.tsx');
    const card = live.slice(live.indexOf('function LiveBallotCard('), live.indexOf('function UnbuiltFeatureScreen('));
    expect(card).toContain('const confirmation = ballotCastConfirmation(option.label);');
    expect(card).toContain("{ text: confirmation.cancelLabel, style: 'cancel' },");
    expect(card).toContain('action={confirmCast}');
  });
});
