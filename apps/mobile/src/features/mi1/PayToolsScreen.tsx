import { normalizePayScaleStep } from '../../../../../src/features/pay/catalog.js';
import { dollarsToCents } from '../../../../../src/features/pay/money.js';
import { isIsoDate, normalizeGrade, normalizeStepNumber } from '../../../../../src/features/pay/rules.js';
import { useBusinessDraftState } from '../../lib/useBusinessDraftState';
import { useBusinessOperation } from '../../lib/useBusinessWriter';
import { BUSINESS_SAVED_STALE, checkBusinessContinuation } from '../../lib/businessWriteContinuation';
import { useNativeUi } from '../../lib/useNativeUi';
import type { NativeUiKey, NativeUiText } from '../../lib/nativeUiCopy';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { View } from 'react-native';
import { Text, TextInput } from '../../components/Text';

import { Body, Button, Card, Heading, Screen, StateMessage, StatusPill } from '../../components/ui';
import {
  authorizePay,
  buildNativePayActor,
  calculatePay,
  createMemoryPayCatalog,
  createPayRpcAdapter,
  createPayTools,
  describePayCalculationForAccessibility,
  describePayComparisonForAccessibility,
  PAY_NATIVE_PERSISTENCE,
  payStatusPillLabel,
  payStatusPillState,
  presentCalculation,
  presentCatalog,
  presentLoading,
  presentRetry,
  toPayActor,
  type NativeOrganizationActor,
} from '../../lib/mi1PayShared';
import { deviceCalendarDay } from '../../lib/evidenceTimestamp';
import { useAccessibilityAnnouncementQueue } from '../../lib/announce';
import { haptics } from '../../services/haptics';
import { getSupabaseClient } from '../../services/supabase';
import { bindBusinessApi } from '../../services/businessWriters';
import { useBusinessRequests, useBusinessWriter, useBusinessState } from '../../lib/useBusinessWriter';
import { useApp } from '../../state/AppProvider';
import { useTheme } from '../../theme/ThemeProvider';
import { mi1Styles as styles } from './mi1Styles';

function numberOrZero(value: string): number {
  return value.trim() ? Number(value) : 0;
}

const PAY_BUCKET_LABELS: Record<string, NativeUiKey> = {
  regular: 'Regular',
  overtime: 'Overtime',
  night: 'Night',
  weekend: 'Weekend',
  standby: 'Standby',
};

/** A pay bucket's name in the member's language; an unknown bucket shows its key. */
function payBucketLabel(kind: string, t: NativeUiText): string {
  const key = PAY_BUCKET_LABELS[kind];
  return key ? t(key) : kind;
}

/**
 * Every status pill on this screen. Both the worker copy and the ramp state are
 * resolved from the presentation's machine state: left to the pill's own label
 * rule the whole pay vocabulary falls through to 'active', and a failed run
 * looks like a finished one. A card whose outcome has its own words passes them
 * as `label`.
 */
function PayStatusPill({ state, label }: { state: string; label?: string }) {
  // #9502: the machine-state words are app-owned copy, shown in the member's language.
  const { catalogLabel } = useNativeUi();
  return <StatusPill label={label ?? catalogLabel(payStatusPillLabel(state))} state={payStatusPillState(state)} />;
}

