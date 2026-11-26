import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../../app/sign-in.tsx', import.meta.url), 'utf8');
const emailInputs = [...source.matchAll(/<TextInput\b[\s\S]*?\/>/g)]
  .map(([input]) => input)
  .filter((input) => input.includes('accessibilityLabel="Email address"'));

describe('native sign-in email input', () => {
  it('has exactly one labelled email field', () => {
    expect(emailInputs).toHaveLength(1);
  });

  it.each(['autoCorrect', 'spellCheck'])('disables %s on the email field', (prop) => {
    expect(emailInputs[0]).toContain(`${prop}={false}`);
  });

  it.each(['autoCapitalize="none"', 'autoComplete="email"', 'keyboardType="email-address"'])
  ('keeps %s on the email field', (prop) => {
    expect(emailInputs[0]).toContain(prop);
  });
});
