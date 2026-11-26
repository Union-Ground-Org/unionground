import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const layout = readFileSync(fileURLToPath(new URL('../../app/_layout.tsx', import.meta.url)), 'utf8');
const sessionNavigation = readFileSync(fileURLToPath(new URL('./rootLayoutNavigation.ts', import.meta.url)), 'utf8');

describe('protected pending-route lifecycle', () => {
  it('drops the previous identity route when an established session signs out', () => {
    expect(layout).toContain('useRootSessionNavigation(pendingRoute, navigatorReady);');
    expect(sessionNavigation).toContain('const previousSessionUserID = sessionUserIDRef.current;');
    expect(sessionNavigation).toMatch(/const sessionEnded = mode === 'signedOut' && \([\s\S]*previousSessionUserID !== null[\s\S]*previousMode !== 'booting'/);
    expect(sessionNavigation).toContain('if (sessionEnded) pendingRoute.current = null;');
    expect(sessionNavigation).toContain('if (!sessionEnded) pendingRoute.current = currentRoute;');
    expect(sessionNavigation.indexOf('rootNavigatorIsReady(navigationRef)')).toBeLessThan(sessionNavigation.indexOf("router.replace(mode === 'mfaRequired'"));
  });

  it('keeps screen protection active and queues protected notifications during resume authorization', () => {
    const navigationRoot = layout.indexOf('function NavigationRoot()');
    const protectionStart = layout.indexOf('useEffect(() => {', navigationRoot);
    const protection = layout.slice(
      protectionStart,
      layout.indexOf('useEffect(() => {', protectionStart + 1),
    );
    const navigate = layout.slice(layout.indexOf('const navigate ='), layout.indexOf('const handleNotificationResponse'));

    expect(layout).toContain('modeRef.current = mode;');
    expect(protection).toContain('if (!session) return;');
    expect(protection).not.toContain("mode !== 'authenticated'");
    expect(navigate).toContain("if (modeRef.current === 'booting' && !isPublicAppRoute(route)) {");
    expect(navigate.indexOf("modeRef.current === 'booting'")).toBeLessThan(navigate.indexOf('router.replace('));
  });
});

// Critic P7 C6 (Nov 6, 2026): on the biometric lock screen "Read public
// downloads" is a secondary escape, so it is a text link under Unlock and
// Sign out, as on the sign-in screen (#7309), not a full-width button.
describe('lock screen secondary actions', () => {
  it('keeps Unlock and Sign out as buttons and public downloads as a trailing text link', () => {
    const lockHeading = '<Heading>{catalogLabel("Union Ground is locked")}</Heading>';
    const lock = layout.slice(layout.indexOf(lockHeading), layout.indexOf('</Modal>', layout.indexOf(lockHeading)));
    expect(lock).toContain('<Button label="Unlock"');
    expect(lock).toContain('<Button label="Sign out"');
    expect(lock).not.toContain('<Button label="Read public downloads"');
    const link = lock.slice(lock.indexOf('accessibilityRole="link"'));
    expect(link).toContain('>Read public downloads</Text>');
    expect(lock.indexOf('<Button label="Sign out"')).toBeLessThan(lock.indexOf('accessibilityRole="link"'));
  });
});
