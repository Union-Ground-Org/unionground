import { describe, expect, it } from 'vitest';

import { applyPreviewCollectiveActionJoin, participationKindForAction } from './mi1OrganizationShared';

// REQ-UG-PLATFORM-ORG-PRODUCTION-20261012 (#5813): the server
// withholds platform-owned participant totals as null. An optimistic preview
// join must keep that null instead of counting from zero.
describe('applyPreviewCollectiveActionJoin', () => {
  const rows = () => [
    { id: 'withheld', kind: 'petition', viewerParticipation: null, participantCount: null },
    { id: 'counted', kind: 'rally', viewerParticipation: null, participantCount: 4 },
  ];

  it('keeps a withheld participant count withheld through a join and a withdrawal', () => {
    const joined = applyPreviewCollectiveActionJoin(rows(), 'withheld');
    expect(joined[0]).toEqual({ id: 'withheld', kind: 'petition', viewerParticipation: participationKindForAction('petition'), participantCount: null });
    expect(joined[1]).toEqual(rows()[1]);
    const withdrawn = applyPreviewCollectiveActionJoin(joined, 'withheld');
    expect(withdrawn[0]).toEqual({ id: 'withheld', kind: 'petition', viewerParticipation: null, participantCount: null });
  });

  it('still counts a visible participant total up on join and down on withdrawal, never below zero', () => {
    const joined = applyPreviewCollectiveActionJoin(rows(), 'counted');
    expect(joined[1]).toEqual({ id: 'counted', kind: 'rally', viewerParticipation: participationKindForAction('rally'), participantCount: 5 });
    expect(joined[0]).toEqual(rows()[0]);
    const withdrawn = applyPreviewCollectiveActionJoin(joined, 'counted');
    expect(withdrawn[1]).toEqual({ id: 'counted', kind: 'rally', viewerParticipation: null, participantCount: 4 });
    const floor = applyPreviewCollectiveActionJoin([{ id: 'zero', kind: 'rally', viewerParticipation: 'attendee', participantCount: 0 }], 'zero');
    expect(floor[0]).toEqual({ id: 'zero', kind: 'rally', viewerParticipation: null, participantCount: 0 });
  });
});
