import { useBusinessDraftState } from '../lib/useBusinessDraftState';
import { useBusinessOperation } from '../lib/useBusinessWriter';
import { DisabledStateBoundary } from '../components/DisabledStateBoundary';
import { useEffect, useRef } from 'react';
import { useBusinessWriter, useBusinessState, useBusinessRequests } from '../lib/useBusinessWriter';
import { Pressable, StyleSheet, Switch, View } from 'react-native';
import { Text, TextInput } from '../components/Text';

import { Body, Button, Card, Heading, Notice } from '../components/ui';
import {
  ENGAGEMENT_EMAIL_KEYS,
  DISPLAYED_NOTIFICATION_TOPIC_KEYS,
  QUIET_HOURS_TIME_ZONES,
  engagementEmailPatch,
  notificationPreferencesCopy,
  quietClockValid,
  quietHoursPatch,
  topicsPatch,
  type EngagementEmailKey,
  type NotificationPreferences,
  type NotificationPreferencesPatch,
  type NotificationTopic,
} from '../lib/notificationPreferences';
import { loadMemberNotificationPreferences, saveMemberNotificationPreferences } from '../services/supabase';
import { finishStaffGuide, liveStaffGuideHat } from './guideLayers/staffGuidesData';
import { useApp } from '../state/AppProvider';
import { useTheme } from '../theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../theme/tokens';

import { typeface } from '../theme/typeface';
/**
 * Topics, Do not disturb and quiet hours for a phone-only member: the same
 * member_profiles columns web Settings writes, so muting a topic or setting a
 * quiet window here holds for email, web push and native push alike.
 * UX-UG-NATIVE-ACCOUNT-ONLY-TOGGLES-THIS-DEVICE-PUSH-TOPIC-PREFS-DND-QUIET-HOURS-20260921.
 */
