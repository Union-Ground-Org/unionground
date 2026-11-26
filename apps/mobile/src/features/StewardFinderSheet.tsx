import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Text, TextInput } from '../components/Text';

import { Body, Button, Card, Heading, StateMessage } from '../components/ui';
import { PREVIEW_STEWARD_ROSTER } from '../data/preview';
import {
  MEMBER_MESSAGE_MAX_LENGTH,
  normalizeMemberStewardRoster,
  startSelectedStewardConversation,
  type MemberStewardCard,
} from '../lib/memberOrgContract';
import { nativeStewardContactRoute } from '../lib/messageWorkflow';
import { useNativeUi } from '../lib/useNativeUi';
import { useReduceMotion } from '../lib/reduceMotion';
import { useWindowBottomInset } from '../lib/windowInsets';
import { memberOrgPort, memberOrgPortForSession } from '../services/memberOrgPort';
import { haptics } from '../services/haptics';
import { useApp } from '../state/AppProvider';
import { useTheme } from '../theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../theme/tokens';

import { typeface } from '../theme/typeface';
import { useHeldScreenScope } from '../lib/heldScreenScope';
export const STEWARD_FINDER_TITLE = 'Find my committee contact';
export const ORG_STRUCTURE_ROUTE = '/feature/org-structure';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; stewards: MemberStewardCard[] }
  | { kind: 'error'; message: string };

// The first message to a selected organizer who has no bound thread yet.
type Composer = {
  stewardID: string;
  draft: string;
  phase: 'editing' | 'sending' | 'error';
  message: string | null;
};

/**
 * The worker's own campaign organizers, with one Contact action per organizer and
 * the route on to the wider organization structure
 * (REQ-UG-MEMBER-FIND-MY-STEWARD-HOME-ENTRY-20260922). It is a sheet rather
 * than a sixth tab, and it opens from Home in both the prototype tiles and the
 * authenticated Quick actions.
 */
export function StewardFinderSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const actor = useApp();
  // Confirmed membership selection retires immediately, even without a dashboard or staff answer.
  const membership = useHeldScreenScope(actor.confirmedMembershipScope == null, [actor.session?.user.id], [actor.confirmedMembershipScope], true);
  const owner = useHeldScreenScope(actor.mode === 'booting' || (actor.mode === 'authenticated' && !actor.dashboard), [actor.session?.user.id, open, membership], [actor.mode, actor.dashboard?.member?.chapterID], true);
  const scope = useHeldScreenScope(actor.mode === 'booting' || (actor.mode === 'authenticated' && (!actor.dashboard || actor.staffScopeAvailable === false)), [owner], [actor.organizationID, actor.authorizedRoles], true);
  return <FullStewardFinderSheet key={scope} open={open} onClose={onClose} />;
}

function FullStewardFinderSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const theme = useTheme();
  const windowBottomInset = useWindowBottomInset();
  const reduceMotion = useReduceMotion();
  const { session, dashboard, mode, refresh, authorizedRoles, confirmedMembershipScope, organizationID, staffScopeAvailable } = useApp();
  const { t } = useNativeUi();
  const selection = confirmedMembershipScope?.length === 1 ? confirmedMembershipScope[0] : null;
  // Only use role-specific guidance after the confirmed scope and the data for it agree.
  const scopeReady = Boolean(selection?.organizationID) && selection?.organizationID === organizationID
    && selection?.chapterID === dashboard?.member.chapterID && staffScopeAvailable;
  const chapterless = selection?.chapterID === null;
  const canNameSteward = authorizedRoles.includes('admin');
  let emptyTitle = t('Committee information is unavailable right now');
  let emptyBody = t('Check again after confirming your membership.');
  if (scopeReady) {
    emptyTitle = chapterless ? t('You don’t have a campaign yet') : t('No committee member is assigned to your campaign yet');
    emptyBody = chapterless
      ? (canNameSteward
        ? t('Create a campaign on the website before assigning a committee member.')
        : t('Your organization’s administrator can help you join a campaign.'))
      : (canNameSteward
        ? t('On the website, open Roles, units and committees in Admin to assign a committee member.')
        : t('Your campaign administrator can name a committee member.'));
  }
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [composer, setComposer] = useState<Composer | null>(null);
  // Bumped on cancel and close, so a reply that lands after the worker backed
  // out never navigates them anywhere.
  const sendToken = useRef(0);
  useLayoutEffect(() => () => { sendToken.current += 1; }, []);

  const load = useCallback(async () => {
    if (mode === 'preview') {
      setState({ kind: 'ready', stewards: PREVIEW_STEWARD_ROSTER });
      return;
    }
    setState({ kind: 'loading' });
    try {
      setState({ kind: 'ready', stewards: normalizeMemberStewardRoster(await memberOrgPort.loadStewardRoster()) });
    } catch (error) {
      setState({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Your organizer list could not be loaded.',
      });
    }
  }, [mode]);

  // The roster is read when the sheet opens, not when Home mounts: a worker who
  // never opens it never sends the query.
  useEffect(() => { if (open) void load(); }, [open, load]);

  const close = () => {
    sendToken.current += 1;
    setComposer(null);
    onClose();
  };

  const openOrgStructure = () => {
    void haptics.select();
    close();
    router.push(ORG_STRUCTURE_ROUTE as never);
  };

  const contactSteward = (steward: MemberStewardCard) => {
    void haptics.select();
    // The selected organizer's own conversation, never another organizer's and
    // never the shared canonical thread.
    const route = nativeStewardContactRoute(dashboard?.conversations ?? [], steward.id);
    if (route.kind === 'conversation') {
      close();
      router.push(`/conversation/${route.conversationID}` as never);
      return;
    }
    // No thread with this organizer yet: write the first message here, bound to
    // them. Never the generic Messages composer, which starts an unbound thread.
    sendToken.current += 1;
    setComposer({ stewardID: steward.id, draft: '', phase: 'editing', message: null });
  };

  const cancelComposer = () => {
    sendToken.current += 1;
    setComposer(null);
  };

  const sendFirstMessage = async () => {
    if (!open || !composer || composer.phase === 'sending') return;
    if (mode === 'preview') {
      setComposer({ ...composer, phase: 'error', message: 'The demo cannot start a conversation with a specific organizer. Sign in to message them.' });
      return;
    }
    if (mode !== 'authenticated') return;
    const token = sendToken.current + 1;
    sendToken.current = token;
    setComposer({ ...composer, phase: 'sending', message: null });
    const port = memberOrgPortForSession(session);
    const { writer } = port;
    try {
      const started = await startSelectedStewardConversation(port, composer.stewardID, composer.draft);
      if (sendToken.current !== token) return;
      setComposer(null); // accepted; a missing continuation proof must never offer this draft again
      const current = await writer.isCurrent();
      if (!current) return;
      if (sendToken.current !== token) return;
      void haptics.success();
      // Pull the new binding into the inbox so the next Contact reuses it.
      await refresh().catch(() => undefined);
      const stillCurrent = await writer.isCurrent();
      if (!stillCurrent) return;
      if (sendToken.current !== token) return;
      close();
      router.push(`/conversation/${started.conversationID}` as never);
    } catch (error) {
      const proof = await writer.check();
      if (proof === 'changed') return;
      if (sendToken.current !== token) return;
      setComposer((current) => current && {
        ...current,
        phase: 'error',
        message: error instanceof Error ? error.message : 'Your message could not be sent.',
      });
    }
  };

  return (
    <Modal
      visible={open}
      transparent
      animationType={reduceMotion ? 'none' : 'slide'}
      onRequestClose={close}
      accessibilityViewIsModal
    >
      <View style={styles.scrim}>
        <Pressable accessibilityRole="button" accessibilityLabel="Close Find my committee contact" onPress={close} style={styles.scrimFill} />
        {/* #9608: the window's live bottom safe area (src/lib/windowInsets.ts).
            Opened from Home, a tab scene, the inset hook also counted the tab
            bar the modal covers and left a blank strip under the list. */}
        <View style={[styles.sheet, { backgroundColor: theme.background, paddingBottom: windowBottomInset + spacing.lg }]}>
          <View style={styles.sheetHead}>
            {/* #9608: the title shrinks and fits its longest word, so at the largest text size it wraps
                and never pushes the close control off the sheet. */}
            <View style={styles.sheetTitle}><Heading level={2} fitWords>{STEWARD_FINDER_TITLE}</Heading></View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close Find my committee contact"
              onPress={close}
              style={styles.closeButton}
            >
              <Ionicons name="close" size={22} color={theme.foreground} />
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.sheetBody}>
            {state.kind === 'loading' ? (
              <StateMessage
                compact
                title="Your organizer list is loading"
                body="Finding your organizers."
              />
            ) : state.kind === 'error' ? (
              <StateMessage
                compact
                title="Your organizer list could not be loaded"
                body={state.message}
                action={<Button label="Try again" onPress={() => { void load(); }} />}
              />
            ) : state.stewards.length === 0 ? (
              <StateMessage
                compact
                title={emptyTitle}
                body={emptyBody}
              />
            ) : (
              state.stewards.map((steward) => (
                <StewardCard
                  key={steward.id}
                  steward={steward}
                  onContact={() => contactSteward(steward)}
                  composer={composer?.stewardID === steward.id ? composer : null}
                  onDraftChange={(draft) => setComposer((current) => current && { ...current, draft, phase: current.phase === 'sending' ? 'sending' : 'editing', message: null })}
                  onSend={() => { void sendFirstMessage(); }}
                  onCancel={cancelComposer}
                />
              ))
            )}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="See org structure"
              onPress={openOrgStructure}
              style={({ pressed }) => [styles.secondaryAction, { borderColor: theme.border }, pressed ? { opacity: 0.82 } : null]}
            >
              <Ionicons name="git-branch-outline" size={20} color={theme.foreground} accessibilityElementsHidden />
              <Text style={[styles.secondaryActionText, { color: theme.foreground }]}>See org structure</Text>
              <Ionicons name="chevron-forward" size={16} color={theme.mutedForeground} accessibilityElementsHidden />
            </Pressable>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function stewardRoleLabel(roleLabel: string): string {
  // `roleLabel` is the machine role from member_roles, never a free-text title.
  return roleLabel === 'steward' ? 'Committee member' : roleLabel;
}

