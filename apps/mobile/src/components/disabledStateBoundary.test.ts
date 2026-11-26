import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Source contract for the iOS disabled-state boundary.
//
// BUG-UG-MOBILE-IOS-SWITCH-DISABLED-STATE-NOT-EXPOSED-20260918 (c15) and
// BUG-UG-MOBILE-IOS-COMPASS-QUESTION-FIELD-NOT-DIMMED-WHEN-PAUSED-20260918
// (c16): React Native's `Switch` and multiline `TextInput` do not carry
// `disabled` / `editable={false}` + `accessibilityState.disabled` onto the
// native control VoiceOver focuses. The repair is one shared boundary that owns
// the disabled state and hides the native control while it is unavailable.
// These assertions fail if either call site stops routing its availability
// through the boundary, or if the boundary stops stating the mechanism.

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const boundary = read('./DisabledStateBoundary.tsx');
const account = read('../../app/(tabs)/account.tsx');
const compass = read('./CompassPanel.tsx');

describe('DisabledStateBoundary: the mechanism is stated once', () => {
  it('names both records and the React Native limitation', () => {
    expect(boundary).toContain('BUG-UG-MOBILE-IOS-SWITCH-DISABLED-STATE-NOT-EXPOSED-20260918');
    expect(boundary).toContain('BUG-UG-MOBILE-IOS-COMPASS-QUESTION-FIELD-NOT-DIMMED-WHEN-PAUSED-20260918');
    expect(boundary).toMatch(/UISwitch \/ UITextView/);
    expect(boundary).toContain('export function DisabledStateBoundary(');
  });

  it('renders children bare while enabled, so an available Switch stays an operable switch', () => {
    expect(boundary).toContain('if (!disabled) return <>{children}</>;');
  });

  it('owns the disabled state on an accessible host and hides the native control on both platforms', () => {
    expect(boundary).toMatch(/<View\s+accessible\s+accessibilityRole=\{accessibilityRole\}/);
    expect(boundary).toContain('accessibilityState={checked === undefined ? { disabled: true } : { disabled: true, checked }}');
    expect(boundary).toContain('<View accessibilityElementsHidden importantForAccessibility="no-hide-descendants"');
  });
});

describe('c15: the Account biometric switch tracks availability through the boundary', () => {
  it('wraps the biometric Switch and mirrors its availability and on/off state', () => {
    expect(account).toContain("import { DisabledStateBoundary } from '../../src/components/DisabledStateBoundary';");
    expect(account).toMatch(
      /<DisabledStateBoundary\s+disabled=\{!biometricAvailable\}\s+accessibilityRole="switch"\s+accessibilityLabel=\{t\("Biometric re-lock, Unavailable: this phone has no Face ID, Touch ID or fingerprint set up\."\)\}\s+checked=\{biometricLockEnabled\}\s*>\s*<Switch[\s\S]*?disabled=\{!biometricAvailable\}\s+value=\{biometricLockEnabled\}[\s\S]*?\/>\s*<\/DisabledStateBoundary>/,
    );
  });

  it('keeps the native Switch refusing the toggle itself', () => {
    expect(account).toContain('accessibilityState={{ disabled: !biometricAvailable }}');
    expect(account).toContain('onValueChange={(value) => { void toggleBiometrics(value); }}');
  });

  it('audit: every apps/mobile Switch that pairs disabled with accessibilityState.disabled sits inside the boundary', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const files = [...walk(join(root, 'app')), ...walk(join(root, 'src'))];
    const switchSites: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const matches = source.match(/<Switch[\s>]/g) ?? [];
      for (let index = 0; index < matches.length; index += 1) switchSites.push(file.slice(root.length));
    }
    // Four Switch sites: the biometric row; the notification-preference row
    // and the learning-content toggle row
    // (REQ-UG-QUOTES-MINI-LESSONS-20260928), which are never disabled
    // and so need no boundary; and the offline-availability row, which can be
    // disabled and sits inside its own boundary. Another site must be added to
    // this list deliberately, with its own boundary if it can be disabled.
    // Account also carries the Product analytics switch
    // (REQ-UG-VISIBLE-ANALYTICS-OPT-OUT-20261016), never disabled.
    // The case-topic cards (#7043) share one Switch, disabled while saving and
    // inside its boundary, as are the booking-hours switch (#9082) and the
    // meeting form's check-in switch (#9099).
    expect(switchSites.sort()).toEqual([
      'app/(tabs)/account.tsx',
      'app/(tabs)/account.tsx',
      'src/features/AppointmentHoursCard.tsx',
      'src/features/CaseRowTopicCards.tsx',
      'src/features/NotificationPreferencesCard.tsx',
      'src/features/OfflineAvailabilityScreen.tsx',
      'src/features/PulseScorePrivacyCard.tsx',
      'src/features/ScheduleMeetingCard.tsx',
      'src/features/learning/LearningControls.tsx',
    ]);
    expect(account.match(/<Switch[\s>]/g)).toHaveLength(2);
    expect(account.match(/<DisabledStateBoundary[\s>]/g)).toHaveLength(1);
    const analyticsSwitch = account.match(/<Switch\s+accessibilityLabel=\{t\("Product analytics"\)\}[\s\S]*?\/>/)?.[0] ?? '';
    expect(analyticsSwitch).toContain('onValueChange={(value) => { void toggleProductAnalytics(value); }}');
    expect(analyticsSwitch).not.toMatch(/disabled/);
    const preferenceSwitch = readFileSync(join(root, 'src/features/NotificationPreferencesCard.tsx'), 'utf8').match(/<Switch[\s\S]*?\/>/)?.[0] ?? '';
    expect(preferenceSwitch).toContain('onValueChange={onChange}');
    expect(preferenceSwitch).toContain('disabled={disabled}');
    const preference = readFileSync(join(root, 'src/features/NotificationPreferencesCard.tsx'), 'utf8');
    expect(preference).toMatch(/<DisabledStateBoundary[^>]*accessibilityRole="switch"[^>]*>\s*<Switch[\s\S]*?disabled=[\s\S]*?<\/DisabledStateBoundary>/);
    const learningSwitch = readFileSync(join(root, 'src/features/learning/LearningControls.tsx'), 'utf8').match(/<Switch[\s\S]*?\/>/)?.[0] ?? '';
    expect(learningSwitch).toContain('accessibilityLabel={label}');
    expect(learningSwitch).not.toMatch(/disabled/);
    const offline = readFileSync(join(root, 'src/features/OfflineAvailabilityScreen.tsx'), 'utf8');
    expect(offline).toMatch(/<DisabledStateBoundary[^>]*accessibilityRole="switch"[^>]*>\s*<Switch[\s\S]*?disabled=[\s\S]*?<\/DisabledStateBoundary>/);
    const scorePrivacy = readFileSync(join(root, 'src/features/PulseScorePrivacyCard.tsx'), 'utf8');
    expect(scorePrivacy).toMatch(/<DisabledStateBoundary[^>]*accessibilityRole="switch"[^>]*>\s*<Switch[\s\S]*?disabled=[\s\S]*?<\/DisabledStateBoundary>/);
    const caseTopic = readFileSync(join(root, 'src/features/CaseRowTopicCards.tsx'), 'utf8');
    expect(caseTopic).toMatch(/<DisabledStateBoundary[^>]*accessibilityRole="switch"[^>]*>\s*<Switch[\s\S]*?disabled=[\s\S]*?<\/DisabledStateBoundary>/);
    // #9082: the steward's "Members can book time with me" switch, disabled
    // while the booking hours save.
    const bookingHours = readFileSync(join(root, 'src/features/AppointmentHoursCard.tsx'), 'utf8');
    expect(bookingHours).toMatch(/<DisabledStateBoundary[^>]*accessibilityRole="switch"[^>]*>\s*<Switch[\s\S]*?disabled=[\s\S]*?<\/DisabledStateBoundary>/);
    // #9099 part 1: the meeting form's check-in code switch, disabled while
    // the meeting saves.
    const meetingCheckIn = readFileSync(join(root, 'src/features/ScheduleMeetingCard.tsx'), 'utf8');
    expect(meetingCheckIn).toMatch(/<DisabledStateBoundary[^>]*accessibilityRole="switch"[^>]*>\s*<Switch[\s\S]*?disabled=[\s\S]*?<\/DisabledStateBoundary>/);
  });
});