export function NotificationPreferencesCard() {
  const writer = useBusinessWriter();
  const requests = useBusinessRequests(writer);
  const theme = useTheme();
  const { dashboard, memberLanguage, mode, chosenStaffRole, authorizedRoles, duesContext } = useApp();
  const copy = notificationPreferencesCopy[(dashboard?.member.language ?? memberLanguage) === 'es' ? 'es' : 'en'];
  const userID = dashboard?.member.id ?? null;
  const [saved, setSaved] = useBusinessDraftState<NotificationPreferences | null>(null);
  const [draft, setDraft] = useBusinessDraftState<NotificationPreferences | null>(null);
  const [loadFailed, setLoadFailed] = useBusinessDraftState(false);
  const [saving, setSaving] = useBusinessState(false);
  const [operate] = useBusinessOperation<typeof saving>(setSaving, false);
  const [notice, setNotice] = useBusinessDraftState<{ failed: boolean; text: string } | null>(null);

  const reads = useRef(0);
  useEffect(() => {
    const at = ++reads.current;
    if (mode !== 'authenticated' || !userID) return;
    let active = true;
    setLoadFailed(false);
    void loadMemberNotificationPreferences(userID)
      .then((value) => { if (active && at === reads.current) { setSaved(value); setDraft(value); } })
      .catch(() => { if (active && at === reads.current) setLoadFailed(true); });
    return () => { active = false; };
  }, [mode, userID, requests, setLoadFailed, setSaved, setDraft]);


  if (mode !== 'authenticated' || !userID) return null;

  async function save(patch: Partial<NotificationPreferencesPatch>, optimistic: NotificationPreferences) {
    await operate(true, async () => {
    if (!userID || !saved) return;
    const ticket = requests.capture();
    const previous = saved;
    setDraft(optimistic);

    setNotice(null);
    try {
      const confirmed = await saveMemberNotificationPreferences(userID, patch);
      if (ticket.isCurrent()) reads.current += 1;
      setSaved(confirmed);
      setDraft((current) => (current ? { ...current, topics: confirmed.topics, engagementEmail: confirmed.engagementEmail, dndEnabled: confirmed.dndEnabled } : confirmed));
      setNotice({ failed: false, text: copy.saved });
      // REQ-UG-ONBOARDING-GUIDE-ENGINE-PORT-STEP4-20261029: saved
      // notification choices finish a staff hat's Settings feature guide.
      if (await writer.check() === 'current' && ticket.isCurrent()) await finishStaffGuide(writer, liveStaffGuideHat({ mode, chosenStaffRole, authorizedRoles }), 'settings');
    } catch {
      if (!ticket.isCurrent()) return;
      setDraft((current) => (current ? { ...current, topics: previous.topics, engagementEmail: previous.engagementEmail, dndEnabled: previous.dndEnabled } : previous));
      setNotice({ failed: true, text: copy.saveError });
    }

    });
  }

  function toggleTopic(topic: NotificationTopic, enabled: boolean) {
    if (!draft) return;
    const topics = { ...draft.topics, [topic]: enabled };
    void save(topicsPatch(topics), { ...draft, topics });
  }

  function toggleEngagementEmail(key: EngagementEmailKey, enabled: boolean) {
    if (!draft) return;
    const engagementEmail = { ...draft.engagementEmail, [key]: enabled };
    void save(engagementEmailPatch(draft.topics, key, enabled), { ...draft, engagementEmail });
  }

  function toggleDnd(enabled: boolean) {
    if (!draft) return;
    void save({ dnd_enabled: enabled }, { ...draft, dndEnabled: enabled });
  }

  const quietValid = draft ? quietClockValid(draft.quietHoursStart) && quietClockValid(draft.quietHoursEnd) : false;
  const zones: string[] = draft && !(QUIET_HOURS_TIME_ZONES as readonly string[]).includes(draft.quietHoursTimezone)
    ? [draft.quietHoursTimezone, ...QUIET_HOURS_TIME_ZONES]
    : [...QUIET_HOURS_TIME_ZONES];

  return (
    <Card>
      <Heading level={2}>{copy.title}</Heading>
      <Body muted>{copy.body}</Body>
      {loadFailed ? <Notice>{copy.loadError}</Notice> : null}
      {!draft && !loadFailed ? <Body muted>{copy.loading}</Body> : null}
      {draft ? (
        <>
          {DISPLAYED_NOTIFICATION_TOPIC_KEYS.map((topic) => (
            <PreferenceSwitch key={topic} label={copy.topics[topic]} value={draft.topics[topic]} disabled={saving} onChange={(value) => toggleTopic(topic, value)} />
          ))}
          <Heading level={3}>{copy.unionEmail}</Heading>
          <Body muted>{copy.unionEmailBody}</Body>
          {ENGAGEMENT_EMAIL_KEYS.map((key) => (
            <PreferenceSwitch key={key} label={copy.engagementEmail[key]} value={draft.engagementEmail[key]} disabled={saving} onChange={(value) => toggleEngagementEmail(key, value)} />
          ))}
          <PreferenceSwitch label={copy.dnd} body={copy.dndBody} value={draft.dndEnabled} disabled={saving} onChange={toggleDnd} />
          <Heading level={3}>{copy.quietTitle}</Heading>
          <Body muted>{copy.quietBody}</Body>
          <ClockField label={copy.quietStart} value={draft.quietHoursStart} onChangeText={(value) => setDraft({ ...draft, quietHoursStart: value })} />
          <ClockField label={copy.quietEnd} value={draft.quietHoursEnd} onChangeText={(value) => setDraft({ ...draft, quietHoursEnd: value })} />
          {quietValid ? null : <Body style={{ color: theme.destructive }}>{copy.quietInvalid}</Body>}
          <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{copy.timezone}</Text>
          <View accessibilityRole="radiogroup" accessibilityLabel={copy.timezone} style={styles.zoneList}>
            {zones.map((zone) => {
              const selected = draft.quietHoursTimezone === zone;
              return (
                <Pressable
                  key={zone}
                  accessibilityRole="radio"
                  accessibilityState={{ selected, checked: selected }}
                  onPress={() => setDraft({ ...draft, quietHoursTimezone: zone })}
                  style={[styles.zone, { borderColor: selected ? theme.primary : theme.border, backgroundColor: selected ? theme.secondary : theme.card }]}
                >
                  <Text style={[styles.zoneText, { color: selected ? theme.secondaryForeground : theme.foreground }]}>
                    {copy.zones[zone as (typeof QUIET_HOURS_TIME_ZONES)[number]] ?? zone}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <PreferenceSwitch label={copy.allowUrgent} value={draft.urgentNotificationsEnabled} onChange={(value) => setDraft({ ...draft, urgentNotificationsEnabled: value })} />
          <Button
            label={saving ? copy.saving : copy.saveQuiet}
            busy={saving}
            disabled={saving || !quietValid}
            onPress={() => { void save(quietHoursPatch(draft), draft); }}
          />
        </>
      ) : null}
      {notice ? (
        notice.failed
          ? <Notice>{notice.text}</Notice>
          : <View accessibilityLiveRegion="polite"><Body>{notice.text}</Body></View>
      ) : null}
    </Card>
  );
}

function PreferenceSwitch({ label, body, value, onChange, disabled = false }: { label: string; body?: string; value: boolean; disabled?: boolean; onChange: (value: boolean) => void }) {
  const theme = useTheme();
  return (
    <View style={styles.switchRow}>
      <View style={styles.flex}>
        <Text style={[styles.switchLabel, { color: theme.foreground }]}>{label}</Text>
        {body ? <Body muted>{body}</Body> : null}
      </View>
      <DisabledStateBoundary disabled={disabled} accessibilityRole="switch" accessibilityLabel={label} checked={value}>
      <Switch
        accessibilityLabel={label}
        style={{ minWidth: minimumTouchTarget, minHeight: minimumTouchTarget }}
        value={value}
        disabled={disabled}
        accessibilityState={{ disabled }}
        onValueChange={onChange}
        trackColor={{ false: theme.muted, true: theme.primary }}
        thumbColor={value ? theme.primaryForeground : theme.mutedForeground}
      />
      </DisabledStateBoundary>
    </View>
  );
}

function ClockField({ label, value, onChangeText }: { label: string; value: string; onChangeText: (value: string) => void }) {
  const theme = useTheme();
  return (
    <View style={styles.field}>
      <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        autoCorrect={false}
        inputMode="numeric"
        keyboardAppearance={theme.appearance}
        maxLength={5}
        placeholder="22:00"
        placeholderTextColor={theme.quietForeground}
        selectionColor={theme.primary}
        value={value}
        onChangeText={onChangeText}
        style={[styles.textInput, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  switchRow: { minHeight: minimumTouchTarget, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  switchLabel: { fontSize: 16, lineHeight: 22, ...typeface.control },
  field: { gap: spacing.sm },
  fieldLabel: { fontSize: 15, lineHeight: 20, ...typeface.controlStrong },
  textInput: { minHeight: minimumTouchTarget, borderWidth: 1, borderRadius: radii.md, paddingHorizontal: spacing.md, fontSize: 16, lineHeight: 22 },
  zoneList: { gap: spacing.sm },
  zone: { minHeight: minimumTouchTarget, borderWidth: 1, borderRadius: radii.md, paddingHorizontal: spacing.md, justifyContent: 'center' },
  zoneText: { fontSize: 15, lineHeight: 20, ...typeface.control },
});
