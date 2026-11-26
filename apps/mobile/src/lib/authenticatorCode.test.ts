import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { AUTHENTICATOR_CODE_LENGTH, cleanAuthenticatorCode, isAuthenticatorCode } from './authenticatorCode';

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

// BUG-UG-MFA-CODE-FIELD-ACCEPTS-LETTERS-AND-OVERLENGTH-20261104
// (#7052): the native six-digit fields follow the web's rule.
describe('native six-digit authenticator code fields', () => {
  it('drops letters, stops at six and cleans a pasted code with spaces', () => {
    expect(AUTHENTICATOR_CODE_LENGTH).toBe(6);
    expect(cleanAuthenticatorCode('5555jmkjm')).toBe('5555');
    expect(cleanAuthenticatorCode('5555678')).toBe('555567');
    expect(cleanAuthenticatorCode('123 456')).toBe('123456');
    expect(cleanAuthenticatorCode('1234 5678')).toBe('123456');
  });

  it('enables submit only for exactly six digits', () => {
    expect(isAuthenticatorCode('123456')).toBe(true);
    expect(isAuthenticatorCode('12345')).toBe(false);
    expect(isAuthenticatorCode('1234567')).toBe(false);
    expect(isAuthenticatorCode('123 456')).toBe(false);
  });

  it('is the one filter and submit gate on the two-factor check and the emailed reset', () => {
    const mfa = read('../../app/mfa-challenge.tsx');
    expect(mfa).toContain('onChangeText={(value) => setCode(cleanAuthenticatorCode(value))}');
    expect(mfa).toContain('disabled={working || Boolean(recoveryCleanup.current) || !isAuthenticatorCode(code)}');
    expect(mfa).toContain('if (!isAuthenticatorCode(code)) return;');
    expect(mfa).not.toMatch(/\\d\{6,8\}/);
    // Recovery codes keep their own field and shape.
    expect(mfa).toContain("onChangeText={(value) => setRecoveryCode(value.replace(/[^A-Za-z0-9- ]/g, ''))}");

    const reset = read('../components/EmailAuthScreen.tsx');
    expect(reset).toContain('onChangeText={(value) => setCode(cleanAuthenticatorCode(value))}');
    expect(reset).toContain('isAuthenticatorCode(code)');
  });

  // Gate round 1 (#7058): the cleaner is the six-digit cap on both native
  // fields, and neither carries maxLength, which React Native applies to a
  // paste before onChangeText and would turn "123 456" into "123 45".
  const mfa = read('../../app/mfa-challenge.tsx');
  const reset = read('../components/EmailAuthScreen.tsx');
  const challengeField = mfa.slice(mfa.indexOf('accessibilityLabel="Authenticator code"'), mfa.indexOf('onSubmitEditing'));
  const resetStart = reset.slice(reset.indexOf('accessibilityLabel={copy.code}'));
  const resetField = resetStart.slice(0, resetStart.indexOf('/>'));
  // What each field's onChangeText stores after the platform hands it text.
  const typeInto = (field: string, current: string, typed: string) => {
    expect(field).toContain('onChangeText={(value) => setCode(cleanAuthenticatorCode(value))}');
    return cleanAuthenticatorCode(current + typed);
  };

  it.each([['two-factor check', challengeField], ['emailed reset', resetField]])('drops a seventh typed digit on the %s field', (_name, field) => {
    expect(typeInto(field, '123456', '7')).toBe('123456');
    expect(field).not.toContain('maxLength');
  });

  it.each([['two-factor check', challengeField], ['emailed reset', resetField]])('turns a pasted "123 456" into "123456" on the %s field', (_name, field) => {
    expect(typeInto(field, '', '123 456')).toBe('123456');
    expect(typeInto(field, '', '5555jmkjm')).toBe('5555');
  });

  it('keeps submit off under six digits on both screens', () => {
    for (const partial of ['', '1', '12345', typeInto(challengeField, '', '12 34 5')]) expect(isAuthenticatorCode(partial)).toBe(false);
    expect(mfa).toContain('disabled={working || Boolean(recoveryCleanup.current) || !isAuthenticatorCode(code)}');
    expect(mfa).toContain('if (!isAuthenticatorCode(code)) return;');
    expect(reset).toContain('const codeReady = useRecovery ? RECOVERY_CODE_PATTERN.test(code) : isAuthenticatorCode(code);');
    expect(reset).toContain('&& confirmation === password && codeReady && !busy;');
    expect(reset).toContain('disabled={!canFinish}');
    expect(reset).toContain('if (!recovery || inFlight.current || !canFinish) return;');
    // Recovery fields keep their longer limit.
    expect(mfa).toContain('maxLength={32}');
    expect(reset).toContain('autoComplete="off" maxLength={32}');
  });
});

// PRES-P5 (Nov 6, 2026): a staff sign-in lands on the code field right under
// the heading; the two-step setup hint follows the Verify button, so the
// field stays above the keyboard the field opens.
describe('native authenticator code screen order', () => {
  const mfa = read('../../app/mfa-challenge.tsx');
  const form = mfa.slice(mfa.indexOf('<Heading>{catalogLabel("Enter your authenticator code")}</Heading>'));
  it('puts the code field and Verify before the two-step setup hint and the recovery code', () => {
    const at = (text: string) => {
      const index = form.indexOf(text);
      expect(index, text).toBeGreaterThan(-1);
      return index;
    };
    expect(at('accessibilityLabel="Authenticator code"')).toBeLessThan(at("'Verify code'"));
    expect(at("'Verify code'")).toBeLessThan(at('If your organization requires two-step'));
    expect(at('If your organization requires two-step')).toBeLessThan(at('label={twoStep.action}'));
    expect(at('label={twoStep.action}')).toBeLessThan(at('accessibilityLabel="Use a recovery code"'));
  });
});
