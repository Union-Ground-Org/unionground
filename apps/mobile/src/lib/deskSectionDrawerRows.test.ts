import { describe, expect, it } from 'vitest';

import { STAFF_DESK_HATS, isSameDeskSection, type StaffDeskHat } from '../features/deskJump';
import { STAFF_HAT_FUNCTIONS, featureGroupsForRoles } from './hatFunctions';

// UX-UG-NATIVE-DESK-SECTION-ROWS-REOPEN-THEIR-DESK-20261111 (follow-up
// to #8232; an owner decision):
// twelve drawer rows named a desk section but only reopened their own desk.
// This edition leaves out contract articles, so eleven of them exist here.
const REMOVED: Record<'coordinator' | 'advisor' | 'vp', readonly string[]> = {
  coordinator: ['coordinator-cases', 'coordinator-deadlines', 'coordinator-funnel'],
  advisor: ['advisor-workload', 'advisor-turnout', 'advisor-risks', 'advisor-leadership'],
  vp: ['vp-trend', 'vp-attention', 'vp-leadership', 'vp-events'],
};

const drawerItems = (chapterRoles: StaffDeskHat[], organizationRoles: StaffDeskHat[] = []) =>
  featureGroupsForRoles(chapterRoles, organizationRoles).flatMap((group) => group.items);

describe('live drawer leaves out rows that only reopen their own desk', () => {
  it.each(STAFF_DESK_HATS)('no %s drawer row except the desk itself opens that desk', (hat) => {
    for (const scopes of [[[hat], []], [[], [hat]], [[hat], [hat]]] as const) {
      const items = drawerItems([...scopes[0]], [...scopes[1]]);
      const sameDesk = items.filter((item) => STAFF_DESK_HATS.some((desk) => isSameDeskSection(item, desk)));
      expect(sameDesk.map((item) => item.key), `${hat} ${JSON.stringify(scopes)}`).toEqual([]);
    }
  });

  it.each(Object.entries(REMOVED))('removes the %s section rows and keeps the desk row', (hat, keys) => {
    const desk = hat as keyof typeof REMOVED;
    const items = drawerItems([desk]);
    const keysInDrawer = items.map((item) => item.key);
    for (const key of keys) expect(keysInDrawer).not.toContain(key);
    expect(keysInDrawer).toContain(desk);
  });

  it('removes exactly the eleven rows: rows with a screen of their own stay', () => {
    const removed = STAFF_DESK_HATS.flatMap((hat) => STAFF_HAT_FUNCTIONS[hat].filter((item) => isSameDeskSection(item, hat)).map((item) => item.key));
    expect(removed.sort()).toEqual(Object.values(REMOVED).flat().sort());
    expect(drawerItems(['vp']).map((item) => item.key)).toContain('vp-priorities');
    expect(drawerItems(['admin']).map((item) => item.key)).toEqual(expect.arrayContaining(['admin-access', 'admin-events']));
    expect(drawerItems(['steward']).map((item) => item.key)).toEqual(expect.arrayContaining(['steward-caseload', 'steward-requests', 'steward-forms', 'steward-broadcasts']));
  });

  it('keeps the rows for the desk screen, whose section labels and counts still use them', () => {
    for (const [hat, keys] of Object.entries(REMOVED)) {
      const present = STAFF_HAT_FUNCTIONS[hat as keyof typeof REMOVED].map((item) => item.key);
      expect(present).toEqual(expect.arrayContaining([...keys]));
    }
  });

  it("each desk row's description names what the removed rows covered", () => {
    const blurb = (hat: keyof typeof REMOVED) => STAFF_HAT_FUNCTIONS[hat].find((item) => item.key === hat)?.blurb?.toLowerCase() ?? '';
    // #8630: the live Case queue holds active cases and deadlines only, so the
    // coordinator row stops naming the funnel and by-article views.
    for (const part of ['active issues', 'upcoming deadlines']) expect(blurb('coordinator')).toContain(part);
    for (const part of ['escalation funnel', 'article cited']) expect(blurb('coordinator')).not.toContain(part);
    for (const part of ['workload', 'vote turnout', 'at-risk signals', 'leadership team']) expect(blurb('advisor')).toContain(part);
    for (const part of ['membership trend', 'executive attention', 'leadership team', 'upcoming meetings']) expect(blurb('vp')).toContain(part);
  });
});
