import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  type LegalReaderOutcome,
  openFailedNotice,
  openOutcome,
  SHARE_FAILED_NOTICE,
  SHARE_SHEET_DISMISSED_ACTION,
  SHARE_SHEET_SHARED_ACTION,
  shareOutcome,
} from './legalReaderOutcome';

// BUG-UG-MOBILE-LEGAL-READER-SHARE-OPEN-FAILURES-20260920: the legal
// reader used to discard Share.share and Linking.openURL failures and fire
// its confirmation even when the platform reported the share sheet was
// dismissed. The pure outcomes below are the contract the screen renders
// from, and the source-contract assertions below them fail if a handler
// stops routing through the helper or swallows a failure again.

// Only the failed arm of the union carries `notice`, and expect() does not
// narrow the union for TypeScript, so assert the arm here and hand back the
// narrowed outcome.
function failedOutcome(outcome: LegalReaderOutcome): { status: 'failed'; notice: string } {
  if (outcome.status !== 'failed') {
    throw new Error(`expected a failed outcome, got '${outcome.status}'`);
  }
  return outcome;
}

describe('shareOutcome: platform-reported share sheet results', () => {
  it('confirms only a platform-reported completed share', () => {
    expect(shareOutcome({ ok: true, action: SHARE_SHEET_SHARED_ACTION })).toEqual({ status: 'completed' });
  });

  it('treats a dismissed sheet as neither a completion nor a failure', () => {
    expect(shareOutcome({ ok: true, action: SHARE_SHEET_DISMISSED_ACTION })).toEqual({ status: 'dismissed' });
  });

  it('treats any other reported action as a completed share', () => {
    expect(shareOutcome({ ok: true, action: 'sharedAction' })).toEqual({ status: 'completed' });
  });

  it('turns a thrown share error into the failed outcome with the recovery notice', () => {
    const outcome = failedOutcome(shareOutcome({ ok: false, error: new Error('share failed') }));
    expect(outcome).toEqual({ status: 'failed', notice: SHARE_FAILED_NOTICE });
    expect(outcome.notice).toContain('did not complete');
    expect(outcome.notice).toContain('still open in the reader');
  });
});

describe('openOutcome: website-opening results', () => {
  it('confirms a completed open', () => {
    expect(openOutcome({ ok: true })).toEqual({ status: 'completed' });
  });

  it('turns an openURL rejection into a failed outcome naming the public URL', () => {
    const url = 'https://app.unionground.example/privacy';
    const outcome = failedOutcome(openOutcome({ ok: false, url, error: new Error('cannot open') }));
    expect(outcome.notice).toContain(url);
    expect(outcome.notice).toBe(openFailedNotice(url));
  });
});

describe('LegalDocumentScreen source contract: failures reach the worker', () => {
  const screen = readFileSync(
    fileURLToPath(new URL('../features/LegalDocumentScreen.tsx', import.meta.url)),
    'utf8',
  );

  it('routes both handlers through the outcome helper', () => {
    expect(screen).toContain("import { openOutcome, shareOutcome, type LegalReaderOutcome } from '../lib/legalReaderOutcome';");
    expect(screen).toContain('outcome = shareOutcome({ ok: true, action: result.action });');
    expect(screen).toContain('outcome = shareOutcome({ ok: false, error });');
    expect(screen).toContain('outcome = openOutcome({ ok: true });');
    expect(screen).toMatch(/outcome = openOutcome\(\{ ok: false, url, error \}\);/);
  });

  it('fires the confirmation haptic only for a completed outcome', () => {
    expect(screen).toContain("if (outcome.status === 'completed') {\n      void haptics.select();\n      setNotice(null);");
  });

  it('clears the notice when each attempt starts, before awaiting the platform call', () => {
    expect(screen.match(/setNotice\(null\);/g)?.length).toBeGreaterThanOrEqual(3);
    const share = screen.slice(screen.indexOf('async function saveOrShare()'), screen.indexOf('async function openOnSite()'));
    expect(share.indexOf('setNotice(null);')).toBeLessThan(share.indexOf('await Share.share'));
    const open = screen.slice(screen.indexOf('async function openOnSite()'), screen.indexOf('function jumpTo('));
    expect(open.indexOf('setNotice(null);')).toBeLessThan(open.indexOf('await Linking.openURL'));
  });

  it('renders the failure notice through the accessible Notice surface and announces nowhere else', () => {
    expect(screen).toContain("import { Body, Button, Card, Heading, Notice, Screen, StateMessage } from '../components/ui';");
    expect(screen).toContain('{notice ? <Notice>{notice}</Notice> : null}');
    expect(screen).toContain('setNotice(outcome.notice);');
    // Notice carries the Android live region and queues the iOS utterance
    // itself, so a second announce here would read the failure twice. The
    // repository's single announcement path (voiceoverQ19) bans the direct
    // call outright.
    expect(screen).not.toContain('announceForAccessibility');
    expect(screen).not.toContain("from '../lib/announce'");
  });

  it('never swallows a share or open failure in a bare catch again', () => {
    expect(screen).not.toMatch(/catch\s*\{/);
    expect(screen).toContain('} catch (error) {');
  });

  it('names the record at the site of the repair', () => {
    expect(screen).toContain('BUG-UG-MOBILE-LEGAL-READER-SHARE-OPEN-FAILURES-20260920');
  });
});
