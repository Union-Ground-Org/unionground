import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function source(path: string) {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
}

describe('exact-head mobile review remediation', () => {
  it('does not present navigation affordances for live notifications without destinations', () => {
    const notifications = source('../../app/notifications.tsx');
    expect(notifications).toContain('NotificationContent');
    expect(notifications).not.toContain('disabled={!item.href}');
    expect(notifications).not.toContain('accessibilityLabel={`Open ${item.title}`}');
  });

  it('keeps worker preview channels and unread totals inside the worker boundary', () => {
    const rail = source('../components/ChapterRail.tsx');
    const home = source('../../app/(tabs)/home.tsx');
    const campaign = source('../../app/(tabs)/campaign.tsx');
    expect(rail).toContain("previewHat !== 'member' || !channel.locked");
    expect(home).toContain("previewHat !== 'member' || !channel.locked");
    // Organizing-only tools (handshakes, the power map) stay off the Worker hat.
    expect(campaign).toContain("destinations.filter((item) => !item.organizingHatsOnly || organizingHat)");
    expect(campaign).toContain("{ title: 'Campaign handshakes', body: 'Requests between campaigns, signatures, and bounded sharing.', href: '/feature/partners', icon: 'link', organizingHatsOnly: true }");
  });

  it('removes dead demo controls and exposes accessibility labels on accessible elements', () => {
    const pulse = source('../features/PulseScreen.tsx');
    const channel = source('../../app/channel/[id].tsx');
    expect(pulse).not.toContain('+ Add a tag');
    expect(pulse).toMatch(/accessible[\s\S]{0,80}accessibilityLabel=\{`\$\{option\.label\}/);
    expect(pulse).toMatch(/accessible[\s\S]{0,80}accessibilityLabel=\{`\$\{row\.label\}: \$\{row\.value\}/);
    expect(channel).toContain("<View accessible style={styles.newDivider} accessibilityLabel={t('New messages')}>");
  });

  it('keys live function reads to campaign identity and resolves a missing sister campaign as empty', () => {
    const feature = `${source('../features/FeatureScreen.tsx')}\n${source('../features/LiveAppointmentsFeature.tsx')}\n${source('../features/LiveFeatureScreens.tsx')}`;
    // #8630: the chapter casework read moved from the generic screen to the desks' own hook.
    expect(feature).toContain('void loadChapterCases(chapterID).then((rows) => {');
    expect(feature).toContain('}, [chapterID, reload]);');
    // Voting reads retain the chapter key and the composing owner's state setters.
    expect(source('../features/FeatureScreen.tsx')).toContain('}, [chapterID, reload, setBallots, setSelected, setError, setRemovalDetails]);');
    expect(feature).toMatch(/if \(!chapterID\) \{[\s\S]{0,140}setItems\(\[\]\);[\s\S]{0,80}setTargets\(\[\]\);/);
    expect(feature).toContain('historyRequest.current += 1;');
    expect(feature).toMatch(/if \(request === historyRequest\.current\) \{[\s\S]{0,80}setHistory\(nextHistory\);/);
    expect(feature).toContain('const request = historyRequest.current;');
    expect(feature).toContain('nextBefore: older.nextBefore');
  });

  it('routes password-authenticated staff into the MFA challenge', () => {
    const signIn = source('../../app/sign-in.tsx');
    expect(signIn).toContain("if (mode === 'mfaRequired')");
    expect(signIn).toContain('<Redirect href="/mfa-challenge" />');
  });

  it('keeps the SAMPLE demo visible before the scrollable sign-in form', () => {
    const signIn = source('../../app/sign-in.tsx');
    const provider = source('../state/AppProvider.tsx');
    expect(signIn).toContain('ScrollView, StyleSheet');
    expect(signIn).toContain('contentContainerStyle={[styles.content, usesAccessibilityType ? styles.accessibilityTypeContent : null]}');
    expect(signIn).toContain('keyboardShouldPersistTaps="handled"');
    expect(signIn).toContain('label="Try the demo"');
    expect(signIn.indexOf('{!liveSample && previewAllowed ?')).toBeLessThan(signIn.indexOf('<View style={styles.form}>'));
    expect(provider).toContain('const previewAllowed = mobileConfig.previewEnabled;');
    expect(provider).toContain("if (!supabase) {\n      // Preview is an explicit choice beside sign-in");
    expect(provider).toMatch(/if \(data\.session\) \{[\s\S]{0,420}setSession\(data\.session\);[\s\S]{0,120}await revalidateAuthenticatedSession\(data\.session\);/);
    expect(provider).not.toContain('establishSession(data.session, true)');
    expect(provider).not.toMatch(/if \(previewAllowed\)[\s\S]{0,180}setMode\('preview'\)/);
  });

  it('keeps the sign-in wordmark intact and actions reachable at Accessibility XXXL', () => {
    const signIn = source('../../app/sign-in.tsx');
    expect(signIn).toContain('const usesAccessibilityType = fontScale >= 2;');
    // The product mark is drawn (its initial does not scale with type), so it cannot scale apart.
    expect(signIn).toContain('<BrandMark size={56} />');
    expect(signIn).toContain('maxFontSizeMultiplier={2}');
    // This edition keeps public main's sign-in: the legal pages are a pair of
    // buttons that stack at accessibility text sizes so each stays reachable.
    expect(signIn).toContain('<View style={[styles.legalRow, usesAccessibilityType ? styles.accessibilityTypeStack : null]}>');
    expect(signIn).toContain('<Button label="Privacy policy" variant="secondary"');
    expect(signIn).toContain('<Button label="Terms of use" variant="secondary"');
  });
});
