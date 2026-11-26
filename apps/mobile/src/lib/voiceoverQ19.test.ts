import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import { activityCopy } from './activityCopy';
import { createAnnouncementCoordinator } from './announce';
import { FLOATING_CONTROL_HIT_WIDTH, FLOATING_CONTROL_LIFT, FLOATING_CONTROL_SIZE, floatingControlHitHeight, floatingControlTop } from './chromeGeometry';
import { messageInboxCopy } from './messageInboxCopy';
import {
  controlSlotTop,
  echoesScreenName,
  pinnedHeaderElements,
  pinnedHeaderLayout,
  voiceOverReadingOrder,
  type PinnedHeaderElement,
  type PinnedHeaderElementKey,
} from './pinnedHeaderOrder';
import { minimumTouchTarget, spacing } from '../theme/tokens';

vi.mock('react-native', () => ({
  AccessibilityInfo: {
    announceForAccessibility: vi.fn(),
    announceForAccessibilityWithOptions: vi.fn(),
  },
  Platform: { OS: 'ios' },
}));

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

function announcementHarness() {
  const announce = vi.fn();
  const scheduled: Array<() => void> = [];
  const coordinator = createAnnouncementCoordinator({
    announce,
    schedule: (flush) => { scheduled.push(flush); },
  });
  const flush = () => { scheduled.shift()?.(); };
  return {
    announce,
    coordinator,
    flush,
  };
}

describe('accessibility announcement campaign lead', () => {
  it('combines simultaneous StateMessage announcements into one utterance', () => {
    const { announce, coordinator, flush } = announcementHarness();

    coordinator.enqueue('Loading votes. Reading the active vote.');
    coordinator.enqueue('Loading worker pulses. Checking your private response state.');
    expect(announce).not.toHaveBeenCalled();

    flush();
    expect(announce).toHaveBeenCalledOnce();
    expect(announce).toHaveBeenCalledWith(
      'Loading votes. Reading the active vote. Loading worker pulses. Checking your private response state.',
    );
  });

  it('announces a genuine duplicate only once within one rendered transition', () => {
    const { announce, coordinator, flush } = announcementHarness();
    const message = 'Stripe status is current.';

    coordinator.enqueue(message);
    coordinator.enqueue(message);
    flush();

    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith(message);
  });

  it('re-announces an identical provider outcome from a later retry transition', () => {
    const { announce, coordinator, flush } = announcementHarness();
    const message = 'Stripe status is current.';

    coordinator.enqueue(message);
    flush();
    coordinator.enqueue(message);
    flush();

    expect(announce).toHaveBeenCalledTimes(2);
    expect(announce).toHaveBeenNthCalledWith(1, message);
    expect(announce).toHaveBeenNthCalledWith(2, message);
  });

  it('re-announces a Notice that clears and restores identical text', () => {
    const { announce, coordinator, flush } = announcementHarness();
    const message = 'Operations Health could not be refreshed.';

    const clearNotice = coordinator.enqueue(message);
    flush();
    clearNotice();
    coordinator.enqueue(message);
    flush();

    expect(announce).toHaveBeenCalledTimes(2);
    expect(announce).toHaveBeenNthCalledWith(1, message);
    expect(announce).toHaveBeenNthCalledWith(2, message);
  });

  it('drops a pending announcement when its owning state unmounts before the flush', () => {
    const { announce, coordinator, flush } = announcementHarness();

    const cancelLoading = coordinator.enqueue('Loading dues. Checking your current record.');
    cancelLoading();
    coordinator.enqueue('No dues assessed. There are no current assessments.');
    flush();

    expect(announce).toHaveBeenCalledOnce();
    expect(announce).toHaveBeenCalledWith('No dues assessed. There are no current assessments.');
  });

  it('drops queued provider feedback when the financial actor changes before the flush', () => {
    const { announce, coordinator, flush } = announcementHarness();

    const cancelPreviousActor = coordinator.enqueue('Stripe status is current.');
    cancelPreviousActor();
    flush();

    expect(announce).not.toHaveBeenCalled();
  });

  it('drops a queued checkout notice when the Dues screen unmounts before the flush', () => {
    const { announce, coordinator, flush } = announcementHarness();

    const cancelUnmountedScreen = coordinator.enqueue('Secure payment opened. Your ledger will update only after the provider confirms settlement.');
    cancelUnmountedScreen();
    flush();

    expect(announce).not.toHaveBeenCalled();
  });

  it('announces a distinct message in a later frame', () => {
    const { announce, coordinator, flush } = announcementHarness();

    coordinator.enqueue('Loading votes.');
    flush();
    coordinator.enqueue('Votes is ready.');
    flush();

    expect(announce).toHaveBeenNthCalledWith(1, 'Loading votes.');
    expect(announce).toHaveBeenNthCalledWith(2, 'Votes is ready.');
  });
});

function sourceFilesUnder(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...sourceFilesUnder(path));
    else if (entry.name.endsWith('.tsx')) found.push(path);
  }
  return found.sort();
}

function frameOf(elements: readonly PinnedHeaderElement[], key: PinnedHeaderElementKey): PinnedHeaderElement {
  const found = elements.find((element) => element.key === key);
  if (!found) throw new Error(`the pinned header put no ${key} frame on screen`);
  return found;
}

// --- the pinned header's frames, read out of the component's own stylesheet --
//
// The geometry assertions below have to fail if PinnedHeader.tsx is reverted,
// so they are not allowed to take their numbers from the shared model alone.
// These helpers parse `styles.titleSlot`, `styles.leading` and `styles.trailing`
// out of the component source and turn them into the frames iOS would sort, for
// the device the 2026-09-18 captures came from (iPhone 14 Pro portrait).

const HEADER_SOURCE = readFileSync(fileURLToPath(new URL('../components/PinnedHeader.tsx', import.meta.url)), 'utf8');
// The device the 2026-09-18 captures came from (iPhone 14 Pro portrait).
const BAR = { safeAreaTop: 59, screenWidth: 393 };
// The bar those captures were taken on. It is gone
// (REQ-UG-MOBILE-TOP-CHROME-PROGRESSIVE-BLUR-FLOATING-PILL-20261010); the
// replay below is history, so it keeps its own number rather than borrowing a
// live constant that no longer means the same thing.
const LEGACY_BAR_HEIGHT = 52;
const TITLE_LINE_HEIGHT = 22;
// What the component puts on screen today: a floating control band, not a bar.
const CONTROL_TOP = floatingControlTop(BAR.safeAreaTop, spacing.xs);
const BAND_HEIGHT = floatingControlHitHeight(BAR.safeAreaTop, CONTROL_TOP);

const STYLE_VALUES: Record<string, number> = {
  'pinnedHeaderLayout.hitInset': pinnedHeaderLayout.hitInset,
  'pinnedHeaderLayout.titleSlotInset': pinnedHeaderLayout.titleSlotInset,
  FLOATING_CONTROL_HIT_WIDTH,
  FLOATING_CONTROL_SIZE,
};

