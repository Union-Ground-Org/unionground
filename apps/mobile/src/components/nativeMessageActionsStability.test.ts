import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// REQ-UG-NATIVE-MESSAGE-ACTIONS-20260904, ANDROID5 findings 1 and 2
// (2026-09-26, Pixel, SAMPLE private conversation): menu choices (save,
// remind, reply, edit) were dropped without feedback in the ~4 s window after
// a reaction or a read acknowledgement, and the "· Saved" footer reverted to
// "Actions" while the server kept the save. Mechanism: the conversation
// screen's load effect listed the dashboard `refresh` callback as a
// dependency; that callback takes a new identity on every dashboard change
// and the screen itself requests one after each read acknowledgement, so the
// effect re-ran, cleared the thread ("Loading conversation") and unmounted
// every NativeMessageActions row. A remounted row starts a new generation and
// discards the previous menu's response; its local `state` (the Saved
// footer) starts over as null.
//
// The mobile lane ships no React renderer, so the contract is pinned by
// source: the latest `refresh` is read through a ref and is not a dependency
// of the load effect, and rows stay keyed by user + message id.

const conversation = readFileSync(fileURLToPath(new URL('../../app/conversation/[id].tsx', import.meta.url)), 'utf8');
const channel = readFileSync(fileURLToPath(new URL('../../app/channel/[id].tsx', import.meta.url)), 'utf8');
const actions = readFileSync(fileURLToPath(new URL('./NativeMessageActions.tsx', import.meta.url)), 'utf8');

describe('native message actions survive a dashboard refresh', () => {
  it('reads the dashboard refresh through a ref inside the conversation load effect', () => {
    expect(conversation).toContain('const refreshRef = useRef(refresh);');
    expect(conversation).toContain('refreshRef.current = refresh;');
    expect(conversation).toContain('void refreshRef.current();');
    // No direct `refresh()` call remains inside the load/reconcile effect;
    // the send path may still await the live callback.
    expect(conversation).not.toContain('          void refresh();\n');
  });

  it('does not restart the conversation load when the dashboard refresh identity changes', () => {
    expect(conversation).toContain('}, [attempt, id, message, mode, previewThread, userID, staffThreadRead, actorScope, retireAuthoring]);');
    expect(conversation).toMatch(/const retireAuthoring = useCallback\(\(\) => \{[\s\S]*?\}, \[\]\);/);
    expect(conversation).not.toContain('refresh, userID]');
  });

  it('keeps the reconcile branch that clears a vanished thread (conversationUnread contract)', () => {
    expect(conversation).toContain("if (reconcileThreadResult(next) === 'clear' || !next) { retireAuthoring(); setThread(null); return; }");
  });

  it('keys every action row by user and message so a refetch reuses the mounted row', () => {
    expect(conversation).toContain('<WorkflowMessageActions key={`${userID ?? mode}:${message.id}`} sourceKind="private" messageID={message.id}');
    expect(channel).toContain('<WorkflowMessageActions key={`${session?.user.id ?? mode}:${message.id}`} sourceKind="channel" messageID={message.id}');
    // The row invalidates its generation only on its own identity or enablement.
    expect(actions).toContain('}, [messageID, sourceKind, enabled, session?.user.id]);');
  });
});

const readSource = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

// App Store capture, Nov 7, 2026: a plain "Actions" line under every message
// read like a stray label, and a long channel name ran past the screen edge.
describe('channel message chrome', () => {
  it('shows message actions as a quiet "⋯ Actions" control that keeps its name and target', () => {
    const actions = readSource('./NativeMessageActions.tsx');
    expect(actions).toContain("accessibilityLabel={t('Open message actions')}");
    expect(actions).toContain('<Ionicons name="ellipsis-horizontal" size={16} color={theme.mutedForeground} />');
    expect(actions).toContain("{busy ? ` ${t('Updating…')}` : ` ${t('Actions')}`}");
    expect(actions).toContain("{state?.saved ? <Text style={{ color: theme.foreground }}>{` · ${t('Saved')}`}</Text> : null}");
    expect(actions).toContain("actionsLabel: { flexShrink: 1, fontSize: 14, lineHeight: 19, ...typeface.control },");
    expect(actions).toContain("target: { minHeight: minimumTouchTarget, justifyContent: 'center', paddingVertical: spacing.xs },");
    // The control's own target keeps the full minimum height while it hugs its words.
    expect(actions).toContain("actionsTarget: { minHeight: minimumTouchTarget, justifyContent: 'flex-start', paddingTop: spacing.xs, alignSelf: 'flex-start' },");
    expect(actions).toContain('const actionsTarget = footer ? styles.actionsTargetInRow : styles.actionsTarget;');
    expect(actions).toContain('style={({ pressed }) => (pressed ? [actionsTarget, styles.actionsPressed, { backgroundColor: theme.muted }] : actionsTarget)}>');
    expect(actions).toContain("actionsTargetInRow: { minHeight: minimumTouchTarget, maxWidth: '100%', flexShrink: 1, justifyContent: 'center', paddingHorizontal: spacing.xs, marginLeft: -spacing.xs },");
    // A channel message's reactions and "⋯ Actions" share one footer row.
    expect(actions).toContain('{footer ? <View style={[styles.footerRow, aboveFooter ? styles.footerAfterAbove : null]}>{footer}{actionsControl}</View> : actionsControl}');
    expect(readSource('../../app/channel/[id].tsx')).toContain('footer={footerInActions ? reactionRow : undefined}');
    // A poll message gets the same one row, with its card between the text and the row.
    expect(readSource('../../app/channel/[id].tsx')).toContain('aboveFooter={footerInActions ? pollBlock : undefined}');
    expect(readSource('../../app/channel/[id].tsx')).toContain("const footerInActions = mode === 'authenticated';");
  });

  it('wraps a long channel name beside its icon instead of running off the screen', () => {
    const channel = readSource('../../app/channel/[id].tsx');
    expect(channel).toContain("titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },");
    expect(channel).toContain("title: { flexShrink: 1, fontSize: 26,");
    expect(channel).toContain('size={Math.round(22 * titleScale)} color={theme.mutedForeground} style={{ marginTop: Math.round(5 * titleScale) }} accessibilityElementsHidden');
    expect(channel).toContain('const titleScale = Math.min(fontScale, TITLE_TEXT_CAP);');
    expect(channel).toContain('maxFontSizeMultiplier={TITLE_TEXT_CAP}');
  });
});
