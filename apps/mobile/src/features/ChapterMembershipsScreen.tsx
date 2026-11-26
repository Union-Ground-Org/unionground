import { useBusinessDraftState } from '../lib/useBusinessDraftState';
import { useBusinessOperation, useBusinessSubjectState } from '../lib/useBusinessWriter';
import { checkBusinessContinuation } from '../lib/businessWriteContinuation';
import { useBusinessWriter, useBusinessState, useBusinessRequests } from '../lib/useBusinessWriter';
import { useEffect, useRef } from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';
import { Text, TextInput } from '../components/Text';

import { Body, Button, Card, Heading, Notice, Screen, StateMessage } from '../components/ui';
import {
  canAdministerChapterMemberships,
  chapterMembershipTargetReady,
  classifyMembershipFailure,
  completionStillCurrent,
  describeMembershipOutcome,
  DIRECTORY_MAX_PAGES,
  directoryReadIsCurrent,
  loadMoreIsContinuation,
  mergeDirectoryPages,
  MOBILE_CHAPTER_ROLES,
  retainedMemberSelection,
  type MembershipOutcomeKind,
  type MobileAdminChapter,
  type MobileAdminScope,
  type MobileChapterRole,
  type MobileChapterUnit,
  type MobileDirectoryCursor,
  type MobileDirectoryMember,
} from '../lib/chapterAdministration';
import { chapterMembershipCopy } from '../lib/chapterAdministrationCopy';
import { useAccessibilityAnnouncementQueue } from '../lib/announce';
import { withReadDeadline } from '../lib/readDeadline';
import { haptics } from '../services/haptics';
import {
  grantMobileChapterMembership,
  loadMobileAdminChapterScope,
  loadMobileChapterUnits,
  loadMobileStewardUnitAssignment,
  revokeMobileChapterMembership,
  searchMobileAdminMemberDirectory,
  setMobileChapterRole,
} from '../services/supabase';
import { useApp } from '../state/AppProvider';
import { useTheme } from '../theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../theme/tokens';
import { NativeUnitSettingsEditor } from './NativeUnitSettings';