function styleBlock(name: string): string {
  const start = HEADER_SOURCE.indexOf(`\n  ${name}: {`);
  if (start < 0) throw new Error(`PinnedHeader declares no ${name} style`);
  const open = HEADER_SOURCE.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < HEADER_SOURCE.length; index += 1) {
    if (HEADER_SOURCE[index] === '{') depth += 1;
    if (HEADER_SOURCE[index] === '}') {
      depth -= 1;
      if (depth === 0) return HEADER_SOURCE.slice(open, index + 1);
    }
  }
  throw new Error(`PinnedHeader's ${name} style is unbalanced`);
}

function styleNumber(block: string, property: string): number | null {
  const match = new RegExp(`(?:^|[{,\\s])${property}:\\s*`).exec(block);
  if (!match) return null;
  const from = match.index + match[0].length;
  let depth = 0;
  let end = from;
  for (; end < block.length; end += 1) {
    const character = block[end];
    if (character === '(') depth += 1;
    else if (character === ')') depth -= 1;
    else if (depth === 0 && (character === ',' || character === '}' || character === '\n')) break;
  }
  const raw = block.slice(from, end).trim();
  const known = STYLE_VALUES[raw];
  if (typeof known === 'number') return known;
  const parsed = Number(raw);
  if (Number.isFinite(parsed)) return parsed;
  throw new Error(`PinnedHeader's ${property} is \`${raw}\`, which this pin does not model`);
}

/**
 * The frames the component puts on screen, built the way it builds them: the
 * horizontal half out of `styles`, the vertical half out of the inline style
 * each slot is given, whose exact text is pinned below so a reverted component
 * fails here rather than passing on the model's own arithmetic.
 */
const HAT_SOURCE = readFileSync(fileURLToPath(new URL('../components/HatSwitcher.tsx', import.meta.url)), 'utf8');

function slotFrame(key: PinnedHeaderElementKey, styleName: string): PinnedHeaderElement {
  if (key === 'trailing') {
    // The compact hat capsule is the trailing control on a pushed surface, and
    // HatSwitcher draws it, not PinnedHeader: it floats free of any bar now.
    // Its anchor takes the same band at the right painted gutter, because the
    // capsule paints its full 48pt width.
    const anchor = /anchorTrailing: \{[^}]*paddingRight: pinnedHeaderLayout\.trailingInset,/.test(HAT_SOURCE);
    if (!anchor) throw new Error('HatSwitcher no longer anchors the compact capsule to the trailing gutter');
    return {
      key,
      x: BAR.screenWidth - pinnedHeaderLayout.trailingInset - FLOATING_CONTROL_HIT_WIDTH,
      y: CONTROL_TOP,
      width: FLOATING_CONTROL_HIT_WIDTH,
      height: BAND_HEIGHT,
    };
  }
  const block = styleBlock(styleName);
  const left = styleNumber(block, 'left');
  const right = styleNumber(block, 'right');
  const width = styleNumber(block, 'width')
    ?? (left !== null && right !== null ? BAR.screenWidth - left - right : FLOATING_CONTROL_HIT_WIDTH);
  const lift = key === 'title' ? pinnedHeaderLayout.headingSlotLift : 0;
  return {
    key,
    x: left ?? (right === null ? 0 : BAR.screenWidth - right - width),
    y: CONTROL_TOP - lift,
    width,
    height: BAND_HEIGHT + lift,
  };
}

describe('Q19 VoiceOver: sign-in and MFA failure announcements', () => {
  const signIn = read('../../app/sign-in.tsx');
  const mfa = read('../../app/mfa-challenge.tsx');
  const announce = read('./announce.ts');

  it('announces sign-in failures once: iOS helper, Android live region', () => {
    expect(signIn).toContain("import { announceForAccessibility } from '../src/lib/announce'");
    expect(signIn).toContain("if (Platform.OS === 'ios') announceForAccessibility(text)");
    expect(signIn).not.toMatch(/^\s*announceForAccessibility\(text\);/m);
    expect(signIn).toContain("setMessage({ failed: true, text })");
    expect(signIn).toContain('accessibilityLiveRegion="polite"');
    expect(signIn).toContain('accessibilityRole="alert"');
    expect(announce).toContain('export function announceForAccessibility(message: string): void {');
  });

  it('announces the AppProvider sign-in error the same way', () => {
    expect(signIn).toContain('if (error && !message && Platform.OS === \'ios\') announceForAccessibility(error)');
    expect(signIn).toContain('accessibilityLiveRegion="polite"');
    expect(signIn).toContain('<Body accessibilityRole="alert" style={{ color: theme.destructive }}>{error}</Body>');
  });

  it('speaks MFA verification failures the same way', () => {
    expect(mfa).toContain("import { announceForAccessibility } from '../src/lib/announce'");
    expect(mfa).toContain('const translated = catalogLabel(text);');
    expect(mfa).toContain("if (Platform.OS === 'ios') announceForAccessibility(translated)");
    expect(mfa).not.toMatch(/^\s*announceForAccessibility\(translated\);/m);
    expect(mfa).toContain('accessibilityLiveRegion="polite"');
    expect(mfa).toContain('accessibilityRole="alert"');
  });
});