function StewardCard({ steward, onContact, composer, onDraftChange, onSend, onCancel }: {
  steward: MemberStewardCard;
  onContact: () => void;
  composer: Composer | null;
  onDraftChange: (draft: string) => void;
  onSend: () => void;
  onCancel: () => void;
}) {
  const theme = useTheme();
  const where = steward.chapterLabel ?? 'Your campaign';
  // Only the channels this organizer opted into. Shown, never dialled: campaign
  // work stays inside the app, so the app opens no mail or phone handler.
  const optedIn = [
    steward.contact.email === null ? null : `Email: ${steward.contact.email}`,
    steward.contact.phone === null ? null : `Phone: ${steward.contact.phone}`,
  ].filter((entry) => entry !== null);
  return (
    <Card>
      <Heading level={3}>{steward.name}</Heading>
      <Body muted>{`${stewardRoleLabel(steward.roleLabel)} · ${where}`}</Body>
      {steward.acceptsAppointments ? <Body muted>Takes one-on-ones</Body> : null}
      {optedIn.map((entry) => <Body key={entry} muted>{entry}</Body>)}
      {composer === null ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Contact ${steward.name}`}
          onPress={onContact}
          style={({ pressed }) => [styles.contact, { backgroundColor: theme.primary }, pressed ? { opacity: 0.82 } : null]}
        >
          <Text style={[styles.contactText, { color: theme.primaryForeground }]}>Contact</Text>
        </Pressable>
      ) : (
        <View style={styles.composer}>
          <TextInput
            accessibilityLabel={`First message to ${steward.name}`}
            placeholder={`Write to ${steward.name}`}
            placeholderTextColor={theme.quietForeground}
            value={composer.draft}
            onChangeText={onDraftChange}
            editable={composer.phase !== 'sending'}
            maxLength={MEMBER_MESSAGE_MAX_LENGTH}
            multiline
            style={[styles.composerInput, { color: theme.foreground, borderColor: theme.border, backgroundColor: theme.card }]}
          />
          {composer.phase === 'error' && composer.message !== null ? (
            <Text accessibilityRole="alert" style={[styles.composerError, { color: theme.destructive }]}>{composer.message}</Text>
          ) : null}
          <View style={styles.composerActions}>
            <Button label="Cancel" variant="secondary" onPress={onCancel} />
            <Button
              label="Send"
              onPress={onSend}
              busy={composer.phase === 'sending'}
              disabled={composer.draft.trim() === ''}
            />
          </View>
        </View>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  // Same scrim value the campaign rail uses, so the two overlays read as one
  // system rather than two depths.
  scrim: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(10,6,14,0.45)' },
  scrimFill: { flex: 1 },
  sheet: { borderTopLeftRadius: radii.sheetRadius, borderTopRightRadius: radii.sheetRadius, maxHeight: '80%', paddingHorizontal: spacing.lg, paddingTop: spacing.lg, gap: spacing.md },
  sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  sheetTitle: { flex: 1 },
  sheetBody: { gap: spacing.md, paddingBottom: spacing.md },
  closeButton: { minWidth: minimumTouchTarget, minHeight: minimumTouchTarget, alignItems: 'center', justifyContent: 'center' },
  contact: { minHeight: minimumTouchTarget, borderRadius: radii.md, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.lg },
  contactText: { fontSize: 16, lineHeight: 21, ...typeface.controlStrong },
  composer: { gap: spacing.sm },
  composerInput: {
    minHeight: minimumTouchTarget * 2,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 16,
    lineHeight: 21,
    textAlignVertical: 'top',
  },
  composerError: { fontSize: 14, lineHeight: 19 },
  composerActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm },
  secondaryAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: minimumTouchTarget,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  secondaryActionText: { flex: 1, fontSize: 16, lineHeight: 21, ...typeface.controlStrong },
});
