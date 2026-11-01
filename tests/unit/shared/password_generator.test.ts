import { describe, expect, test } from 'bun:test';
import {
  passwordGenerate,
  PASSWORD_ALPHABET_DIGITS,
  PASSWORD_ALPHABET_SPECIAL,
  PASSWORD_ALPHABET_UPPERCASE,
} from '../../../src/shared/password_generator.ts';
import { passwordPolicyIsAcceptable } from '../../../src/shared/password_policy.ts';

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