describe('Shared state feedback VoiceOver announcements', () => {
  const ui = read('../components/ui.tsx');
  const shareIntake = read('../../app/share-intake.tsx');
  const coordinator = read('./announce.ts');

  it('announces shared Notice and StateMessage changes on iOS while retaining Android live regions', () => {
    // The shared Button's disabled reason  also takes the per-owner queue.
    expect(ui).toContain("import { queueAccessibilityAnnouncement, useAccessibilityAnnouncementQueue } from '../lib/announce'");
    expect(ui).toMatch(/export function Notice[\s\S]*?return queueAccessibilityAnnouncement\([\s\S]*?children,[\s\S]*?announcementOwner[\s\S]*?\}, \[announcementOwner, children\]\);/);
    expect(ui).toMatch(/export function StateMessage[\s\S]*?return queueAccessibilityAnnouncement\([\s\S]*?announcement,[\s\S]*?announcementOwner[\s\S]*?\}, \[announcement, announcementOwner\]\);/);
    expect(ui.match(/accessibilityLiveRegion="polite"/g)?.length).toBeGreaterThanOrEqual(2);
    expect(coordinator).toContain('const sharedAnnouncementCoordinator = createAnnouncementCoordinator({');
    expect(coordinator).toContain("schedule = (flush) => { setTimeout(flush, 0); }");
  });

  it('owns every direct source queue call with cleanup and a distinct attempt identity', () => {
    const srcDirectory = fileURLToPath(new URL('../', import.meta.url));
    const queueCallsites = sourceFilesUnder(srcDirectory).flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      const calls = source.match(/return queueAccessibilityAnnouncement\([\s\S]*?\);/g) ?? [];
      return calls.map((call) => ({ call, path: relative(srcDirectory, path) }));
    });

    expect(queueCallsites.map(({ path }) => path)).toEqual([
      'components/RootErrorBoundary.tsx',
      'components/TransactionalAction.tsx',
      'components/ui.tsx',
      'components/ui.tsx',
      'features/MemberSupportScreen.tsx',
      'features/NativeDeletionCompletion.tsx',
      'features/NativeSignOut.tsx',
      'features/NativeSignOut.tsx',
    ]);
    for (const { call, path } of queueCallsites) {
      expect(call, `${path} must bind the queued item to an attempt`).toMatch(/,[\s\S]*(?:[aA]ttempt|announcementOwner|messageAttempt|visibleNoticeAttempt)/);
    }
    expect(sourceFilesUnder(srcDirectory).flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      return source.includes('announceForAccessibility(') ? [relative(srcDirectory, path)] : [];
    })).toEqual([]);
    expect(coordinator).toContain('`${ownerIdentity}:${++attempt.current}`');
  });

  it('does not double-announce share-intake feedback now owned by StateMessage', () => {
    expect(shareIntake.match(/queueAccessibilityAnnouncement\([^)]*\)/g)).toEqual([
      'queueAccessibilityAnnouncement(message)',
      'queueAccessibilityAnnouncement(cleanupMessage)',
    ]);
    expect(shareIntake).toContain("const message = 'Shared attachment uploaded securely.';\n    queueAccessibilityAnnouncement(message);");
    expect(shareIntake).toContain('<StateMessage compact title="Attachment needs attention" body={uploadErrorBody} />');
  });

  it('re-announces an identical cleanup failure on both platforms only after the visible StateMessage already owns it', () => {
    expect(shareIntake).toMatch(/if \(loadingError === cleanupMessage\) \{\s*queueAccessibilityAnnouncement\(cleanupMessage\);\s*\}\s*setLoadingError\(cleanupMessage\);/);
    expect(shareIntake).toContain('}, [busy, loadingError, router, setCurrentPending]);');
  });

  it('speaks repeated upload guidance once while preserving distinct recovery guidance', () => {
    expect(shareIntake).toContain('withDistinctGuidance,');
    expect(shareIntake).toContain('const uploadErrorBody = uploadError ? withDistinctGuidance(uploadError, uploadErrorGuidance) : null;');
  });

  it('keeps picker-visible upload errors compact without giving up the shared announcement', () => {
    expect(ui).toContain('compact?: boolean');
    expect(ui).toContain('? [styles.stateCompact, elevation.level1, { backgroundColor: theme.card, borderColor: theme.border }]');
    expect(ui).toContain("stateCompact: { borderRadius: radii.lg, borderWidth: StyleSheet.hairlineWidth, padding: spacing.lg, gap: spacing.sm }");
    expect(shareIntake).toContain('<StateMessage compact title="Attachment needs attention" body={uploadErrorBody} />');
  });
});

