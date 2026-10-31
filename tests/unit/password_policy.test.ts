import { describe, expect, test } from 'bun:test';
import { passwordGenerate, PASSWORD_ALPHABET_DIGITS, PASSWORD_ALPHABET_SPECIAL, PASSWORD_ALPHABET_UPPERCASE } from '../../src/shared/password_generator.ts';
import { passwordPolicyEvaluate, passwordPolicyIsAcceptable } from '../../src/shared/password_policy.ts';

describe('password policy', () => {
  test.each([
    ['00000000', 'repeated_characters'],
    ['Abc1!', 'too_short'],
    ['abcdefg1!', 'missing_uppercase'],
    ['Abcdefgh!', 'missing_digit'],
    ['Abcdefgh1', 'missing_special'],
    ['aaaaaaaA1!', 'repeated_characters'],
    ['Password1!', 'common_password'],
    ['P@ssw0rd123!', 'common_password'],
    ['Abcd1234!x', 'sequence'],
    ['Qwerty12!z', 'sequence'],
    ['Zxcvbn7!kq', 'sequence'],
    ['Aa1!Aa1!Aa1!', 'low_variety'],
  ])('rejects %p (%s)', (password, issue) => {
    const result = passwordPolicyEvaluate(password);
    expect(result.ok).toBe(false);
    expect(result.issues).toContain(issue as never);
  });

  test('rejects control characters and overly long input', () => {
    expect(passwordPolicyEvaluate('Good\u0000Pass9!x').issues).toContain('invalid_characters');
    expect(passwordPolicyEvaluate(`Aa1!${'xY7#'.repeat(40)}`).issues).toContain('too_long');
  });

  test.each(['Tq7#mRw2!xLp', 'Gx9$vNk4@Lb', 'blue-Ocean7!river', 'Jy4&Rk8%Wz', 'Fähre-Blau9!'])('accepts %p', (password) => {
    const result = passwordPolicyEvaluate(password);
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.estimatedBits).toBeGreaterThanOrEqual(40);
  });
});

describe('password generator', () => {
  test('1000 generated passwords all pass the policy and are unique', () => {
    const generated = new Set<string>();
    for (let index = 0; index < 1000; index++) {
      const password = passwordGenerate();
      expect(password.length).toBe(16);
      expect(passwordPolicyIsAcceptable(password)).toBe(true);
      generated.add(password);
    }
    expect(generated.size).toBe(1000);
  });

  test('contains every character class and clamps the length', () => {
    for (let index = 0; index < 200; index++) {
      const password = passwordGenerate(12);
      expect([...password].some((c) => PASSWORD_ALPHABET_UPPERCASE.includes(c))).toBe(true);
      expect([...password].some((c) => PASSWORD_ALPHABET_DIGITS.includes(c))).toBe(true);
      expect([...password].some((c) => PASSWORD_ALPHABET_SPECIAL.includes(c))).toBe(true);
    }
    expect(passwordGenerate(4).length).toBe(12);
    expect(passwordGenerate(1000).length).toBe(128);
  });
});
