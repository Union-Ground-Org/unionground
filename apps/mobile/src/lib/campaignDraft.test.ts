import { describe, expect, it } from 'vitest';
import {
  campaignDraftProblem,
  defaultCampaignClose,
  emptyCampaignDraft,
  saveCampaignDraftArgs,
  stepCampaignCloseDay,
  stepCampaignCloseTime,
  stepQuorum,
} from './campaignDraft';

// #9099 part 3: the phone's campaign draft sends what save_vote_campaign_draft
// accepts, as src/lib/campaignApi.js saveCampaignDraft does.
const now = new Date(2026, 10, 18, 13, 7, 30);

describe('campaign draft', () => {
  it('starts as a vote closing a week out on the next quarter hour, quorum 1, two empty choices', () => {
    const draft = emptyCampaignDraft(now, 'chapter');
    expect(draft.kind).toBe('ballot');
    expect(draft.scope).toBe('chapter');
    expect(draft.closesAt).toEqual(new Date(2026, 10, 25, 13, 15, 0));
    expect(draft.quorumTarget).toBe(1);
    expect(draft.options).toEqual([{ labelEn: '', labelEs: '' }, { labelEn: '', labelEs: '' }]);
    expect(defaultCampaignClose(new Date(2026, 10, 18, 13, 0, 0))).toEqual(new Date(2026, 10, 25, 13, 0, 0));
  });

  it('steps the close by day and quarter hour and keeps the quorum between 1 and a million', () => {
    const close = new Date(2026, 10, 25, 17, 0, 0);
    expect(stepCampaignCloseDay(close, 1)).toEqual(new Date(2026, 10, 26, 17, 0, 0));
    expect(stepCampaignCloseTime(close, -1)).toEqual(new Date(2026, 10, 25, 16, 45, 0));
    expect(stepQuorum(1, -1)).toBe(1);
    expect(stepQuorum(41, 1)).toBe(42);
    expect(stepQuorum(1_000_000, 1)).toBe(1_000_000);
  });

  it('names the first field the server would refuse', () => {
    const ready = { ...emptyCampaignDraft(now, 'chapter'), titleEn: 'Ratify the tentative agreement', options: [{ labelEn: 'Yes', labelEs: '' }, { labelEn: 'No', labelEs: '' }] };
    expect(campaignDraftProblem(ready, now)).toBeNull();
    expect(campaignDraftProblem({ ...ready, titleEn: 'ab' }, now)).toBe('title');
    expect(campaignDraftProblem({ ...ready, titleEs: 'x'.repeat(161) }, now)).toBe('title');
    expect(campaignDraftProblem({ ...ready, bodyEn: 'x'.repeat(1001) }, now)).toBe('details');
    expect(campaignDraftProblem({ ...ready, closesAt: new Date(now.getTime() - 1) }, now)).toBe('closes');
    expect(campaignDraftProblem({ ...ready, quorumTarget: 0 }, now)).toBe('quorum');
    expect(campaignDraftProblem({ ...ready, kind: 'pulse', quorumTarget: 0 }, now)).toBeNull();
    expect(campaignDraftProblem({ ...ready, options: [{ labelEn: 'Yes', labelEs: '' }] }, now)).toBe('options');
    expect(campaignDraftProblem({ ...ready, options: [{ labelEn: 'Yes', labelEs: '' }, { labelEn: ' ', labelEs: '' }] }, now)).toBe('options');
    expect(campaignDraftProblem({ ...ready, options: Array.from({ length: 21 }, (_, index) => ({ labelEn: `Choice ${index}`, labelEs: '' })) }, now)).toBe('options');
  });

  it('sends a vote with its quorum and a pulse without one, the English text standing in for a missing Spanish one', () => {
    const vote = { ...emptyCampaignDraft(now, 'union'), titleEn: ' Strike authorization ', titleEs: 'Autorizacion de huelga', bodyEn: ' Vote by Friday. ', quorumTarget: 40,
      options: [{ labelEn: ' Yes ', labelEs: 'Si' }, { labelEn: 'No', labelEs: '' }] };
    expect(saveCampaignDraftArgs(vote)).toEqual({
      p_kind: 'ballot', p_campaign_id: null, p_scope: 'union', p_title_en: 'Strike authorization', p_title_es: 'Autorizacion de huelga',
      p_closes_at: vote.closesAt.toISOString(), p_quorum_target: 40, p_body_en: 'Vote by Friday.', p_body_es: '',
      p_options: [{ labelEn: 'Yes', labelEs: 'Si' }, { labelEn: 'No', labelEs: 'No' }],
    });
    const pulse = { ...vote, kind: 'pulse' as const, titleEs: '' };
    expect(saveCampaignDraftArgs(pulse)).toMatchObject({ p_kind: 'pulse', p_quorum_target: null, p_title_es: 'Strike authorization' });
  });
});