export function PayToolsRoute() {
  const writer = useBusinessWriter();
  const { mode, dashboard, previewHat, organizationRoles, organizationID } = useApp();
  const actor = useMemo(() => buildNativePayActor({
    userId: dashboard?.member.id ?? null,
    organizationId: organizationID,
    chapterId: dashboard?.member.chapterID ?? null,
    roles: organizationRoles,
    selectedHat: previewHat,
    authenticated: mode === 'authenticated' || mode === 'preview',
    mfaSatisfied: mode === 'authenticated' || mode === 'preview',
  }), [dashboard?.member.chapterID, dashboard?.member.id, mode, organizationID, organizationRoles, previewHat]);
  const api = useMemo(() => {
    if (mode === 'preview') {
      return { loadCatalog: async () => ({ ok: true, catalog: createMemoryPayCatalog() }) };
    }
    const client = getSupabaseClient();
    return client ? bindBusinessApi(client, writer, createPayRpcAdapter, ['list_pay_scale_grades', 'list_pay_scale_steps']) : null;
    // A change of session mode (a sign-in, a sign-out) builds the client again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, writer]);
  return <PayToolsScreen actor={actor} api={api} />;
}

type PayCatalog = ReturnType<typeof createMemoryPayCatalog>;
type PayCatalogWrite = { ok: boolean; reason?: string };
type PayCatalogApi = {
  loadCatalog: () => Promise<{ ok: boolean; catalog?: PayCatalog }>;
  upsertGrade?: (actor: unknown, record: unknown) => Promise<PayCatalogWrite>;
  upsertStep?: (actor: unknown, record: unknown) => Promise<PayCatalogWrite>;
};

export function PayToolsScreen({ actor, api = null }: {
  actor: NativeOrganizationActor;
  api?: PayCatalogApi | null;
}) {
  const ui = useNativeUi();
  const { catalogLabel, locale, t } = ui;
  const effectiveDateLabel = (day: string) => deviceCalendarDay(day, locale) ?? t('Date unavailable');
  const theme = useTheme();
  const payActor = useMemo(() => toPayActor(actor), [actor]);
  const announcementOwner = `pay-tools:${actor.userId ?? ''}:${actor.organizationId ?? ''}:${actor.selectedHat ?? ''}:${actor.mfaSatisfied}`;
  const queueAnnouncement = useAccessibilityAnnouncementQueue(
    announcementOwner,
  );
  const [catalog, setCatalog] = useBusinessDraftState(() => createMemoryPayCatalog());
  const [catalogState, setCatalogState] = useBusinessDraftState<'loading' | 'ready' | 'retry'>('ready');
  const catalogRequest = useRef(0);
  const tools = useMemo(() => createPayTools({ actor: payActor, catalog }), [catalog, payActor]);
  const [hourlyRate, setHourlyRate] = useBusinessDraftState('');
  const [regularHours, setRegularHours] = useBusinessDraftState('');
  const [overtimeHours, setOvertimeHours] = useBusinessDraftState('');
  const [overtimeMultiplier, setOvertimeMultiplier] = useBusinessDraftState('');
  const [nightHours, setNightHours] = useBusinessDraftState('');
  const [nightMultiplier, setNightMultiplier] = useBusinessDraftState('');
  const [weekendHours, setWeekendHours] = useBusinessDraftState('');
  const [weekendMultiplier, setWeekendMultiplier] = useBusinessDraftState('');
  const [standbyHours, setStandbyHours] = useBusinessDraftState('');
  const [standbyHourlyRate, setStandbyHourlyRate] = useBusinessDraftState('');
  const [amountPaid, setAmountPaid] = useBusinessDraftState('');
  const [raisePercent, setRaisePercent] = useBusinessDraftState('');
  const [unpaidPeriods, setUnpaidPeriods] = useBusinessDraftState('');
  const [grade, setGrade] = useBusinessDraftState('');
  const [stepNumber, setStepNumber] = useBusinessDraftState('');
  const [effectiveOn, setEffectiveOn] = useBusinessDraftState('');
  const [hoursPerYear, setHoursPerYear] = useBusinessDraftState('');
  const [checksPerYear, setChecksPerYear] = useBusinessDraftState('');
  const [result, setResult] = useBusinessDraftState<any>(null);
  const [comparison, setComparison] = useBusinessDraftState<any>(null);
  const [leftGrade, setLeftGrade] = useBusinessDraftState('');
  const [leftStep, setLeftStep] = useBusinessDraftState('');
  const [leftDate, setLeftDate] = useBusinessDraftState('');
  const [rightGrade, setRightGrade] = useBusinessDraftState('');
  const [rightStep, setRightStep] = useBusinessDraftState('');
  const [rightDate, setRightDate] = useBusinessDraftState('');
  const [comparisonHoursPerYear, setComparisonHoursPerYear] = useBusinessDraftState('');
  const [comparisonChecksPerYear, setComparisonChecksPerYear] = useBusinessDraftState('');

  const reloadCatalog = useCallback(async () => {
    const request = ++catalogRequest.current;
    setResult(null);
    setComparison(null);
    if (!actor.organizationId) {
      setCatalog(createMemoryPayCatalog());
      setCatalogState('ready');
      return;
    }
    if (!api) {
      setCatalog(createMemoryPayCatalog());
      setCatalogState('retry');
      return;
    }
    setCatalogState('loading');
    const loaded = await api.loadCatalog();
    if (request !== catalogRequest.current) return;
    if (!loaded.ok || !loaded.catalog) {
      setCatalog(createMemoryPayCatalog());
      setCatalogState('retry');
      setResult((current: any) => current?.state === 'loading'
        ? presentRetry('Wage and back-pay calculator')
        : current);
      return;
    }
    setCatalog(loaded.catalog);
    setCatalogState('ready');
    setResult((current: any) => current?.state === 'loading' ? null : current);
  }, [actor.organizationId, api, setResult, setComparison, setCatalog, setCatalogState]);

  useEffect(() => {
    void reloadCatalog();
    return () => {
      catalogRequest.current += 1;
    };
  }, [reloadCatalog]);

  const catalogView = catalogState === 'loading'
    ? presentLoading('Pay-scale tables')
    : catalogState === 'retry'
      ? presentRetry('Pay-scale tables')
      : presentCatalog(tools.query({}));

  function runEstimate() {
    const hourly = Number(hourlyRate);
    const usesCatalogRate = !hourlyRate.trim() && (grade.trim() || stepNumber.trim());
    if (usesCatalogRate && catalogState !== 'ready') {
      const presented = catalogState === 'loading'
        ? presentLoading('Wage and back-pay calculator')
        : presentRetry('Wage and back-pay calculator');
      setResult(presented);
      queueAnnouncement(describePayCalculationForAccessibility(presented, ui));
      void haptics.warning();
      return;
    }
    const rules = {
      ...(overtimeMultiplier.trim() ? { overtimeMultiplier: Number(overtimeMultiplier) } : {}),
      ...(nightMultiplier.trim() ? { nightMultiplier: Number(nightMultiplier) } : {}),
      ...(weekendMultiplier.trim() ? { weekendMultiplier: Number(weekendMultiplier) } : {}),
      ...(standbyHourlyRate.trim() ? { standbyHourlyCents: Math.round(Number(standbyHourlyRate) * 100) } : {}),
      ...(hoursPerYear.trim() ? { hoursPerYear: Number(hoursPerYear) } : {}),
      ...(checksPerYear.trim() ? { checksPerYear: Number(checksPerYear) } : {}),
    };
    const presented = presentCalculation(calculatePay({
      actor: payActor,
      catalog,
      organizationId: payActor.selectedOrganizationId,
      rules,
      input: {
        hourlyRate: hourlyRate.trim() ? hourly : undefined,
        hours: {
          regular: numberOrZero(regularHours),
          overtime: numberOrZero(overtimeHours),
          night: numberOrZero(nightHours),
          weekend: numberOrZero(weekendHours),
          standby: numberOrZero(standbyHours),
        },
        amountPaid: amountPaid.trim() ? Number(amountPaid) : undefined,
        raisePercent: raisePercent.trim() ? Number(raisePercent) : undefined,
        unpaidPayPeriods: unpaidPeriods.trim() ? Number(unpaidPeriods) : 0,
        grade: grade.trim() || undefined,
        stepNumber: stepNumber.trim() ? Number(stepNumber) : undefined,
        effectiveOn: effectiveOn || undefined,
      },
    }));
    setResult(presented);
    queueAnnouncement(describePayCalculationForAccessibility(presented, ui));
    void (presented.state === 'success' ? haptics.success() : haptics.warning());
  }

  function runComparison() {
    if (catalogState !== 'ready') {
      const presented = catalogState === 'loading'
        ? presentLoading('Pay-scale comparison')
        : presentRetry('Pay-scale comparison');
      setComparison(presented);
      queueAnnouncement(describePayComparisonForAccessibility(presented, ui));
      void haptics.warning();
      return;
    }
    const presented = tools.presentCompare(
      {
        grade: leftGrade.trim() || undefined,
        stepNumber: leftStep.trim() ? Number(leftStep) : undefined,
        effectiveOn: leftDate || undefined,
      },
      {
        grade: rightGrade.trim() || undefined,
        stepNumber: rightStep.trim() ? Number(rightStep) : undefined,
        effectiveOn: rightDate || undefined,
      },
      {
        hoursPerYear: comparisonHoursPerYear.trim() ? Number(comparisonHoursPerYear) : undefined,
        checksPerYear: comparisonChecksPerYear.trim() ? Number(comparisonChecksPerYear) : undefined,
      },
    );
    setComparison(presented);
    queueAnnouncement(describePayComparisonForAccessibility(presented, ui));
    void (presented.state === 'success' ? haptics.success() : haptics.warning());
  }

  const writeGate = authorizePay({ actor: payActor, organizationId: payActor.selectedOrganizationId, capability: 'write_catalog' });

  return (
    <Screen>
      <Heading>{catalogLabel('Pay tools')}</Heading>
      <Body muted>{t('Estimates use a published scale or the rate you enter. They are not payroll or a stored issue.')}</Body>
      <Card>
        <View style={styles.row}>
          <Heading level={3}>{t('Pay-scale tables')}</Heading>
          {/* "Ready" only when a scale is published (audit MOB-STEWARD-10,
              MOB-ADMIN-11): a loaded catalog with no rows reads "Nothing published". */}
          <PayStatusPill state={catalogState === 'ready' && PAY_NATIVE_PERSISTENCE.payCatalog ? (catalogView.state === 'success' ? 'Ready' : catalogView.state) : catalogState} />
        </View>
        {catalogView.message ? <Body muted>{catalogLabel(catalogView.message)}</Body> : null}
        {catalogView.state === 'success' && 'rows' in catalogView && Array.isArray(catalogView.rows) ? catalogView.rows.map((row: any) => (
          <Body key={`${row.grade}-${row.stepNumber}-${row.effectiveOn}`}>{t('{grade} · Step {step} · {hourly} · effective {date}', { grade: row.grade, step: row.stepNumber, hourly: row.hourly, date: effectiveDateLabel(row.effectiveOn) })}</Body>
        )) : null}
        {catalogState === 'retry' ? <Button label={t('Try again')} onPress={reloadCatalog} variant="secondary" /> : null}
        <Body muted>{t('Union Ground loads no pay rates of its own. Each organization adds its own contract rates.')}</Body>
      </Card>
      <Card>
        <Heading level={3}>{t('Pay-scale comparison')}</Heading>
        <Body muted>{t('Compare two published employer grades, steps, or effective dates to see a wage gap. Enter the hours and paychecks that apply to you.')}</Body>
        <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{t('From grade')}</Text>
        <TextInput
          accessibilityLabel={t('From grade')}
          keyboardAppearance={theme.appearance}
          selectionColor={theme.primary}
          value={leftGrade}
          onChangeText={setLeftGrade}
          placeholder={t('Published grade')}
          placeholderTextColor={theme.quietForeground}
          style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
        />
        <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{t('From step')}</Text>
        <TextInput
          accessibilityLabel={t('From step')}
          keyboardType="number-pad"
          keyboardAppearance={theme.appearance}
          selectionColor={theme.primary}
          value={leftStep}
          onChangeText={setLeftStep}
          placeholder={t('Published step')}
          placeholderTextColor={theme.quietForeground}
          style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
        />
        <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{t('From date')}</Text>
        <TextInput
          accessibilityLabel={t('From date')}
          keyboardType="numbers-and-punctuation"
          keyboardAppearance={theme.appearance}
          selectionColor={theme.primary}
          value={leftDate}
          onChangeText={setLeftDate}
          placeholder={t('YYYY-MM-DD')}
          placeholderTextColor={theme.quietForeground}
          style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
        />
        <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{t('To grade')}</Text>
        <TextInput
          accessibilityLabel={t('To grade')}
          keyboardAppearance={theme.appearance}
          selectionColor={theme.primary}
          value={rightGrade}
          onChangeText={setRightGrade}
          placeholder={t('Published grade')}
          placeholderTextColor={theme.quietForeground}
          style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
        />
        <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{t('To step')}</Text>
        <TextInput
          accessibilityLabel={t('To step')}
          keyboardType="number-pad"
          keyboardAppearance={theme.appearance}
          selectionColor={theme.primary}
          value={rightStep}
          onChangeText={setRightStep}
          placeholder={t('Published step')}
          placeholderTextColor={theme.quietForeground}
          style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
        />
        <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{t('To date')}</Text>
        <TextInput
          accessibilityLabel={t('To date')}
          keyboardType="numbers-and-punctuation"
          keyboardAppearance={theme.appearance}
          selectionColor={theme.primary}
          value={rightDate}
          onChangeText={setRightDate}
          placeholder={t('YYYY-MM-DD')}
          placeholderTextColor={theme.quietForeground}
          style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
        />
        <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{t('Comparison annual hours')}</Text>
        <TextInput
          accessibilityLabel={t('Comparison annual hours')}
          keyboardType="number-pad"
          keyboardAppearance={theme.appearance}
          selectionColor={theme.primary}
          value={comparisonHoursPerYear}
          onChangeText={setComparisonHoursPerYear}
          placeholder={t('Enter the figure that applies to you')}
          placeholderTextColor={theme.quietForeground}
          style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
        />
        <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{t('Comparison paychecks per year')}</Text>
        <TextInput
          accessibilityLabel={t('Comparison paychecks per year')}
          keyboardType="number-pad"
          keyboardAppearance={theme.appearance}
          selectionColor={theme.primary}
          value={comparisonChecksPerYear}
          onChangeText={setComparisonChecksPerYear}
          placeholder={t('Enter the figure that applies to you')}
          placeholderTextColor={theme.quietForeground}
          style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
        />
        <Button label={t('Compare rates')} onPress={runComparison} />
        {comparison ? (
          <>
            <PayStatusPill state={comparison.state} />
            {comparison.message ? <Body muted>{catalogLabel(comparison.message)}</Body> : null}
            {comparison.state === 'success' ? (
              <>
                <Body>{t('From {grade} · Step {step} · {hourly} · effective {date} · annual {annual}', { grade: comparison.left.grade, step: comparison.left.stepNumber, hourly: comparison.left.hourly, date: effectiveDateLabel(comparison.left.effectiveOn), annual: comparison.left.annual })}</Body>
                <Body>{t('To {grade} · Step {step} · {hourly} · effective {date} · annual {annual}', { grade: comparison.right.grade, step: comparison.right.stepNumber, hourly: comparison.right.hourly, date: effectiveDateLabel(comparison.right.effectiveOn), annual: comparison.right.annual })}</Body>
                <Body>{t('Hourly difference {amount}', { amount: comparison.hourlyDelta })}</Body>
                <Body>{t('Annual difference {amount}', { amount: comparison.annualDelta })}</Body>
                <Body>{t('Per-paycheck difference {amount}', { amount: comparison.perCheckDelta })}</Body>
              </>
            ) : null}
            {comparison.state === 'retry' ? <Button label={t('Retry catalog')} onPress={reloadCatalog} variant="secondary" /> : null}
          </>
        ) : null}
      </Card>
      <Card>
        <Heading level={3}>{t('Wage and back-pay calculator')}</Heading>
        <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{t('Hourly rate')}</Text>
        <TextInput
          accessibilityLabel={t('Hourly rate')}
          keyboardType="decimal-pad"
          keyboardAppearance={theme.appearance}
          selectionColor={theme.primary}
          value={hourlyRate}
          onChangeText={setHourlyRate}
          placeholder={t('Enter a rate you already know')}
          placeholderTextColor={theme.quietForeground}
          style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
        />
        <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{t('Regular hours')}</Text>
        <TextInput
          accessibilityLabel={t('Regular hours')}
          keyboardType="decimal-pad"
          keyboardAppearance={theme.appearance}
          selectionColor={theme.primary}
          value={regularHours}
          onChangeText={setRegularHours}
          placeholder={t('Hours in this period')}
          placeholderTextColor={theme.quietForeground}
          style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
        />
        <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{t('Overtime hours')}</Text>
        <TextInput
          accessibilityLabel={t('Overtime hours')}
          keyboardType="decimal-pad"
          keyboardAppearance={theme.appearance}
          selectionColor={theme.primary}
          value={overtimeHours}
          onChangeText={setOvertimeHours}
          placeholder={t('Optional')}
          placeholderTextColor={theme.quietForeground}
          style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
        />
        {numberOrZero(overtimeHours) > 0 ? (
          <>
            <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{t('Overtime multiplier')}</Text>
            <TextInput
              accessibilityLabel={t('Overtime multiplier')}
              keyboardType="decimal-pad"
              keyboardAppearance={theme.appearance}
              selectionColor={theme.primary}
              value={overtimeMultiplier}
              onChangeText={setOvertimeMultiplier}
              placeholder={t('Enter the contract rule if used')}
              placeholderTextColor={theme.quietForeground}
              style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
            />
          </>
        ) : null}
        <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{t('Night hours')}</Text>
        <TextInput
          accessibilityLabel={t('Night hours')}
          keyboardType="decimal-pad"
          keyboardAppearance={theme.appearance}
          selectionColor={theme.primary}
          value={nightHours}
          onChangeText={setNightHours}
          placeholder={t('Optional')}
          placeholderTextColor={theme.quietForeground}
          style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
        />
        {numberOrZero(nightHours) > 0 ? (
          <>
            <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{t('Night multiplier')}</Text>
            <TextInput
              accessibilityLabel={t('Night multiplier')}
              keyboardType="decimal-pad"
              keyboardAppearance={theme.appearance}
              selectionColor={theme.primary}
              value={nightMultiplier}
              onChangeText={setNightMultiplier}
              placeholder={t('Enter the contract rule if used')}
              placeholderTextColor={theme.quietForeground}
              style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
            />
          </>
        ) : null}
        <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{t('Weekend hours')}</Text>
        <TextInput
          accessibilityLabel={t('Weekend hours')}
          keyboardType="decimal-pad"
          keyboardAppearance={theme.appearance}
          selectionColor={theme.primary}
          value={weekendHours}
          onChangeText={setWeekendHours}
          placeholder={t('Optional')}
          placeholderTextColor={theme.quietForeground}
          style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
        />
        {numberOrZero(weekendHours) > 0 ? (
          <>
            <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{t('Weekend multiplier')}</Text>
            <TextInput
              accessibilityLabel={t('Weekend multiplier')}
              keyboardType="decimal-pad"
              keyboardAppearance={theme.appearance}
              selectionColor={theme.primary}
              value={weekendMultiplier}
              onChangeText={setWeekendMultiplier}
              placeholder={t('Enter the contract rule if used')}
              placeholderTextColor={theme.quietForeground}
              style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
            />
          </>
        ) : null}
        <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{t('Standby hours')}</Text>
        <TextInput
          accessibilityLabel={t('Standby hours')}
          keyboardType="decimal-pad"
          keyboardAppearance={theme.appearance}
          selectionColor={theme.primary}
          value={standbyHours}
          onChangeText={setStandbyHours}
          placeholder={t('Optional')}
          placeholderTextColor={theme.quietForeground}
          style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
        />
        {numberOrZero(standbyHours) > 0 ? (
          <>
            <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{t('Standby hourly rate')}</Text>
            <TextInput
              accessibilityLabel={t('Standby hourly rate')}
              keyboardType="decimal-pad"
              keyboardAppearance={theme.appearance}
              selectionColor={theme.primary}
              value={standbyHourlyRate}
              onChangeText={setStandbyHourlyRate}
              placeholder={t('Enter the contract rule if used')}
              placeholderTextColor={theme.quietForeground}
              style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
            />
          </>
        ) : null}
        <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{t('Grade')}</Text>
        <TextInput
          accessibilityLabel={t('Grade')}
          keyboardAppearance={theme.appearance}
          selectionColor={theme.primary}
          value={grade}
          onChangeText={setGrade}
          placeholder={t('Optional when entering a rate')}
          placeholderTextColor={theme.quietForeground}
          style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
        />
        <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{t('Step')}</Text>
        <TextInput
          accessibilityLabel={t('Step')}
          keyboardType="number-pad"
          keyboardAppearance={theme.appearance}
          selectionColor={theme.primary}
          value={stepNumber}
          onChangeText={setStepNumber}
          placeholder={t('Optional when entering a rate')}
          placeholderTextColor={theme.quietForeground}
          style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
        />
        {!hourlyRate.trim() && (grade.trim() || stepNumber.trim()) ? (
          <>
            <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{t('Calculation date')}</Text>
            <TextInput
              accessibilityLabel={t('Calculation date')}
              keyboardType="numbers-and-punctuation"
              keyboardAppearance={theme.appearance}
              selectionColor={theme.primary}
              value={effectiveOn}
              onChangeText={setEffectiveOn}
              placeholder={t('YYYY-MM-DD; required with grade and step')}
              placeholderTextColor={theme.quietForeground}
              style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
            />
          </>
        ) : null}
        <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{t('Amount already paid')}</Text>
        <TextInput
          accessibilityLabel={t('Amount already paid')}
          keyboardType="decimal-pad"
          keyboardAppearance={theme.appearance}
          selectionColor={theme.primary}
          value={amountPaid}
          onChangeText={setAmountPaid}
          placeholder={t('Optional')}
          placeholderTextColor={theme.quietForeground}
          style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
        />
        <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{t('Raise percent')}</Text>
        <TextInput
          accessibilityLabel={t('Raise percent')}
          keyboardType="decimal-pad"
          keyboardAppearance={theme.appearance}
          selectionColor={theme.primary}
          value={raisePercent}
          onChangeText={setRaisePercent}
          placeholder={t('Optional')}
          placeholderTextColor={theme.quietForeground}
          style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
        />
        <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{t('Unpaid pay periods')}</Text>
        <TextInput
          accessibilityLabel={t('Unpaid pay periods')}
          keyboardType="number-pad"
          keyboardAppearance={theme.appearance}
          selectionColor={theme.primary}
          value={unpaidPeriods}
          onChangeText={setUnpaidPeriods}
          placeholder={t('Optional')}
          placeholderTextColor={theme.quietForeground}
          style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
        />
        {raisePercent.trim() ? (
          <>
            <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{t('Annual hours')}</Text>
            <TextInput
              accessibilityLabel={t('Annual hours')}
              keyboardType="number-pad"
              keyboardAppearance={theme.appearance}
              selectionColor={theme.primary}
              value={hoursPerYear}
              onChangeText={setHoursPerYear}
              placeholder={t('Required for raise estimates')}
              placeholderTextColor={theme.quietForeground}
              style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
            />
            <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{t('Paychecks per year')}</Text>
            <TextInput
              accessibilityLabel={t('Paychecks per year')}
              keyboardType="number-pad"
              keyboardAppearance={theme.appearance}
              selectionColor={theme.primary}
              value={checksPerYear}
              onChangeText={setChecksPerYear}
              placeholder={t('Required for raise estimates')}
              placeholderTextColor={theme.quietForeground}
              style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
            />
          </>
        ) : null}
        <Button label={t('Estimate')} onPress={runEstimate} />
      </Card>
      <Card>
        <Heading level={3}>{t('Wage and back-pay calculator')}</Heading>
        {result ? <PayStatusPill state={result.state} /> : null}
        {result?.message ? <Body muted>{catalogLabel(result.message)}</Body> : null}
        {!result ? <Body muted>{t('Enter hours and either a direct rate or a published grade, step, and calculation date.')}</Body> : null}
        {result?.state === 'success' ? (
          <>
            <Body>{t('Hourly rate {amount}', { amount: result.rate.hourly })}</Body>
            {result.rate.annual ? <Body>{t('Annual pay {amount}', { amount: result.rate.annual })}</Body> : null}
            {result.cards.map((card: any) => (
              <Body key={card.kind}>{payBucketLabel(card.kind, t)} · {card.hours} h × {card.rate} = {card.amount}</Body>
            ))}
            <Body>{t('Gross owed {amount}', { amount: result.grossOwed })}</Body>
            {result.amountPaid ? <Body>{t('Amount already paid {amount}', { amount: result.amountPaid })}</Body> : null}
            <Body>{t('Wage underpayment {amount}', { amount: result.underpayment })}</Body>
            {result.raise ? (
              <>
                <Body>{t('Raise {percent}%', { percent: result.raise.percent })}</Body>
                <Body>{t('Current annual pay {amount}', { amount: result.raise.nowAnnual })}</Body>
                <Body>{t('New annual pay {amount}', { amount: result.raise.newAnnual })}</Body>
                <Body>{t('Annual raise difference {amount}', { amount: result.raise.annualDelta })}</Body>
                <Body>{t('Per-paycheck difference {amount}', { amount: result.raise.perCheckDelta })}</Body>
                <Body>{t('Raise retroactive pay {amount}', { amount: result.raise.retro })}</Body>
              </>
            ) : null}
            <Body>{t('Back pay {amount}', { amount: result.backPay })}</Body>
          </>
        ) : null}
        <Body muted>{result?.disclaimer ? catalogLabel(result.disclaimer) : t("Estimates use the rates you entered or a published employer scale. They are not payroll or legal advice. Talk with an organizer before relying on a figure.")}</Body>
      </Card>
      <CatalogPublisherCard
        key={payActor.selectedOrganizationId ?? 'no-organization'}
        actor={payActor}
        api={api}
        canWrite={writeGate.ok}
        announcementOwner={`${announcementOwner}:catalog`}
        onPublished={reloadCatalog}
      />
    </Screen>
  );
}

function gradePublishIssue(grade: string, title: string, stepCount: number | null): NativeUiKey | undefined {
  if (!normalizeGrade(grade)) return 'Enter a catalog grade of 1 to 32 characters on one line.';
  const titleLength = title.trim().length;
  if (titleLength < 1 || titleLength > 120) return 'Enter a grade title of 1 to 120 characters.';
  if (stepCount !== null && !normalizeStepNumber(stepCount)) return 'Number of steps must be a whole number from 1 to 99.';
}

function ratePublishIssue(rate: { organizationId: string; grade: string; stepNumber: number; effectiveOn: string; hourlyRate: number }): NativeUiKey | undefined {
  if (!normalizeGrade(rate.grade)) return 'Enter a published rate grade of 1 to 32 characters on one line.';
  if (!normalizeStepNumber(rate.stepNumber)) return 'Step must be a whole number from 1 to 99.';
  if (!isIsoDate(rate.effectiveOn)) return 'Enter a valid effective date as YYYY-MM-DD.';
  const hourlyRateCents = dollarsToCents(rate.hourlyRate);
  if (hourlyRateCents === null || hourlyRateCents < 1 || hourlyRateCents > 100_000_00) return 'Enter an hourly rate from $0.01 to $100,000.';
  if (!normalizePayScaleStep(rate)) return 'Check the catalog fields and try again.';
}

function CatalogPublisherCard({ actor, api, canWrite, announcementOwner, onPublished }: {
  actor: ReturnType<typeof toPayActor>;
  api: PayCatalogApi | null;
  canWrite: boolean;
  announcementOwner: string;
  onPublished: () => Promise<void>;
}) {
  const writer = useBusinessWriter();
  const requests = useBusinessRequests(writer);
  const { t } = useNativeUi();
  const theme = useTheme();
  const [grade, setGrade] = useBusinessDraftState('');
  const [title, setTitle] = useBusinessDraftState('');
  const [jobFamily, setJobFamily] = useBusinessDraftState('');
  const [stepCount, setStepCount] = useBusinessDraftState('');
  const [description, setDescription] = useBusinessDraftState('');
  const [rateGrade, setRateGrade] = useBusinessDraftState('');
  const [stepNumber, setStepNumber] = useBusinessDraftState('');
  const [effectiveOn, setEffectiveOn] = useBusinessDraftState('');
  const [hourlyRate, setHourlyRate] = useBusinessDraftState('');
  const [busy, setBusy] = useBusinessState<'grade' | 'step' | null>(null);
  const [operate] = useBusinessOperation<typeof busy>(setBusy, null);
  const [status, setStatus] = useBusinessDraftState<{ state: 'success' | 'error'; message: string } | null>(null);
  const organizationId = actor.selectedOrganizationId;
  const queueAnnouncement = useAccessibilityAnnouncementQueue(announcementOwner);
  const hasWriters = typeof api?.upsertGrade === 'function' && typeof api?.upsertStep === 'function';

  async function publish(kind: 'grade' | 'step', action: () => Promise<PayCatalogWrite>) {
    await operate(kind, async () => {
    const current = requests.capture().isCurrent;

    setStatus(null);
    try {
      const result = await action();
      const next: { state: 'success' | 'error'; message: string } = result.ok
        ? { state: 'success', message: kind === 'grade' ? t('Grade published for the selected organization.') : t('Rate published for the selected organization.') }
        : { state: 'error', message: result.reason === 'invalid_input' ? t('Check the catalog fields and try again.') : t('The pay-scale record could not be published. Try again.') };
      setStatus(next);
      const proof = await checkBusinessContinuation(writer, current);
      if (proof === 'changed') return;
      if (proof === 'unavailable') { if (result.ok) setStatus({ state: 'success', message: t(BUSINESS_SAVED_STALE) }); return; }
      queueAnnouncement(next.message);
      void (result.ok ? haptics.success() : haptics.warning());
      if (result.ok) await onPublished();
    } catch {
      const message = t('The pay-scale record could not be published. Try again.');
      setStatus({ state: 'error', message });
      if (!(await writer.isCurrent() && current())) return;
      queueAnnouncement(message);
      void haptics.warning();
    }

    });
  }

  if (!canWrite || !organizationId) {
    return <StateMessage title={t('Catalog publishing is restricted')} body={t('Only people with the Advisor, Admin or Campaign chair role in this organization can publish pay scales.')} />;
  }
  if (!actor.mfaSatisfied) {
    return <StateMessage title={t('MFA required')} body={t('Complete MFA before publishing pay-scale records.')} />;
  }
  if (!hasWriters) {
    return <StateMessage title={t('Catalog publishing unavailable')} body={t('Publishing is unavailable in this preview or offline session.')} />;
  }

  const steps = stepCount ? Number(stepCount) : null;
  const rate = {
    organizationId, grade: rateGrade, stepNumber: Number(stepNumber),
    effectiveOn: effectiveOn.trim(), hourlyRate: Number(hourlyRate),
  };
  const gradeIssue = gradePublishIssue(grade, title, steps);
  const rateIssue = ratePublishIssue(rate);
  const requiredLabel = (label: NativeUiKey) => t('{label} (required)', { label: t(label) });

  return (
    <Card>
      <Heading level={3}>{t('Publish pay-scale records')}</Heading>
      <Body muted>{t('Publish only organization-provided grades and rates. Your secure session supplies the selected organization.')}</Body>
      <Heading level={3}>{t('1. Publish a grade')}</Heading>
      <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{requiredLabel('Catalog grade')}</Text>
      <TextInput
        accessibilityLabel={requiredLabel('Catalog grade')}
        keyboardAppearance={theme.appearance}
        selectionColor={theme.primary}
        value={grade}
        onChangeText={setGrade}
        placeholder={t('Required')}
        placeholderTextColor={theme.quietForeground}
        style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
      />
      <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{requiredLabel('Grade title')}</Text>
      <TextInput
        accessibilityLabel={requiredLabel('Grade title')}
        keyboardAppearance={theme.appearance}
        selectionColor={theme.primary}
        value={title}
        onChangeText={setTitle}
        maxLength={120}
        placeholder={t('Required')}
        placeholderTextColor={theme.quietForeground}
        style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
      />
      <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{t('Job family')}</Text>
      <TextInput
        accessibilityLabel={t('Job family')}
        keyboardAppearance={theme.appearance}
        selectionColor={theme.primary}
        value={jobFamily}
        onChangeText={setJobFamily}
        maxLength={80}
        placeholder={t('Optional')}
        placeholderTextColor={theme.quietForeground}
        style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
      />
      <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{t('Number of steps')}</Text>
      <TextInput
        accessibilityLabel={t('Number of steps')}
        keyboardType="number-pad"
        keyboardAppearance={theme.appearance}
        selectionColor={theme.primary}
        value={stepCount}
        onChangeText={setStepCount}
        placeholder={t('Optional, 1–99')}
        placeholderTextColor={theme.quietForeground}
        style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
      />
      <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{t('Grade description')}</Text>
      <TextInput
        accessibilityLabel={t('Grade description')}
        keyboardAppearance={theme.appearance}
        selectionColor={theme.primary}
        value={description}
        onChangeText={setDescription}
        maxLength={400}
        multiline
        placeholder={t('Optional')}
        placeholderTextColor={theme.quietForeground}
        style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
      />
      <Button
        label={t('Publish grade')}
        busy={busy === 'grade'}
        disabled={busy === 'step' || Boolean(gradeIssue)}
        disabledReason={busy === null && gradeIssue ? t(gradeIssue) : undefined}
        onPress={() => {
          if (!api.upsertGrade) return;
          void publish('grade', () => api.upsertGrade!(actor, {
            organizationId,
            grade,
            title,
            jobFamily: jobFamily || null,
            stepCount: steps,
            description: description || null,
          }));
        }}
      />
      <Heading level={3}>{t('2. Publish an effective rate')}</Heading>
      <Body muted>{t('Publish the grade first, then add each step and effective-date rate.')}</Body>
      <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{requiredLabel('Rate grade')}</Text>
      <TextInput
        accessibilityLabel={requiredLabel('Rate grade')}
        keyboardAppearance={theme.appearance}
        selectionColor={theme.primary}
        value={rateGrade}
        onChangeText={setRateGrade}
        placeholder={t('Published grade')}
        placeholderTextColor={theme.quietForeground}
        style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
      />
      <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{requiredLabel('Catalog step')}</Text>
      <TextInput
        accessibilityLabel={requiredLabel('Catalog step')}
        keyboardType="number-pad"
        keyboardAppearance={theme.appearance}
        selectionColor={theme.primary}
        value={stepNumber}
        onChangeText={setStepNumber}
        placeholder="1–99"
        placeholderTextColor={theme.quietForeground}
        style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
      />
      <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{requiredLabel('Rate effective date')}</Text>
      <TextInput
        accessibilityLabel={requiredLabel('Rate effective date')}
        keyboardType="numbers-and-punctuation"
        keyboardAppearance={theme.appearance}
        selectionColor={theme.primary}
        value={effectiveOn}
        onChangeText={setEffectiveOn}
        placeholder={t('YYYY-MM-DD')}
        placeholderTextColor={theme.quietForeground}
        style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
      />
      <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{requiredLabel('Published hourly rate')}</Text>
      <TextInput
        accessibilityLabel={requiredLabel('Published hourly rate')}
        keyboardType="decimal-pad"
        keyboardAppearance={theme.appearance}
        selectionColor={theme.primary}
        value={hourlyRate}
        onChangeText={setHourlyRate}
        placeholder={t('Dollars per hour')}
        placeholderTextColor={theme.quietForeground}
        style={[styles.input, { backgroundColor: theme.input, borderColor: theme.border, color: theme.foreground }]}
      />
      <Button
        label={t('Publish rate')}
        busy={busy === 'step'}
        disabled={busy === 'grade' || Boolean(rateIssue)}
        disabledReason={busy === null && rateIssue ? t(rateIssue) : undefined}
        onPress={() => {
          if (!api.upsertStep) return;
          void publish('step', () => api.upsertStep!(actor, rate));
        }}
      />
      {status ? (
        <View accessibilityLiveRegion="polite">
          <PayStatusPill state={status.state} label={status.state === 'success' ? t('Published') : t('Not published')} />
          <Body muted>{status.message}</Body>
        </View>
      ) : null}
    </Card>
  );
}