describe('Worker Support outcome announcements', () => {
  const memberSupport = read('../features/MemberSupportScreen.tsx');

  it('speaks every Worker Support outcome on iOS and keeps one Android live region', () => {
    // The screen held one notice string exposed only through
    // `accessibilityLiveRegion`, which React Native documents as Android-only:
    // no Member Support success or failure reached VoiceOver.
    expect(memberSupport).toMatch(/import \{[^}]*\bqueueAccessibilityAnnouncement\b[^}]*\} from '\.\.\/lib\/announce'/);
    expect(memberSupport).toMatch(/useEffect\(\(\) => \{[\s\S]{0,200}?if \(notice\.message && notice\.tone !== 'error' && Platform\.OS === 'ios'\) \{\s*return queueAccessibilityAnnouncement\(notice\.message, `member-support:\$\{notice\.attempt\}`\);/);
    // Android already hears the live region; the helper's Android path would
    // say the same sentence a second time.
    expect(memberSupport.match(/accessibilityLiveRegion=/g)).toHaveLength(1);
    expect(memberSupport).toContain('<Text accessibilityLiveRegion="polite">{notice.message === BUSINESS_SAVED_STALE ? t(BUSINESS_SAVED_STALE) : notice.message}</Text>');
  });

  it('routes every worker panel and the staff handoff panel through the one announced setter', () => {
    expect(memberSupport).toContain("const [notice, setNotice] = useBusinessDraftState<{ message: string; tone: MemberSupportNoticeTone; attempt: number }>({ message: '', tone: 'success', attempt: 0 });");
    expect(memberSupport).toMatch(/const publishNotice = useCallback\(\(next: MemberSupportNotice\) => \{\s*setNotice\(\(current\) => \(\{ message: next\?\.message \?\? '', tone: next\?\.tone \?\? 'success', attempt: current\.attempt \+ 1 \}\)\);\s*\}, \[setNotice\]\);/);
    expect(memberSupport).toContain('setBusy(true); publishNotice(null);');
    expect(memberSupport).toContain("publishNotice(settled.ok && proof === 'unavailable' ? { tone: 'success', message: t(BUSINESS_SAVED_STALE) } : settled.notice);");
    expect(read('../features/memberSupportNotice.ts')).toContain("export const MEMBER_SUPPORT_COMMIT_FAILURE = 'That change was not confirmed. Try again.';");
    expect(memberSupport).toContain('onNotice={publishNotice}');
    // A raw setter reaching the notice would skip the attempt increment, and
    // an identical repeat would go silent again: publishNotice owns the only
    // write.
    expect(memberSupport.match(/setNotice\(/g)).toHaveLength(1);
  });

  it('re-announces an identical Worker Support failure from the next attempt', () => {
    const { announce, coordinator, flush } = announcementHarness();
    const failure = 'That change was not confirmed. Try again.';

    // commit() clears the notice, then writes the outcome, so each attempt is
    // a clear followed by a message under its own attempt identity.
    let attempt = 0;
    const commit = () => {
      coordinator.enqueue('', `member-support:${++attempt}`);
      flush();
      coordinator.enqueue(failure, `member-support:${++attempt}`);
      flush();
    };

    commit();
    commit();

    expect(announce).toHaveBeenCalledTimes(2);
    expect(announce).toHaveBeenNthCalledWith(1, failure);
    expect(announce).toHaveBeenNthCalledWith(2, failure);
  });
});

describe('Q19 VoiceOver: Messages and Activity filter chips', () => {
  const messages = read('../../app/messages.tsx');
  const notifications = read('../../app/notifications.tsx');

  it('never puts a selection word in filterCount for either locale', () => {
    const locales: Array<'en' | 'es'> = ['en', 'es'];
    for (const locale of locales) {
      const copy = messageInboxCopy[locale];
      expect(copy.filterCount('all', copy.filters.all, 1, true)).toBe(copy.filterCount('all', copy.filters.all, 1, false));
      expect(copy.filterCount('channel', copy.filters.channel, 2, true)).toBe(copy.filterCount('channel', copy.filters.channel, 2, false));
      expect(copy.filterCount('direct', copy.filters.direct, 1, true)).not.toMatch(/selected|seleccionado/i);
      expect(copy.filterCount('unread', copy.filters.unread, 3, true)).not.toMatch(/selected|seleccionado/i);
    }
    expect(messageInboxCopy.en.filterCount('all', 'All', 1, true)).toBe('1 item');
    expect(messageInboxCopy.en.filterCount('channel', 'Channels', 2, true)).toBe('2 channels');
    expect(messageInboxCopy.es.filterCount('all', 'Todos', 1, true)).toBe('1 elemento');
    expect(messageInboxCopy.es.filterCount('direct', 'Directos', 2, true)).toBe('2 conversaciones');
  });

  it('closes the worker committee member composer when a staff hat becomes active', () => {
    expect(messages).toContain("if (!staffBriefingHat) return;");
    expect(messages).toContain('setComposerOpen(false);');
    expect(messages).toContain("setDraft('');");
    expect(messages).toContain('{composerOpen && !staffBriefingHat ? (');
    expect(messages).toContain('if (staffBriefingHat) return;');
    expect(messages).not.toContain('{composerOpen ? (');
  });

  it('gives Messages chips an iOS-conveyed role and puts the count in accessibilityValue', () => {
    expect(messages).toMatch(/MESSAGE_FILTERS\.map\([\s\S]*?accessibilityRole="button"/);
    expect(messages).toContain('accessibilityValue={{ text: copy.filterCount(');
    expect(messages).toContain('accessibilityLabel={copy.filters[key]}');
    expect(messages).toContain('accessibilityState={{ selected }}');
    expect(messages).not.toContain('accessibilityRole="tab"');
  });

  it('gives Activity pills an iOS-conveyed role with selected state', () => {
    expect(notifications).toMatch(/activityFilters\.map\([\s\S]*?accessibilityRole="button"/);
    expect(notifications).toContain('accessibilityState={{ selected }}');
    expect(notifications).toContain('accessibilityLabel={copy.showFilter(entry.key)}');
    expect(activityCopy.en.showFilter('cases')).toBe('Show issues updates');
    expect(activityCopy.es.showFilter('cases')).toBe('Mostrar novedades de asuntos');
    expect(notifications).not.toContain('accessibilityRole="tab"');
  });
});

describe('Q19 VoiceOver: conversation bubbles and composers', () => {
  const actions = read('../components/NativeMessageActions.tsx');
  const conversation = read('../../app/conversation/[id].tsx');
  const channel = read('../../app/channel/[id].tsx');
  const replies = read('../components/MessageReplies.tsx');
  const compass = read('../components/CompassPanel.tsx');

  it('does not hide bubble children behind a fixed Message actions label', () => {
    expect(actions).not.toMatch(/<Pressable accessibilityRole="button" accessibilityLabel="Message actions"/);
    expect(actions).toContain("accessibilityActions={[{ name: 'activate', label: t('Message actions')");
    expect(actions).toContain("accessibilityLabel={t('Open message actions')}");
    expect(actions).toContain('accessibilityLabel={accessibilityLabel}');
    expect(actions).toContain('{children}');
  });

  it('names every conversation row as sender then body, including grouped messages', () => {
    expect(conversation).toContain('const rowName = `${message.senderName}: ${bodyText}`;');
    expect(conversation).toContain('accessibilityLabel={rowName}');
    expect(conversation).toContain('const sameSender = previous?.senderKind === message.senderKind');
    expect(conversation).toContain('if (sendError && Platform.OS === \'ios\') announceForAccessibility(nativeCatalogLabel(language, sendError))');
    expect(conversation).toContain('sendError ? <View accessibilityLiveRegion="polite">');
    expect(conversation).toContain('<Body accessibilityRole="alert" style={{ color: theme.destructive }}>{catalogLabel(sendError)}</Body>');
  });

  it('hides leading sender metadata so VoiceOver names each incoming row once', () => {
    expect(conversation).toMatch(
      /!mine && !sameSender \? \(\s*<View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">\s*<Avatar initials=\{initialsFor\(message\.senderName\)\}/,
    );
    expect(conversation).toContain('style={styles.senderRow} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"');
    expect(conversation).toContain('accessibilityLabel={rowName}');
    expect(conversation).toContain('<WorkflowMessageActions');
    expect(actions).toContain("accessibilityLabel={t('Open message actions')}");
  });

  // A11Y-UG-MOBILE-CHANNEL-AND-REPLY-ROW-NAMES-OMIT-SENDER-20260915: the
  // conversation screen's `sender: body` name, on the two message surfaces that
  // still named their rows from the body alone.
  it('names every channel post as sender then body on both the live and the preview row', () => {
    expect(channel).toContain('const rowName = `${message.author}: ${message.body}`;');
    expect(channel).toContain('accessibilityLabel={rowName} onConfirmed=');
    expect(channel).toContain('<View accessible accessibilityLabel={rowName}><Body>{message.body}</Body></View>');
    expect(channel).not.toMatch(/onCompose=\{\(\) => \{ setReplyTo\(message\.id\); setDraft\(''\); \}\}><Body>\{message\.body\}<\/Body><\/NativeMessageActions> : <Body>/);
  });

  it('drops the channel author text and the initials avatar from the accessibility tree', () => {
    expect(channel).toMatch(
      /<View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">\s*<Avatar square initials=\{message\.initials\}/,
    );
    // A <Text> is the iOS accessibility element, so accessibilityElementsHidden
    // (which hides the elements *contained within* one) cannot remove the leaf
    // author node by itself: accessible={false} is what takes it out of the iOS
    // tree, and the other two props keep Android's NO_HIDE_DESCENDANTS.
    expect(channel).toContain('<Text accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.author, { color: theme.foreground }]}>{message.author}</Text>');
    expect(channel).not.toMatch(/<Text accessibilityElementsHidden[^>]*styles\.author/);
    // The role chip and the time are not in the row name, so they stay audible.
    expect(channel).toContain('<Text style={[styles.time, { color: theme.mutedForeground }]}>{message.time}</Text>');
  });

  it('names every reply as sender then body and says the sender once', () => {
    expect(replies).toContain('accessibilityLabel={`${row.author_name}: ${bodyText}`}');
    expect(replies).toContain("const bodyText = row.redacted_at ? t('Message removed.') : row.body;");
    expect(replies).toContain('<Text accessibilityLabel={meta} style={{ color: theme.mutedForeground }}>{row.author_name} · {meta}</Text>');
    expect(replies).not.toContain('<Text style={{ color: theme.mutedForeground }}>{row.author_name} ·');
  });

  it('does not set a reply accessibilityLabel that differs from the placeholder', () => {
    expect(conversation).toContain("placeholder={t('Conversation reply')}");
    expect(conversation).toContain("accessibilityLabel={Platform.OS === 'ios' ? undefined : t('Conversation reply')}");
    expect(conversation).not.toContain('placeholder="Message"');
    expect(conversation).not.toContain('accessibilityLabel="Conversation reply"');
  });

  it('does not set an identical Guide label and placeholder on the question input', () => {
    expect(compass).toContain("placeholder={t('Ask the Guide')}");
    expect(compass).toContain("accessibilityLabel={Platform.OS === 'ios' ? undefined : t('Ask the Guide')}");
    expect(compass).not.toContain('accessibilityLabel="Ask the Guide"');
  });

  it('uses the localized Messages placeholder as the iOS search name and retains the Android label', () => {
    const messages = read('../../app/messages.tsx');
    const ui = read('../components/ui.tsx');
    expect(messages).toContain("placeholder={copy.search} accessibilityLabel={Platform.OS === 'ios' ? undefined : copy.search}");
    expect(ui).toContain('accessibilityLabel?: string;');
    expect(messageInboxCopy.en.search).toBe('Search messages');
    expect(messageInboxCopy.es.search).toBe('Buscar mensajes');
  });

  it('uses the placeholder as the iOS name of the mentions and mention-picker search fields and retains the Android labels', () => {
    const mentions = read('../../app/mentions.tsx');
    const channelControls = read('../components/ChannelControls.tsx');
    expect(mentions).toContain("placeholder=\"Search your mentions\" accessibilityLabel={Platform.OS === 'ios' ? undefined : 'Search your mentions'}");
    expect(mentions).not.toContain('accessibilityLabel="Search your mentions"');
    expect(channelControls).toContain("placeholder={t('Find a person to mention')} accessibilityLabel={Platform.OS === 'ios' ? undefined : t('Find a person to mention')}");
    expect(channelControls).not.toContain('accessibilityLabel="Find a person to mention"');
  });
});

describe('Q19 VoiceOver: Guide pause', () => {
  const compass = read('../components/CompassPanel.tsx');

  it('announces the governance pause and reports the composer dimmed', () => {
    expect(compass).toContain("import { useAccessibilityAnnouncementQueue } from '../lib/announce'");
    expect(compass).toContain("if (Platform.OS === 'ios') queueAnnouncement(catalogLabel(pauseMessage))");
    expect(compass).toContain("const pauseMessage = 'The Guide is paused by an administrator.';");
    expect(compass).toContain('accessibilityLiveRegion="assertive"');
    expect(compass).toContain('editable={historyReady && !paused && pendingSave === null}');
    expect(compass).toContain('accessibilityState={{ disabled: !historyReady || paused || pendingSave !== null }}');
  });
});

describe('Q19 VoiceOver: My campaign rows and Activity unread state', () => {
  const union = read('../../app/(tabs)/campaign.tsx');
  const notifications = read('../../app/notifications.tsx');

  it('composes the resource description into each destination row and marks the section caption as a heading', () => {
    expect(union).toContain('accessibilityLabel={`${item.title}, ${item.body}`}');
    expect(union).toContain('accessibilityRole="header" style={[styles.sectionLabel, { color: theme.mutedForeground }]}>Campaign tools</Text>');
    expect(union).toContain('accessibilityRole="header" style={[styles.sectionLabel, { color: theme.mutedForeground }]}>Path to a first contract</Text>');
    expect(union).not.toContain('accessibilityLabel={item.title}');
  });

  it('puts unread in New-section row labels and marks New as a heading', () => {
    expect(notifications).toContain('const unreadLabel = `${copy.unreadLabel(item.title, item.body)}, ${summary(item)}`;');
    expect(notifications).toContain('accessibilityLabel={unreadLabel}');
    expect(notifications).toContain('accessibilityRole="header" style={[styles.sectionLabel, { color: theme.mutedForeground }]}>{copy.fresh}</Text>');
    expect(notifications).not.toContain('accessibilityLabel={`${item.title}. ${item.body}`}');
    expect(notifications).toContain('accessibilityLabel={`${copy.openUpdate(item.title, item.body)}, ${summary(item)}`}');
    expect(notifications).toContain('accessibilityLabel={`${copy.markUnreadLabel(item.title)}, ${summary(item)}`}');
    expect(notifications).toContain('accessibilityRole="header" style={[styles.sectionLabel, { color: theme.mutedForeground }]}>{copy.earlier}</Text>');
    expect(activityCopy.en.unreadLabel('Vote', 'Opens today')).toBe('Vote, unread, Opens today');
    expect(activityCopy.en.openUpdate('Vote', 'Opens today')).toBe('Open update: Vote, Opens today');
    expect(activityCopy.en.markUnreadLabel('Vote')).toBe('Mark Vote unread');
    expect([activityCopy.en.fresh, activityCopy.en.earlier]).toEqual(['New', 'Earlier']);
  });
});

describe('Q19 VoiceOver: Account controls', () => {
  const account = read('../../app/(tabs)/account.tsx');
  const picker = read('../components/MessageWorkflowPicker.tsx');

  it('hides the decorative SettingRow glyph without hiding the row text or controls', () => {
    const settingRow = account.slice(account.indexOf('function SettingRow('), account.indexOf('const styles ='));
    expect(settingRow).toContain('<Ionicons name={icon} size={24} color={theme.primary} accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />');
    expect(settingRow).toContain('<View style={[styles.setting, { borderColor: theme.border }]}>');
    expect(settingRow).toContain('{title}</Text><Body muted>{body}</Body>');
    expect(settingRow).toContain('{children}');
  });

  // The privacy-policy row, each custom-link row and
  // the shared search field carry the same bare leading glyph.
  it('hides the decorative privacy-row, custom-link and search glyphs too', () => {
    const hide = 'accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />';
    expect(account).toContain(`<Ionicons name="document-text-outline" size={24} color={theme.primary} ${hide}`);
    expect(read('../components/CustomNavLinksCard.tsx')).toContain(`<Ionicons name="link-outline" size={24} color={theme.primary} ${hide}`);
    expect(read('../components/ui.tsx')).toContain(`<Ionicons name="search" size={18} color={theme.mutedForeground} ${hide}`);
  });

  it('names the private-notifications control and reports on or off from state', () => {
    expect(account).toContain('const notificationsOn = mode === \'preview\' ? nativePush.enabled : nativePush.registered;');
    expect(account).toContain('accessibilityRole="switch"');
    expect(account).toContain('accessibilityLabel={notificationCopy.title}');
    expect(account).toContain('accessibilityState={{ checked: notificationsOn, busy, disabled: notificationDisabled }}');
    expect(account).not.toContain('accessibilityLabel={notificationAction}');
  });

  it('reports the biometric switch dimmed from the availability flag', () => {
    expect(account).toContain('accessibilityState={{ disabled: !biometricAvailable }}');
    expect(account).toContain("accessibilityLabel={biometricAvailable ? t(\"Biometric re-lock\") : t(\"Biometric re-lock, Unavailable: this phone has no Face ID, Touch ID or fingerprint set up.\")}");
    expect(account).toContain('disabled={!biometricAvailable}');
  });

  it('uses the selected trait for Account radio groups', () => {
    expect(picker).toContain('accessibilityRole="radio"');
    expect(picker).toContain('accessibilityState={{ selected }}');
    expect(picker).not.toContain('checked: selected');
    // The App theme section is no longer a radio group: Union Ground is the
    // only theme (Nov 3, 2026), so it reads as one text element instead.
    expect(account).not.toContain('busyTheme');
    expect(read('../components/LanguageSettingsCard.tsx')).toContain('selected={language === value}');
    expect(read('../components/ui.tsx')).toContain("accessibilityRole={selected === undefined ? 'button' : 'radio'}");
  });
});

describe('Q19 VoiceOver: pinned header order and native tabs', () => {
  const header = read('../components/PinnedHeader.tsx');
  const tabs = read('../../app/(tabs)/_layout.tsx');
  const runbook = read('../../IOS_DEVICE_RUNBOOK.md');

  // The device does not read this bar in JSX order. Build 7afda61a6 shipped the
  // title slot first  and both retained 2026-09-18 iPhone captures
  // still list "Back" ahead of the heading. React Native never sets
  // `accessibilityElements`, so UIKit orders the bar automatically and the frame
  // is the only lever; the order that fits the captures is band-by-top-edge then
  // ascending minX. These pins therefore measure frames read out of the
  // component's own stylesheet, and the render order the record asks for.

  it('fails if the back control is rendered before the title again', () => {
    // The record's acceptance item 5 and its own suggested_regression_test.
    // Frames decide it on iOS, but the hierarchy is the input we cannot rule
    // out and it is this fix's second line of defence, so it is pinned too.
    const titleSlot = header.indexOf('style={[styles.titleSlot');
    const leadingSlot = header.indexOf('style={[styles.leading');
    expect(titleSlot).toBeGreaterThan(-1);
    expect(leadingSlot).toBeGreaterThan(-1);
    expect(titleSlot).toBeLessThan(leadingSlot);
    expect(header).toContain('accessibilityLabel={backLabel}');
    const headingRole = header.indexOf("accessibilityRole={heading ? 'header' : undefined}");
    expect(headingRole).toBeGreaterThan(-1);
    expect(headingRole).toBeLessThan(header.indexOf('accessibilityLabel={backLabel}'));
  });

  it('reads the heading before the back control, from the styles the component declares', () => {
    const heading = slotFrame('title', 'titleSlot');
    const back = slotFrame('back', 'leading');
    const trailing = slotFrame('trailing', 'trailing');
    // iOS orders the SLOT, not the control inside it - the captures report the
    // leading slot at y=59 and its Back button at y=60 - so the heading needs a
    // margin against the slot on both axes, not against the button.
    expect(heading.x).toBeLessThan(back.x);
    expect(heading.y).toBeLessThan(back.y);
    expect(back.x).toBe(pinnedHeaderLayout.hitInset);
    expect(back.width).toBe(FLOATING_CONTROL_HIT_WIDTH);
    // The target is anchored at the circle's top edge and holds the 48pt touch
    // minimum below the safe-area line, with the 8pt status-bar overlap on top
    // (BUG-UG-NATIVE-TOUCH-TARGETS-UNDER-48PX-20261019 closed the
    // spec's open question 4); it is never widened upward into the status
    // bar, and the heading still leads it on both axes.
    expect(back.height).toBe(BAND_HEIGHT);
    expect(back.height).toBe(minimumTouchTarget + FLOATING_CONTROL_LIFT);
    for (const tolerance of [0, BAND_HEIGHT, LEGACY_BAR_HEIGHT]) {
      expect(voiceOverReadingOrder([heading, back], tolerance)).toEqual(['title', 'back']);
      const order = voiceOverReadingOrder([heading, back, trailing], tolerance);
      expect(order[0]).toBe('title');
      expect(order.indexOf('title')).toBeLessThan(order.indexOf('back'));
    }
  });

  it('declares the band and the heading lift inline, where the frames come from', () => {
    // The vertical half of every frame above is read out of these exact
    // expressions, so a component that drops the lift or stops bounding the
    // band at the content start line fails here and not only in the model.
    expect(header).toContain('const controlTop = floatingControlTop(insets.top, spacing.xs);');
    expect(header).toContain('const bandHeight = floatingControlHitHeight(insets.top, controlTop);');
    expect(header).toContain('{ top: controlTop - pinnedHeaderLayout.headingSlotLift, height: bandHeight + pinnedHeaderLayout.headingSlotLift }');
    expect(header).toContain('{ top: controlTop + controlSlotTop(bandHeight, bandHeight), height: bandHeight }');
    expect(pinnedHeaderLayout.headingSlotLift).toBeGreaterThan(0);
  });

  it('keeps the shared geometry model in step with the stylesheet it models', () => {
    const modelled = pinnedHeaderElements({
      screenWidth: BAR.screenWidth,
      bandTop: CONTROL_TOP,
      bandHeight: BAND_HEIGHT,
      backTarget: BAND_HEIGHT,
      hasHeading: true,
      hasBack: true,
      hasTrailing: true,
    });
    expect(frameOf(modelled, 'title')).toEqual(slotFrame('title', 'titleSlot'));
    expect(frameOf(modelled, 'back')).toEqual(slotFrame('back', 'leading'));
    expect(frameOf(modelled, 'trailing')).toEqual(slotFrame('trailing', 'trailing'));
  });

  it('replays the 2026-09-18 capture, which read the back control first', () => {
    // tree-ios-R02-conversation.txt on build 7afda61a6, header container:
    //   leading  slot y=59 x=4    (its Back button reported at y=60)
    //   trailing slot y=59 x=341
    //   title    slot y=73 x=4    (its StaticText at x=128)
    const shipped: PinnedHeaderElement[] = [
      { key: 'back', x: 4, y: 59, width: minimumTouchTarget, height: LEGACY_BAR_HEIGHT },
      { key: 'trailing', x: 341, y: 59, width: minimumTouchTarget, height: LEGACY_BAR_HEIGHT },
      { key: 'title', x: 4, y: 73, width: 385, height: TITLE_LINE_HEIGHT },
    ];
    expect(voiceOverReadingOrder(shipped, 0)).toEqual(['back', 'trailing', 'title']);
    expect(voiceOverReadingOrder(shipped, LEGACY_BAR_HEIGHT)).toEqual(['back', 'title', 'trailing']);
  });

  it('makes the stretched slot, not the text, the heading element', () => {
    expect(header).toContain("import { controlSlotTop, echoesScreenName, pinnedHeaderLayout } from '../lib/pinnedHeaderOrder'");
    expect(header).toContain('const heading = title ?? screenName;');
    expect(header).toContain('accessible={Boolean(heading)}');
    expect(header).toContain("accessibilityRole={heading ? 'header' : undefined}");
    expect(header).toContain('accessibilityLabel={heading}');
    // The role moved off the text; leaving it on both would read the name twice.
    expect(header).not.toContain('<Text accessibilityRole="header"');
    // The slot paints nothing at all. The title painted beside Back
    // (UX-UG-NATIVE-TITLE-BESIDE-BACK-CONTROL-20261115) is a separate,
    // touch-transparent copy that leaves the tree on both platforms, or
    // TalkBack and VoiceOver would read the title a second time after Back.
    expect(header.match(/<Text\b/g) ?? []).toHaveLength(1);
    expect(header).toMatch(/<View\s+pointerEvents="none"\s+accessibilityElementsHidden\s+importantForAccessibility="no-hide-descendants"\s+style=\{\[styles\.titleRow/);
    expect(header.indexOf('style={[styles.titleSlot')).toBeLessThan(header.indexOf('style={[styles.titleRow'));
    expect(read('../components/ui.tsx')).not.toContain('PageTitle');
    // The heading frame overlaps the chevron, so the chevron stays the
    // front-most view in its own square for taps and explore-by-touch. Anchor
    // both halves to the real props: `toContain('pointerEvents="none"')` was
    // also satisfied by the JSX comment that describes the prop.
    expect(header).toMatch(/height: bandHeight \+ pinnedHeaderLayout\.headingSlotLift \}\]\}\s+pointerEvents="none"/);
    expect(styleBlock('leading')).toContain('zIndex: 1');
  });

  // This edition's five-tab dock (Home, Work, Guide, Campaign, Account) and its
  // pushed screens: twenty surfaces carry the pinned header.
  it('names all 20 pinned-header surfaces, so every one of them has a heading to read first', () => {
    const appDirectory = fileURLToPath(new URL('../../app', import.meta.url));
    const hosts = sourceFilesUnder(appDirectory)
      .filter((file) => readFileSync(file, 'utf8').includes('<PinnedHeaderScreen'));
    expect(hosts.length).toBe(20);
    for (const file of hosts) {
      const tags = readFileSync(file, 'utf8').match(/<PinnedHeaderScreen[^>]*/g) ?? [];
      expect(tags.length, `${file} must render the pinned header`).toBeGreaterThan(0);
      for (const tag of tags) {
        expect(tag, `${file} must name its pushed surface with title= or screenName=`)
          .toMatch(/\b(?:title|screenName)=/);
      }
    }
  });

  it('says and shows a pushed screen name once: the row paints and announces it, the scene leaves it out', () => {
    expect(echoesScreenName('Activity', 'Activity')).toBe(true);
    expect(echoesScreenName(' Activity ', 'Activity')).toBe(true);
    expect(echoesScreenName('Activity', 'My work')).toBe(false);
    expect(echoesScreenName('', '')).toBe(false);
    expect(echoesScreenName(undefined, 'Activity')).toBe(false);
    expect(echoesScreenName('Activity', null)).toBe(false);
    expect(header).toContain('export function useScreenNameAlreadySpoken(text: unknown): ScreenNameEcho {');
    expect(header).toContain('<PinnedHeaderNameContext.Provider value={title ?? screenName ?? null}>');
    expect(header).toContain('accessibilityElementsHidden: true');
    expect(header).toContain("importantForAccessibility: 'no-hide-descendants'");
    // Every scene that painted the words its own row now paints and announces.
    const scenes: [string, string][] = [
      ['components/ui.tsx', read('../components/ui.tsx')],
      ['app/notifications.tsx', read('../../app/notifications.tsx')],
      ['features/PulseScreen.tsx', read('../features/PulseScreen.tsx')],
      ['app/channel/[id].tsx', read('../../app/channel/[id].tsx')],
      ['app/conversation/[id].tsx', read('../../app/conversation/[id].tsx')],
    ];
    for (const [name, source] of scenes) {
      expect(source, `${name} must not announce the screen name a second time`)
        .toContain('useScreenNameAlreadySpoken');
    }
    expect(read('../components/ui.tsx')).toContain('if (echo.duplicate) return null;');
    expect(read('../../app/channel/[id].tsx')).toContain('if (echo.duplicate) return null;');
    expect(read('../../app/notifications.tsx')).toContain('{bandEcho.duplicate ? null : (');
    expect(read('../../app/conversation/[id].tsx')).toContain('{contactEcho.duplicate ? null : (');
  });

  it('keeps the public campaign directory and public meeting pages out of the app', () => {
    // Private worker activity stays off the public front door (PRODUCT.md
    // design principle 3), so the sibling's public chapter pages do not ship.
    for (const file of ['../../app/public/chapters.tsx', '../../app/public/events/[id].tsx', '../features/mi1/PublicDiscoveryScreen.tsx']) {
      expect(existsSync(fileURLToPath(new URL(file, import.meta.url))), file).toBe(false);
    }
  });

  it('scopes tab-bar minimize to sighted iOS Home and pins per-trigger position labels', () => {
    expect(tabs).toContain("import { useScreenReader } from '../../src/lib/screenReader'");
    expect(tabs).toContain("minimizeBehavior={screenReader || pathname !== '/home' || restoringTabBar ? 'never' : 'onScrollDown'}");
    expect([...tabs.matchAll(/<NativeTabs.Trigger name="[^"]+" accessibilityLabel=\{t\("([^"]+)"\)\}/g)]
      .map((match) => match[1])).toEqual(['Home, 1 of 5', 'Work, 2 of 5', 'Guide, 3 of 5', 'Campaign, 4 of 5', 'Account, 5 of 5']);
    for (const name of ['messages', 'pulse', 'union']) expect(tabs).not.toContain(`<NativeTabs.Trigger name="${name}"`);
    expect(runbook).toContain('Native tab VoiceOver (expo-router');
    expect(runbook).toContain('It does **not** accept');
    expect(runbook).toContain('an accessibility role or value');
  });
});

describe('Q19 VoiceOver: Worker Q&A failure announcements', () => {
  const qa = read('../features/mi1/MemberQaScreen.tsx');
  const noticeMarkup = '{error ? <Notice>{error}</Notice> : null}';

  it('announces list-load, detail, pagination, and mutation failures through the explicit path', () => {
    expect(qa).toContain('const [errorVersion, setErrorVersion] = useBusinessDraftState(0, confirmedOwner.workspace);');
    expect(qa).toMatch(/useEffect\(\(\) => \{\s*if \(error\) return queueAnnouncement\(error\);\s*return undefined;\s*\}, \[error, errorVersion, queueAnnouncement\]\);/);
    const spoken = [...qa.matchAll(/queueAnnouncement\(([a-z]+)\)/g)].map((match) => match[1]);
    expect(spoken).toEqual(['notice', 'error']);
    expect(qa).toContain("import { useAccessibilityAnnouncementQueue } from '../../lib/announce'");
  });

  it('bumps errorVersion at every failure so a repeated identical sentence is spoken again', () => {
    const failures = [...qa.matchAll(/setError\(qaFailureText\(language, ([^)]+)\)\);/g)];
    expect(failures.map((match) => match[1])).toEqual(['listResult', 'detail', 'result', "result, null, 'writeUnconfirmed'"]);
    for (const match of failures) {
      const after = qa.slice(match.index! + match[0].length, match.index! + match[0].length + 64);
      expect(after).toMatch(/^\s*setErrorVersion\(\(value\) => value \+ 1\);/);
    }
    expect(qa).toContain('setNoticeVersion((value) => value + 1);');
  });

  it('keeps the failure sentence in the Notice after the announcement and leaves success announcements intact', () => {
    expect((qa.match(/\{error \? <Notice>\{error\}<\/Notice> : null\}/g) ?? []).length).toBe(2);
    expect(qa).toContain(noticeMarkup);
    expect(qa).toContain('if (notice) return queueAnnouncement(notice);');
    expect(qa).toContain('}, [notice, noticeVersion, queueAnnouncement]);');
    expect(qa).toContain('accessibilityLiveRegion="polite"');
    expect(qa).toContain('setLoading(true);\n    setError(null);');
    expect(qa).toMatch(/setBusy\(true\);\s*setError\(null\);/);
    expect(qa).toContain("setNotice(null);\n        setError(qaFailureText(language, result, null, 'writeUnconfirmed'));");
  });
});

describe('Power map and Digital Picket Line notice announcements (A11Y-UG-MOBILE-ORGANIZATION-AND-ACTION-NOTICES-NOT-ANNOUNCED-20260920)', () => {
  const screens = read('../features/mi1/OrganizationIntelligenceScreens.tsx');
  const section = (start: string, end: string) => screens.slice(screens.indexOf(start), end ? screens.indexOf(end) : undefined);
  const organizationMap = section('export function OrganizationIntelligenceScreen()', 'export function CollectiveActionsScreen()');
  const picketLine = section('export function CollectiveActionsScreen()', '');
  const announcesNotice = /useEffect\(\(\) => \{\s*if \(notice\) return queueAnnouncement\(notice\);\s*return undefined;\s*\}, \[notice, queueAnnouncement\]\);/;

  it('routes every truthy notice through the owned announcement queue on both screens', () => {
    expect(screens).toContain("import { useAccessibilityAnnouncementQueue } from '../../lib/announce'");
    expect(organizationMap).toContain('useAccessibilityAnnouncementQueue(`organization-map:');
    expect(picketLine).toContain('useAccessibilityAnnouncementQueue(`digital-picket-line:');
    expect(organizationMap).toMatch(announcesNotice);
    expect(picketLine).toMatch(announcesNotice);
    expect(screens).not.toContain('announceForAccessibility(');
  });

  it('speaks the save outcomes and operation failures that the pill shows', () => {
    expect(organizationMap).toContain("setNotice('Saved.');");
    expect(organizationMap).toContain("setNotice('The change could not be saved.');");
    expect(picketLine).toContain("setNotice(t('The action could not be completed.'));");
    // Each attempt clears the notice first, so a repeated identical outcome changes the effect dependency.
    expect(organizationMap).toContain("await operate(true, async () => {");
    expect(picketLine).toContain("await operate(key, async () => {");
    expect(organizationMap).toMatch(/setNotice\(''\);\s*try \{\s*await operation\(\)/);
    expect(picketLine).toMatch(/setNotice\(''\);\s*try \{\s*await operation\(current\)/);
  });

  it('keeps the notice visible in the status pill', () => {
    expect(organizationMap).toContain('{notice ? <StatusPill label={notice} /> : null}');
    expect(picketLine).toContain('{notice ? <StatusPill label={notice} /> : null}');
  });
});

describe('Q19 VoiceOver: remaining role and state gaps', () => {
  const work = read('../features/WorkScreen.tsx');
  const pulse = read('../features/PulseScreen.tsx');
  const support = read('../features/MemberSupportScreen.tsx');
  const intelligence = read('../features/mi1/OrganizationIntelligenceScreens.tsx');
  const feature = read('../features/FeatureScreen.tsx');
  const livedIn = read('../features/LiveLivedInScreens.tsx');

  it('gives filter chips an iOS-conveyed button role with selected state', () => {
    expect(work).toMatch(/accessibilityRole="button"\s+accessibilityState=\{\{ selected \}\}/);
    expect(pulse).toMatch(/accessibilityRole="button"\s+accessibilityState=\{\{ selected \}\}/);
    expect(support).toContain('accessibilityRole="button"');
    expect(support).toContain('accessibilityState={{ selected: tab === item.id }}');
    expect(intelligence).toContain('accessibilityRole="button" accessibilityState={{ selected }}');
    expect(work).not.toContain('accessibilityRole="tab"');
    expect(pulse).not.toContain('accessibilityRole="tab"');
    expect(support).not.toContain('accessibilityRole="tab"');
    expect(intelligence).not.toContain('accessibilityRole="tab"');
  });

  it('speaks the committee member scan outcome through the owned announcement queue', () => {
    // The scan desk landed with a bare platform call, which neither cancels on
    // unmount nor carries an attempt identity, so a superseded scan could still
    // speak over the one the steward is reading.
    expect(livedIn).toContain("import { useAccessibilityAnnouncementQueue } from '../lib/announce'");
    expect(livedIn).toContain("const queueScanAnnouncement = useAccessibilityAnnouncementQueue(staffDesk ? 'events-desk-scan' : 'events-scan');");
    expect(livedIn).toContain("if (Platform.OS === 'ios') queueScanAnnouncement(copy);");
    expect(livedIn).not.toContain('announceForAccessibility(');
  });

  it('uses the selected trait for remaining radio groups', () => {
    expect(feature).toContain('accessibilityState={{ selected: checked }}');
    expect(feature).toContain('accessibilityState={{ selected: attentionLevel === level }}');
    // The Native App Reads The Web Surveys: The survey
    // radio rows moved to the shared-model form; same selected trait.
    expect(livedIn).toContain('accessibilityState={{ selected: chosen, disabled }}');
    expect(support).toContain('accessibilityRole="radio"');
    expect(support).toContain('accessibilityState={{ selected: scenario.id === entry.id }}');
    expect(support).not.toMatch(/accessibilityRole="radio"[^>]*accessibilityState=\{\{ checked/);
  });
});
