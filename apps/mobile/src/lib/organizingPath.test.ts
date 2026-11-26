import { describe, expect, it } from 'vitest';

import { ORGANIZING_STAGES, organizingStageStatuses, shareOfEstimate } from './organizingPath';

describe('organizing path', () => {
  it('keeps recognition and a first contract as separate, later stages', () => {
    expect(ORGANIZING_STAGES.map((stage) => stage.key)).toEqual(['committee', 'majority', 'path', 'recognition', 'first-contract']);
    expect(ORGANIZING_STAGES.find((stage) => stage.key === 'recognition')?.body).toContain('not certification');
  });

  it('marks stages before the current one complete and the rest upcoming', () => {
    expect(organizingStageStatuses('path')).toEqual(['complete', 'complete', 'current', 'upcoming', 'upcoming']);
    expect(organizingStageStatuses(null)).toEqual(['upcoming', 'upcoming', 'upcoming', 'upcoming', 'upcoming']);
  });

  it('never divides by an empty or invented estimate', () => {
    expect(shareOfEstimate(119, 184)).toBe(65);
    expect(shareOfEstimate(5, 0)).toBeNull();
    expect(shareOfEstimate(-1, 10)).toBeNull();
    expect(shareOfEstimate(300, 184)).toBe(100);
  });
});