import { typeface } from '../theme/typeface';
// While an audited change is in flight the target is frozen. A selection that
// could move under a running request would let the generic success notice
// appear beside a person, campaign, or role that is not the one the database
// recorded.
function ChipRow<Item extends { id: string; label: string }>({ label, items, selected, onSelect, empty, disabled = false }: {
  label: string;
  items: Item[];
  selected: string;
  onSelect: (id: string) => void;
  empty: string;
  disabled?: boolean;
}) {
  const theme = useTheme();
  return (
    <>
      <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{label}</Text>
      {items.length === 0 ? <Body muted>{empty}</Body> : (
        <View style={styles.wrap}>
          {items.map((item) => (
            <Pressable
              key={item.id}
              accessibilityRole="radio"
              accessibilityState={{ selected: selected === item.id, disabled }}
              accessibilityLabel={`${label}: ${item.label}`}
              disabled={disabled}
              onPress={() => { if (!disabled) onSelect(item.id); }}
              style={({ pressed }) => [styles.chip, {
                backgroundColor: selected === item.id ? theme.primary : theme.secondary,
                opacity: disabled && selected !== item.id ? 0.55 : pressed ? 0.82 : 1,
              }]}
            >
              <Text style={[styles.chipText, { color: selected === item.id ? theme.primaryForeground : theme.secondaryForeground }]}>{item.label}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </>
  );
}

/**
 * Membership administration is deliberately explicit, exactly as the web desk
 * is: an administrator names the person, names the campaign, and each button
 * is one audited RPC against that pair. Nothing here infers a target from the
 * current hat or the selected campaign, and nothing is applied locally before
 * the database has agreed to it.
 */
export function ChapterMembershipsScreen() {
  const writer = useBusinessWriter();
  const requests = useBusinessRequests(writer);
  const theme = useTheme();
  const { dashboard, mode, chapterRoles, organizationRoles, organizationID } = useApp();
  const copy = chapterMembershipCopy[dashboard?.member.language === 'es' ? 'es' : 'en'];
  // Membership administration reads the real directory and writes audited
  // rows. The preview origin has neither, and inventing a roster under an
  // audited control would be the one fixture this screen must never show.
  const live = mode === 'authenticated';
  const authorized = live && canAdministerChapterMemberships(chapterRoles, organizationRoles);
  const [scope, setScope] = useBusinessDraftState<MobileAdminScope | null>(null);
  const [scopeState, setScopeState] = useBusinessDraftState<'loading' | 'ready' | 'error'>('loading');
  const [scopeRevision, setScopeRevision] = useBusinessDraftState(0);
  const [query, setQuery] = useBusinessDraftState('');
  // The rows, cursor and depth on screen belong to `submittedQuery`, the
  // query that was actually searched; `query` is the draft in the field. A
  // draft that differs from the submitted query cannot be continued with the
  // submitted query's cursor, and a post-mutation refresh re-reads the
  // submitted query, never the draft.
  const [submittedQuery, setSubmittedQuery] = useBusinessDraftState<string | null>(null);
  const [members, setMembers] = useBusinessDraftState<MobileDirectoryMember[]>([]);
  const [nextCursor, setNextCursor] = useBusinessDraftState<MobileDirectoryCursor | null>(null);
  const [pagesLoaded, setPagesLoaded] = useBusinessDraftState(0);
  // Every directory read carries the sequence it started under; a read that
  // finishes after a newer one started installs nothing.
  const readSequence = useRef(0);
  const [userID, setUserID] = useBusinessDraftState('');
  const [chapterID, setChapterID] = useBusinessDraftState('');
  const [role, setRole] = useBusinessDraftState<MobileChapterRole>('steward');
  const [unitID, setUnitID] = useBusinessDraftState('');
  const [unitRevision, setUnitRevision] = useBusinessDraftState(0);
  const [unitResult, setUnitResult] = useBusinessDraftState<{ chapterID: string; userID: string; phase: 'loading' | 'ready' | 'error'; units: MobileChapterUnit[]; legacy: boolean }>({ chapterID: '', userID: '', phase: 'loading', units: [], legacy: false });
  const [busy, setBusy] = useBusinessState<string | null>(null);
  const [operate] = useBusinessOperation<typeof busy>(setBusy, null);
  const [message, setMessage] = useBusinessDraftState<{ tone: 'notice' | 'error'; text: string } | null>(null);
  const [confirmingRevoke, setConfirmingRevoke] = useBusinessDraftState(false);
  const [needsRefresh, setNeedsRefresh] = useBusinessSubjectState(organizationID, false);
  // Every outcome below arrives under a button that still holds focus.
  // `accessibilityLiveRegion` is Android-only, so each one is also spoken
  // through the shared queue; the owner identity is the selected person, so
  // changing the target or leaving the screen cancels anything still pending.
  const queueAnnouncement = useAccessibilityAnnouncementQueue(`chapter-memberships:${userID || 'none'}`);
  const mounted = useRef(true);
  const target = useRef({ userID: '', chapterID: '' });
  target.current = { userID, chapterID };
  useEffect(() => () => { mounted.current = false; }, []);
  const selected = members.find((member) => member.userID === userID) ?? null;
  const chapters: MobileAdminChapter[] = scope?.chapters ?? [];
  const unitResultCurrent = unitResult.chapterID === chapterID && unitResult.userID === userID;
  const units = unitResultCurrent ? unitResult.units : [];
  const unitPhase = unitResultCurrent ? unitResult.phase : 'loading';
  useEffect(() => {
    setUnitID('');
    if (!authorized || !chapterID || role !== 'steward') return undefined;
    let active = true;
    setUnitResult({ chapterID, userID, phase: 'loading', units: [], legacy: false });
    void Promise.all([loadMobileChapterUnits(chapterID), userID ? loadMobileStewardUnitAssignment(userID, chapterID) : Promise.resolve(null)]).then(([choices, assignment]) => {
      if (active) setUnitResult({ chapterID, userID, phase: 'ready', units: choices, legacy: assignment?.legacyChapterCoverage === true });
    }).catch(() => { if (active) setUnitResult({ chapterID, userID, phase: 'error', units: [], legacy: false }); });
    return () => { active = false; };
  }, [authorized, chapterID, userID, role, unitRevision, setUnitID, setUnitResult]);

  function report(kind: MembershipOutcomeKind, name: string) {
    const next = describeMembershipOutcome(kind, copy, name);
    setMessage(next);
    queueAnnouncement(next.text);
  }

  useEffect(() => {
    if (!authorized) { setScopeState('ready'); return () => undefined; }
    let active = true;
    setScopeState('loading');
    void withReadDeadline(loadMobileAdminChapterScope()).then((next) => {
      if (!active) return;
      setScope(next);
      setChapterID((current) => (next?.chapters ?? []).some((chapter) => chapter.id === current)
        ? current
        : next?.chapters[0]?.id ?? '');
      setScopeState('ready');
    }).catch(() => {
      if (active) setScopeState('error');
    });
    return () => { active = false; };
  }, [authorized, scopeRevision, setScopeState, setScope, setChapterID]);

  // Read the directory from the first page, following the cursor for as many
  // pages as `depth` names (bounded), so a refresh after a mutation shows the
  // same reach the administrator had paged to. The chosen person is kept only
  // if the re-read still holds them; nobody is retargeted silently.
  // Read `forQuery` from its first page, following the cursor for as many
  // pages as `depth` names (bounded), so a refresh after a mutation shows the
  // same reach the administrator had paged to. Returns false, installing
  // nothing, when a newer read started meanwhile. The chosen person is kept
  // only if the re-read still holds them; nobody is retargeted silently.
  async function readDirectory(forQuery: string, depth: number): Promise<boolean> {
    const ticket = requests.capture();
    if (!ticket.isCurrent()) return false;
    const startedSequence = ++readSequence.current;
    let cursor: MobileDirectoryCursor | null = null;
    let collected: MobileDirectoryMember[] = [];
    let pages = 0;
    do {
      const page = await searchMobileAdminMemberDirectory(forQuery, cursor);
      if (!ticket.isCurrent() || !directoryReadIsCurrent({ startedSequence, currentSequence: readSequence.current })) return false;
      collected = mergeDirectoryPages(collected, page.members);
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < Math.min(depth, DIRECTORY_MAX_PAGES));
    setSubmittedQuery(forQuery);
    setMembers(collected);
    setNextCursor(cursor);
    setPagesLoaded(pages);
    setUserID((current) => retainedMemberSelection(collected, current));
    setNeedsRefresh(false);
    return true;
  }

  // Editing the field makes the draft a different query from the one the
  // rows belong to: the cursor is no longer a continuation of anything the
  // operator can see, so Load more is withdrawn until Search runs again.
  function editQuery(next: string) {
    setQuery(next);
    if (submittedQuery !== null && next.trim() !== submittedQuery) setNextCursor(null);
  }

  async function search() {
    await operate('search', async () => {
    if (busy) return;
    const forQuery = query.trim();
     setMessage(null);
    try {
      if (await readDirectory(forQuery, 1)) setConfirmingRevoke(false);
    } catch {
      report('search-error', '');
    }

    });
  }

  // The next page under the cursor the last page handed back, for the query
  // that produced it. The list is bounded; past the bound the operator is
  // asked to narrow the search.
  async function loadMore() {
    await operate('more', async () => {
    if (busy || !loadMoreIsContinuation({ draft: query, submitted: submittedQuery, cursor: nextCursor })) return;
    if (submittedQuery === null || nextCursor === null) return;
    if (pagesLoaded >= DIRECTORY_MAX_PAGES) { report('directory-limit', ''); return; }
    const ticket = requests.capture();
    if (!ticket.isCurrent()) return;
    const startedSequence = ++readSequence.current;
     setMessage(null);
    try {
      const page = await searchMobileAdminMemberDirectory(submittedQuery, nextCursor);
      if (!ticket.isCurrent() || !directoryReadIsCurrent({ startedSequence, currentSequence: readSequence.current })) return;
      setMembers((current) => mergeDirectoryPages(current, page.members));
      setNextCursor(page.nextCursor);
      setPagesLoaded((current) => current + 1);
      if (page.nextCursor === null && pagesLoaded + 1 >= DIRECTORY_MAX_PAGES) report('directory-limit', '');
    } catch {
      report('search-error', '');
    }

    });
  }

  function confirmRoleChange(granting: boolean) {
    const roleName = copy.roleNames[role];
    const run = () => {
      void (granting
        ? act('role-grant', () => setMobileChapterRole(writer, userID, chapterID, role, true, unitID), 'role-granted', 'refused-role', 'unconfirmed-role')
        : act('role-revoke', () => setMobileChapterRole(writer, userID, chapterID, role, false), 'role-revoked', 'refused-role', 'unconfirmed-role'));
    };
    const unitName = granting && role === 'steward' ? units.find((unit) => unit.id === unitID)?.name : null;
    Alert.alert(copy.confirmRoleTitle(selected?.fullName ?? '', roleName, granting), copy.confirmRoleBody(roleName, granting) + (unitName ? `\n${copy.unitLabel}: ${unitName}` : ''), [
      { text: copy.cancel, style: 'cancel' },
      { text: granting ? copy.grantRole : copy.revokeRole, style: granting ? 'default' : 'destructive', onPress: run },
    ]);
  }

  async function refreshAccepted() {
    await operate('refresh', async () => {
      const ticket = requests.capture();
      if (await checkBusinessContinuation(writer, ticket.isCurrent) !== 'current') return;
      try {
        if (await readDirectory(submittedQuery ?? '', Math.max(1, pagesLoaded))) {
          setUnitID('');
          setUnitRevision((revision) => revision + 1);
          setMessage(null);
        }
      } catch { if (ticket.isCurrent()) report('refresh-failed', ''); }
    });
  }

  async function act(
    key: string,
    work: () => Promise<void>,
    success: MembershipOutcomeKind,
    refused: MembershipOutcomeKind,
    unconfirmed: MembershipOutcomeKind,
  ) {
    await operate(key, async () => {
    if (busy || needsRefresh || !chapterMembershipTargetReady(userID, chapterID)) return;
    const startedFor = { userID, chapterID };
    const name = selected?.fullName ?? '';
    const depth = Math.max(1, pagesLoaded);
    // The refresh re-reads the result set the rows belong to, never the draft.
    const forQuery = submittedQuery ?? '';
     setMessage(null);
    // An outcome is announced only for the target it was started for, on a
    // screen that is still here; a completion that arrives after either
    // changed says nothing rather than announcing success for someone else.
    const ticket = requests.capture();
    const current = () => ticket.isCurrent() && completionStillCurrent({ startedFor, current: target.current, mounted: mounted.current });
    try {
      await work();
      setNeedsRefresh(true);
      if (!current()) return;
      setUnitID('');
      setConfirmingRevoke(false);
      report(success, name);
      const proof = await checkBusinessContinuation(writer, current);
      if (proof === 'changed') return;
      if (proof === 'unavailable') { report('stale', name); return; }
      void haptics.success();
      // The database has agreed, so the rows on screen are now stale: a
      // removed role would still read as granted, and a worker whose last
      // visible membership just ended would stay selectable. A directory
      // read that fails afterwards does not undo the recorded change, so it
      // reports staleness rather than the mutation failure.
      try {
        await readDirectory(forQuery, depth);
      } catch {
        if (current()) report('stale', name);
      }
    } catch (failure) {
      if (!current()) return;
      if (classifyMembershipFailure(failure) === 'refused') {
        report(refused, name);
        return;
      }
      // The transport failed after the request may have reached the
      // database: the change may exist. Say so, then TRY to re-read the
      // directory; the message never claims the re-read happened, and a
      // re-read that fails is reported as exactly that.
      report(unconfirmed, name);
      if (await checkBusinessContinuation(writer, current) !== 'current') return;
      try {
        await readDirectory(forQuery, depth);
      } catch {
        if (current()) report('refresh-failed', name);
      }
    } finally {
      if (mounted.current) {  if (await checkBusinessContinuation(writer, current) === 'current') setUnitRevision((current) => current + 1); }
    }

    });
  }

  if (!live) {
    return <Screen><StateMessage title={copy.title} body={copy.previewBody} /></Screen>;
  }
  if (!authorized) {
    return <Screen><StateMessage title={copy.deniedTitle} body={copy.deniedBody} /></Screen>;
  }
  if (scopeState === 'loading') {
    return <Screen><StateMessage title={copy.loadingTitle} body={copy.loadingBody} /></Screen>;
  }

  const targetReady = chapterMembershipTargetReady(userID, chapterID);
  return (
    <Screen>
      <Heading fitWords={scopeState === 'error'}>{copy.title}</Heading>
      {scopeState === 'error' ? <>
        <Notice fitWords>{copy.scopeError}</Notice>
        <Button label={copy.retryScope} variant="secondary" fitWords onPress={() => setScopeRevision((value) => value + 1)} />
      </> : null}
      <Body muted>{copy.subtitle}</Body>
      {message && (!needsRefresh || message.text !== copy.staleDirectory) ? (
        // Android reads the region; iOS is served by the announcement queue.
        <Card>
          <View accessibilityLiveRegion="polite" accessibilityRole={message.tone === 'error' ? 'alert' : 'text'}>
            {message.tone === 'error'
              ? <Body style={{ color: theme.destructive }}>{message.text}</Body>
              : <Body>{message.text}</Body>}
          </View>
        </Card>
      ) : null}
      {needsRefresh ? <><Body>{copy.staleDirectory}</Body><Button label={copy.refresh} variant="secondary" disabled={busy !== null} onPress={() => { void refreshAccepted(); }} /></> : null}
      <Card>
        {scope && scope.scope === 'chapter' ? <Body muted>{copy.chapterScopeBoundary}</Body> : null}
        <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{copy.searchLabel}</Text>
        <TextInput
          accessibilityLabel={copy.searchLabel}
          keyboardAppearance={theme.appearance}
          value={query}
          onChangeText={editQuery}
          placeholder={copy.searchPlaceholder}
          placeholderTextColor={theme.quietForeground}
          style={[styles.input, { color: theme.foreground, backgroundColor: theme.input, borderColor: theme.border }]}
        />
        <Button
          label={busy === 'search' ? copy.searching : copy.search}
          variant="secondary"
          disabled={busy !== null || query.trim().length === 1}
          onPress={() => { void search(); }}
        />
        {query.trim().length === 1 ? <Body muted>{copy.searchTooShort}</Body> : null}
        {submittedQuery !== null && query.trim() !== submittedQuery ? <Body muted>{copy.resultsFor(submittedQuery)}</Body> : null}
        {nextCursor !== null ? (
          <>
            <Body muted>{copy.membersTruncated}</Body>
            <Button
              label={busy === 'more' ? copy.loadingMore : copy.loadMore}
              variant="secondary"
              disabled={busy !== null}
              onPress={() => { void loadMore(); }}
            />
          </>
        ) : null}
        {submittedQuery !== null ? <ChipRow
          label={copy.memberLabel}
          items={members.map((member) => ({ id: member.userID, label: member.fullName }))}
          selected={userID}
          onSelect={(id) => { setUserID(id); setConfirmingRevoke(false); }}
          empty={copy.membersEmpty}
          disabled={busy !== null}
        /> : null}
        {selected ? (
          <Body muted>{copy.memberContext(
            selected.chapterName || selected.chapterID || copy.noHomeChapter,
            selected.roles.length ? selected.roles.map((item) => item === 'vp' ? copy.unscopedVpLabel : copy.roleNames[item]).join(', ') : copy.noRoles,
          )}</Body>
        ) : null}
        <ChipRow
          label={copy.chapterLabel}
          items={chapters.map((chapter) => ({ id: chapter.id, label: chapter.name }))}
          selected={chapterID}
          onSelect={(id) => { setChapterID(id); setConfirmingRevoke(false); }}
          empty={copy.chaptersEmpty}
          disabled={busy !== null}
        />
      </Card>
      <Card>
        <Heading level={3}>{copy.memberLabel}</Heading>
        <View style={styles.actions}>
          <Button
            label={busy === 'grant' ? copy.working : copy.grantMembership}
            disabled={busy !== null || needsRefresh || !targetReady}
            onPress={() => {
              void act('grant', () => grantMobileChapterMembership(writer, userID, chapterID), 'granted', 'refused-membership', 'unconfirmed-membership');
            }}
          />
          <Button
            label={copy.revokeMembership}
            variant="danger"
            disabled={busy !== null || needsRefresh || !targetReady}
            onPress={() => {
              setConfirmingRevoke(true);
              queueAnnouncement(copy.confirmRevokeTitle(selected?.fullName ?? ''));
            }}
          />
        </View>
        {confirmingRevoke ? (
          <View accessibilityRole="alert" accessibilityLiveRegion="assertive" style={styles.actions}>
            <Heading level={3}>{copy.confirmRevokeTitle(selected?.fullName ?? '')}</Heading>
            <Body muted>{copy.confirmRevokeBody}</Body>
            <Button
              label={busy === 'revoke' ? copy.working : copy.confirmRevoke}
              variant="danger"
              disabled={busy !== null || needsRefresh}
              onPress={() => {
                void act('revoke', () => revokeMobileChapterMembership(writer, userID, chapterID), 'revoked', 'refused-membership', 'unconfirmed-membership');
              }}
            />
            <Button label={copy.cancel} variant="secondary" disabled={busy !== null} onPress={() => setConfirmingRevoke(false)} />
          </View>
        ) : null}
      </Card>
      <Card>
        <Heading level={3}>{copy.roleLabel}</Heading>
        <Body muted>{copy.roleBoundary}</Body>
        <ChipRow
          label={copy.roleLabel}
          items={MOBILE_CHAPTER_ROLES.map((item) => ({ id: item, label: copy.roleNames[item] }))}
          selected={role}
          onSelect={(id) => setRole(id as MobileChapterRole)}
          empty={copy.noRoles}
          disabled={busy !== null}
        />
        {role === 'steward' && <>
          {unitPhase === 'loading' && <Body muted>{copy.unitsLoading}</Body>}
          {unitPhase === 'error' && <><Body>{copy.unitsUnavailable}</Body><Button label={copy.reloadUnits} variant="secondary" disabled={busy !== null} onPress={() => setUnitRevision((current) => current + 1)} /></>}
          {unitPhase === 'ready' && <>
            {unitResult.legacy && <Body>{copy.legacyCoverage}</Body>}
            <Body muted>{copy.unitHelp}</Body>
            <ChipRow label={copy.unitLabel} items={units.map((unit) => ({ id: unit.id, label: unit.name }))} selected={unitID} onSelect={setUnitID} empty={copy.noUnits} disabled={busy !== null} />
          </>}
        </>}
        <View style={styles.actions}>
          <Button
            label={busy === 'role-grant' ? copy.working : copy.grantRole}
            disabled={busy !== null || needsRefresh || !targetReady || (role === 'steward' && (unitPhase !== 'ready' || !units.some((unit) => unit.id === unitID)))}
            onPress={() => confirmRoleChange(true)}
          />
          <Button
            label={busy === 'role-revoke' ? copy.working : copy.revokeRole}
            variant="secondary"
            disabled={busy !== null || needsRefresh || !targetReady}
            onPress={() => confirmRoleChange(false)}
          />
        </View>
      </Card>
      <NativeUnitSettingsEditor key={chapterID} chapterId={chapterID} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  fieldLabel: { fontSize: 15, lineHeight: 20, ...typeface.controlStrong },
  input: { minHeight: minimumTouchTarget, borderWidth: 1, borderRadius: radii.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, fontSize: 16, lineHeight: 22 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: { minHeight: minimumTouchTarget, borderRadius: radii.pill, paddingHorizontal: spacing.md, justifyContent: 'center' },
  chipText: { fontSize: 14, lineHeight: 18, ...typeface.controlStrong },
  actions: { gap: spacing.sm },
});
