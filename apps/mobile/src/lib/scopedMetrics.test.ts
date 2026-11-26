import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { MY_REPORTS_SUMMARY, OWN_RETAINED_HISTORY, reportMetricScopeLabel } from './scopedMetrics';

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

// REQ-UG-LOVABLE-AUDIT-NATIVE-FIXES-BALLOT-FIRST-20261103, audit
// MOB-STEWARD-05, MOB-ADVISOR-05, MOB-VP-05.
describe('scoped metric labels', () => {
  it('names whose activity a figure counts and over what period', () => {
    expect(reportMetricScopeLabel('own', 'this week')).toBe('Yours · this week');
    expect(reportMetricScopeLabel('chapter', 'current desk')).toBe('Campaign total · current desk');
    expect(OWN_RETAINED_HISTORY).toBe('Yours · all retained history');
    expect(MY_REPORTS_SUMMARY).toBe('Each figure says whose activity it counts and over what period.');
  });

  it('drops the blanket "own numbers only" line that sat above campaign totals', () => {
    const feature = read('../features/FeatureScreen.tsx');
    expect(feature).not.toContain('Your own numbers only');
    expect(feature).toContain("...computed.map((item) => ({ ...item, scope: reportMetricScopeLabel('own',");
    expect(feature).toContain('<Body muted>{item.scope}</Body>');
  });

  it('labels each live My reports figure with its scope', () => {
    const live = read('../features/LiveLivedInScreens.tsx');
    const reports = live.slice(live.indexOf('function LiveReportsScreen('), live.indexOf('const REPORT_CARD_COPY'));
    expect(reports).toContain('<Body muted>{MY_REPORTS_SUMMARY}</Body>');
    expect(reports.match(/<Body muted>\{OWN_RETAINED_HISTORY\}<\/Body>/g)?.length).toBe(2);
  });
});