describe('c16: the Guide question field is dimmed through the boundary while paused', () => {
  it('wraps the composer input with the same unavailability the input itself declares', () => {
    expect(compass).toContain("import { DisabledStateBoundary } from './DisabledStateBoundary';");
    expect(compass).toMatch(
      /<DisabledStateBoundary\s+disabled=\{!historyReady \|\| paused \|\| pendingSave !== null\}\s+accessibilityLabel=\{catalogLabel\(composerUnavailableLabel\)\}[\s\S]*?fill\s*>\s*<TextInput[\s\S]*?editable=\{historyReady && !paused && pendingSave === null\}\s+accessibilityState=\{\{ disabled: !historyReady \|\| paused \|\| pendingSave !== null \}\}[\s\S]*?\/>\s*<\/DisabledStateBoundary>/,
    );
    expect(compass).toContain('accessibilityValue={question ? { text: question } : undefined}');
  });

  it('names the pause in the dimmed label and never reuses the bare placeholder as the label', () => {
    expect(compass).toMatch(/const composerUnavailableLabel = paused\s*\?\s*'Ask the Guide, paused by an administrator'/);
    expect(compass).not.toContain('accessibilityLabel="Ask the Guide"');
  });

  it('tells a failed history load apart from a loading one, in the availability group wording', () => {
    expect(compass).toContain("body: 'History could not load. Try again below.'");
    expect(compass).toMatch(/: error\s*\?\s*'Ask the Guide, unavailable — history could not load\. Try again below\.'\s*:\s*'Ask the Guide, unavailable while your history loads'/);
  });

  it('leaves the pause announcement and the availability group unchanged', () => {
    expect(compass).toContain("const pauseMessage = 'The Guide is paused by an administrator.';");
    expect(compass).toContain("if (Platform.OS === 'ios') queueAnnouncement(catalogLabel(pauseMessage));");
    expect(compass).toContain("{ label: 'PAUSED', body: 'Paused by an administrator', accessibilityLabel: 'Guide is paused' }");
  });

  it('keeps the Send button declaring its own disabled state', () => {
    expect(compass).toContain("accessibilityLabel={t('Send question')} accessibilityState={{ disabled: busy || !historyReady || paused || pendingSave !== null || !question.trim() }}");
  });
});
