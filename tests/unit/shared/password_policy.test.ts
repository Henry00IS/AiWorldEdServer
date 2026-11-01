import { describe, expect, test } from 'bun:test';
import { passwordPolicyEvaluate } from '../../../src/shared/password_policy.ts';

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

  test.each(['Tq7#mRw2!xLp', 'Gx9$vNk4@Lb', 'blue-Ocean7!river', 'Jy4&Rk8%Wz', 'Fähre-Blau9!'])(
    'accepts %p',
    (password) => {
      const result = passwordPolicyEvaluate(password);
      expect(result.issues).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.estimatedBits).toBeGreaterThanOrEqual(40);
    },
  );
});
