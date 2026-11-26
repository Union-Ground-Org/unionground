import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { PREVIEW_ORGANIZATION_ID } from '../../data/preview';
import { canOpenFeature, FEATURE_KEYS } from '../../lib/featureCatalog';
import {
  authorizePay,
  buildNativePayActor,
  calculatePay,
  createMemoryPayCatalog,
  createPayTools,
  describePayCalculationForAccessibility,
  describePayComparisonForAccessibility,
  nativeOrganizationId,
  PAY_NATIVE_PERSISTENCE,
  PAY_VIEW_STATES,
  payStatusPillLabel,
  payStatusPillState,
  presentCalculation,
  toPayActor,
} from '../../lib/mi1PayShared';
import { parseAppRoute } from '../../lib/routes';
import { statusStateForLabel } from '../../theme/statusRamp';

function source(relativeFromThisFile: string): string {
  return readFileSync(fileURLToPath(new URL(relativeFromThisFile, import.meta.url)), 'utf8');
}

describe('MI1 pay native wiring', () => {
  it('registers the Expo pay destination as a worker feature', () => {
    expect(FEATURE_KEYS).toContain('pay');
    expect(FEATURE_KEYS).toContain('qa');
    expect(canOpenFeature('preview', 'pay', 'member')).toBe(true);
    expect(canOpenFeature('authenticated', 'pay', null)).toBe(true);
    expect(parseAppRoute('unionground://feature/pay')).toEqual({ kind: 'feature', key: 'pay' });
  });

  it('uses only an explicitly selected organization for the landed pay catalog', () => {
    expect(nativeOrganizationId()).toBeNull();
    expect(nativeOrganizationId('org-a')).toBe('org-a');
    expect(PAY_NATIVE_PERSISTENCE.payCatalog).toBe(true);

    const empty = buildNativePayActor({ userId: 'member-1', chapterId: 'wor', roles: ['admin'], selectedHat: 'admin', authenticated: true });
    expect(empty.organizationId).toBeNull();
    expect(authorizePay({ actor: toPayActor(empty), organizationId: empty.organizationId, capability: 'calculate' }).ok).toBe(false);

    const tables = createPayTools({ actor: toPayActor(empty) }).presentTables({});
    expect(tables.state).toBe('empty');
    const estimate = presentCalculation({ ok: false, reason: 'empty_organization' });
    expect(estimate.state).toBe('empty');
    expect(estimate.message).toContain('Zero organizations');

    const selected = buildNativePayActor({ userId: 'member-1', organizationId: 'org-a', authenticated: true });
    expect(selected.organizationId).toBe('org-a');
    expect(authorizePay({ actor: toPayActor(selected), organizationId: selected.organizationId, capability: 'calculate' }).ok).toBe(true);
  });

  // UX-UG-MOBILE-KEYBOARD-APPEARANCE-LITERAL-20260920: every pay field
  // asked iOS for the light keyboard tray, so a dark theme drew a bright
  // keyboard under a dark screen. Both call sites — the calculator and the
  // catalog publisher — now read the active theme.
  it('asks iOS for the themed keyboard on every pay field', () => {
    const pay = source('./PayToolsScreen.tsx');
    const inputs = pay.match(/<TextInput/g)?.length ?? 0;
    const themed = pay.match(/keyboardAppearance=\{theme\.appearance\}/g)?.length ?? 0;

    expect(inputs).toBeGreaterThan(0);
    expect(themed, 'every pay TextInput sets keyboardAppearance from the theme').toBe(inputs);
    expect(pay).not.toMatch(/keyboardAppearance="/);
  });

  it('reuses the pay engine without mounting web JSX or seeding rates', () => {
    const shared = source('../../lib/mi1PayShared.ts');
    const pay = source('./PayToolsScreen.tsx');
    const feature = source('../FeatureScreen.tsx');

    expect(shared).toContain("from '../../../../src/features/pay/index.js'");
    expect(shared).not.toMatch(/features\/qa|features\/analytics|features\/integrations|features\/operations|publicDirectory/);
    expect(pay).toContain('bindBusinessApi(client, writer, createPayRpcAdapter');
    expect(pay).toContain("key={payActor.selectedOrganizationId ?? 'no-organization'}");
    expect(pay).toContain("api.upsertGrade!(actor");
    expect(pay).toContain("api.upsertStep!(actor");
    expect(pay).toContain('Publish pay-scale records');
    expect(pay).not.toContain('through the authorized onboarding workflow');
    expect(pay).not.toContain('hourlyRateCents: 2500');
    expect(pay).toContain('Pay-scale comparison');
    expect(pay).toContain('tools.presentCompare(');
    expect(pay).toContain("import { useAccessibilityAnnouncementQueue } from '../../lib/announce'");
    expect(pay).toContain('queueAnnouncement(describePayCalculationForAccessibility(presented, ui))');
    expect(pay).toContain('queueAnnouncement(describePayComparisonForAccessibility(presented, ui))');
    expect(pay).toContain('setComparison(null)');
    expect(pay).toContain('setResult(null)');
    expect(pay).toContain("usesCatalogRate && catalogState !== 'ready'");
    expect(pay).toContain("presentRetry('Wage and back-pay calculator')");
    expect(pay).toContain('hourlyRate: hourlyRate.trim() ? hourly : undefined');
    expect(pay).not.toContain('hourlyRate: hourly > 0 ? hourly : undefined');
    expect(pay).toContain('{catalogView.message ? <Body muted>{catalogLabel(catalogView.message)}</Body> : null}');
    expect(pay).not.toContain("catalogView.message ?? 'This organization has no published pay scale yet.'");
    expect(pay).toContain('comparison.left.effectiveOn');
    expect(pay).toContain('comparison.right.effectiveOn');
    expect(pay).toContain('comparison.left.annual');
    expect(pay).toContain('comparison.right.annual');
    for (const field of [
      'result.cards.map',
      'result.amountPaid',
      'result.underpayment',
      'result.raise.nowAnnual',
      'result.raise.newAnnual',
      'result.raise.annualDelta',
      'result.raise.perCheckDelta',
      'result.raise.retro',
    ]) {
      expect(pay).toContain(field);
    }
    expect(feature).toContain("if (featureKey === 'pay')");
    expect(feature).toContain('<PayToolsRoute />');
    expect(pay).toContain('organizationRoles');
    expect(pay).toContain('roles: organizationRoles');
    expect(pay).not.toContain('authorizedRoles');
  });

  it('authorizes write_catalog from organization roles only', () => {
    const organizationId = 'org-a';
    const readCapabilities: readonly string[] = ['read_catalog', 'calculate', 'compare'];
    const organizationRoles: readonly string[] = ['advisor', 'admin', 'vp'];
    const chapterOnlyAdvisor = toPayActor(buildNativePayActor({
      userId: 'member-1',
      organizationId,
      roles: [],
      authenticated: true,
      mfaSatisfied: true,
    }));

    expect(authorizePay({
      actor: chapterOnlyAdvisor,
      organizationId,
      capability: 'write_catalog',
    }).ok).toBe(false);
    for (const capability of readCapabilities) {
      expect(authorizePay({
        actor: chapterOnlyAdvisor,
        organizationId,
        capability,
      }).ok).toBe(true);
    }

    for (const role of organizationRoles) {
      const orgStaff = toPayActor(buildNativePayActor({
        userId: 'member-1',
        organizationId,
        roles: [role],
        authenticated: true,
        mfaSatisfied: true,
      }));
      expect(authorizePay({
        actor: orgStaff,
        organizationId,
        capability: 'write_catalog',
      }).ok).toBe(true);
    }
  });

  it('provides concise screen-reader announcements for calculation and comparison outcomes', () => {
    expect(describePayCalculationForAccessibility({
      state: 'success',
      grossOwed: '$1000.00',
      underpayment: '$200.00',
      backPay: '$400.00',
    })).toBe('Pay estimate. Gross owed $1000.00. Wage underpayment $200.00. Back pay $400.00.');
    expect(describePayCalculationForAccessibility({
      state: 'validation',
      message: 'Check the hours and rates.',
    })).toBe('Check the hours and rates.');
    expect(describePayComparisonForAccessibility({
      state: 'success',
      hourlyDelta: '$5.00',
      annualDelta: '$10000.00',
      perCheckDelta: '$400.00',
    })).toBe('Pay-scale comparison. Hourly difference $5.00. Annual difference $10000.00. Per-paycheck difference $400.00.');
    expect(describePayComparisonForAccessibility({
      state: 'retry',
      message: 'The pay catalog could not be reached.',
    })).toBe('The pay catalog could not be reached.');
  });

  it('authorizes the isolated preview organization without loading a live catalog', () => {
    const provider = source('../../state/AppProvider.tsx');
    const pay = source('./PayToolsScreen.tsx');
    const preview = buildNativePayActor({
      userId: 'sample-member',
      organizationId: PREVIEW_ORGANIZATION_ID,
      authenticated: true,
      mfaSatisfied: true,
    });

    expect(provider).toContain('organizationID: PREVIEW_ORGANIZATION_ID');
    expect(PREVIEW_ORGANIZATION_ID).toBe('preview-harborview-care-united');
    expect(authorizePay({
      actor: toPayActor(preview),
      organizationId: PREVIEW_ORGANIZATION_ID,
      capability: 'calculate',
    }).ok).toBe(true);
    expect(pay).toContain("if (mode === 'preview')");
    expect(pay).toContain('catalog: createMemoryPayCatalog()');
    expect(toPayActor(preview).mfaSatisfied).toBe(true);
    expect(pay).toContain("mfaSatisfied: mode === 'authenticated' || mode === 'preview'");
  });

  it('passes explicit as-of dates and contract rules through the native engine seam', () => {
    const organizationId = PREVIEW_ORGANIZATION_ID;
    const catalog = createMemoryPayCatalog();
    const admin = toPayActor(buildNativePayActor({
      userId: 'sample-admin',
      organizationId,
      roles: ['admin'],
      authenticated: true,
    }));
    catalog.upsertGrade(admin, { organizationId, grade: 'A', title: 'Grade A' });
    catalog.upsertStep(admin, {
      organizationId,
      grade: 'A',
      stepNumber: 1,
      effectiveOn: '2026-01-01',
      hourlyRateCents: 2500,
    });
    catalog.upsertStep(admin, {
      organizationId,
      grade: 'A',
      stepNumber: 1,
      effectiveOn: '2027-01-01',
      hourlyRateCents: 3000,
    });
    const member = toPayActor(buildNativePayActor({
      userId: 'sample-member',
      organizationId,
      authenticated: true,
    }));

    expect(calculatePay({
      actor: member,
      catalog,
      organizationId,
      rules: null,
      input: { grade: 'A', stepNumber: 1, hours: { regular: 1 } },
    })).toMatchObject({ reason: 'calculation_date_required' });
    expect(calculatePay({
      actor: member,
      catalog,
      organizationId,
      rules: null,
      input: { grade: 'A', stepNumber: 1, effectiveOn: '2026-08-25', hours: { regular: 1 } },
    })).toMatchObject({ ok: true, grossOwedCents: 2500 });
    expect(calculatePay({
      actor: member,
      catalog: null,
      organizationId,
      rules: null,
      input: { hourlyRate: 25, hours: { overtime: 1 } },
    })).toMatchObject({ reason: 'calculation_rules_unset' });

    const comparison = createPayTools({ actor: member, catalog }).presentCompare(
      { grade: 'A', stepNumber: 1, effectiveOn: '2026-12-31' },
      { grade: 'A', stepNumber: 1, effectiveOn: '2027-12-31' },
      { hoursPerYear: 2000, checksPerYear: 25 },
    );
    expect(comparison).toMatchObject({
      state: 'success',
      hourlyDelta: '$5.00',
      annualDelta: '$10000.00',
      perCheckDelta: '$400.00',
    });

    const raiseAndUnderpayment = presentCalculation(calculatePay({
      actor: member,
      catalog,
      organizationId,
      rules: { hoursPerYear: 2000, checksPerYear: 25 },
      input: {
        hourlyRate: 25,
        hours: { regular: 40 },
        amountPaid: 800,
        raisePercent: 5,
        unpaidPayPeriods: 2,
      },
    }));
    expect(raiseAndUnderpayment).toMatchObject({
      state: 'success',
      amountPaid: '$800.00',
      underpayment: '$200.00',
      backPay: '$400.00',
      raise: {
        nowAnnual: '$50000.00',
        newAnnual: '$52500.00',
        annualDelta: '$2500.00',
        perCheckDelta: '$100.00',
        retro: '$200.00',
      },
    });

    const bucketBreakdown = presentCalculation(calculatePay({
      actor: member,
      catalog,
      organizationId,
      rules: { overtimeMultiplier: 1.5 },
      input: { hourlyRate: 25, hours: { regular: 40, overtime: 2 } },
    }));
    expect(bucketBreakdown).toMatchObject({
      state: 'success',
      cards: [
        { kind: 'regular', hours: 40, rate: '$25.00', amount: '$1000.00' },
        { kind: 'overtime', hours: 2, rate: '$37.50', amount: '$75.00' },
      ],
    });
  });

  it('colours every pay status pill by its own state, not the active fallback', () => {
    // Why an explicit table exists: the pill's label rule is the *record*
    // vocabulary, and no pay state is in it, so an unaided pay pill resolves to
    // 'active' whatever went wrong.
    for (const state of ['loading', 'retry', 'validation', 'unauthorized', 'wrong_organization', 'empty', 'success', 'error']) {
      expect(statusStateForLabel(state), `${state} is not in the ramp word lists`).toBe('active');
    }

    const expected: Record<string, string> = {
      empty: 'queued',
      loading: 'active',
      success: 'done',
      validation: 'attention',
      unauthorized: 'attention',
      wrong_organization: 'attention',
      retry: 'attention',
    };
    const viewStates: readonly string[] = PAY_VIEW_STATES;
    // Every published view state is mapped, and nothing is mapped that the
    // engine no longer emits.
    expect([...viewStates].sort()).toEqual(Object.keys(expected).sort());
    for (const state of viewStates) {
      expect(payStatusPillState(state), `${state} must carry its own ramp hue`).toBe(expected[state]);
    }
    // The catalog card's own state and the publish form's failure state.
    expect(payStatusPillState('ready')).toBe('done');
    expect(payStatusPillState('Ready')).toBe('done');
    expect(payStatusPillState('error')).toBe('attention');
    // A run the member has to act on cannot read like a finished one.
    expect(payStatusPillState('retry')).not.toBe(payStatusPillState('success'));
    expect(payStatusPillState('loading')).not.toBe(payStatusPillState('ready'));
    // Anything outside the closed vocabulary keeps the pill's label rule.
    expect(payStatusPillState('committee member review')).toBe('attention');
    expect(payStatusPillState('in progress')).toBe('active');

    // The screen mounts the raw pill exactly once, inside the wrapper that
    // supplies the ramp state; every pay card goes through that wrapper.
    const pay = source('./PayToolsScreen.tsx');
    expect(pay).toContain('function PayStatusPill({ state, label }: { state: string; label?: string })');
    expect(pay.match(/<StatusPill[^>]*\/>/g) ?? []).toEqual([
      '<StatusPill label={label ?? catalogLabel(payStatusPillLabel(state))} state={payStatusPillState(state)} />',
    ]);
    expect((pay.match(/<PayStatusPill[^>]*\/>/g) ?? []).length).toBe(4);
  });

  it('shows worker copy, never a raw view-state key, in every pay status pill', () => {
    for (const state of [...PAY_VIEW_STATES, 'ready', 'Ready', 'error']) {
      const label = payStatusPillLabel(state);
      expect(label, state).not.toMatch(/_/);
      expect(label, state).not.toBe(state.toLowerCase());
      expect(label.charAt(0), state).toBe(label.charAt(0).toUpperCase());
    }
    expect(payStatusPillLabel('wrong_organization')).toBe('Wrong organization');
    expect(payStatusPillLabel('validation')).toBe('Check entries');
    expect(payStatusPillLabel('retry')).toBe('Catalog unavailable');
    expect(payStatusPillLabel('success')).toBe('Done');
    expect(payStatusPillLabel('Ready')).toBe('Ready');
    expect(payStatusPillLabel('some_new_state')).toBe('Some new state');

    // The publish form names its own outcome instead of the calculator's "Done".
    const pay = source('./PayToolsScreen.tsx');
    expect(pay).toContain("<PayStatusPill state={status.state} label={status.state === 'success' ? t('Published') : t('Not published')} />");
  });
});
