/** Parsing the optional JSON config file and finding its path. */
import { describe, expect, test } from 'bun:test';
import {
  configurationFileParse,
  configurationFilePath,
  configurationFileRead,
} from '../../../src/config/configuration_file.ts';

describe('configuration file parsing', () => {
  test('numbers, booleans, strings and string lists become raw values', () => {
    const values = configurationFileParse(
      JSON.stringify({
        PORT: 8443,
        TRUST_PROXY: false,
        HOST: '::',
        ALLOWED_ORIGINS: ['https://a.example', 'https://b.example'],
      }),
      'relay.json',
    );
    expect(values).toEqual({
      PORT: '8443',
      TRUST_PROXY: 'false',
      HOST: '::',
      ALLOWED_ORIGINS: 'https://a.example,https://b.example',
    });
  });

  test('unknown settings, wrong value types, non-objects and invalid JSON are errors naming the file', () => {
    expect(() => configurationFileParse('{"PROT": 1}', 'relay.json')).toThrow('relay.json: unknown setting "PROT"');
    expect(() => configurationFileParse('{"PORT": {"x": 1}}', 'relay.json')).toThrow('relay.json: PORT must be');
    expect(() => configurationFileParse('[1]', 'relay.json')).toThrow('must be a JSON object');
    expect(() => configurationFileParse('{', 'relay.json')).toThrow('relay.json: invalid JSON');
  });

  test('a missing config file is an error', async () => {
    await expect(configurationFileRead('/nonexistent/aiworlded/relay.json')).rejects.toThrow('config file not found');
  });
});

describe('configuration file path', () => {
  test('--config <path>, --config=<path> and CONFIG_FILE, in that order', () => {
    expect(configurationFilePath(['--config', 'a.json'], { CONFIG_FILE: 'c.json' })).toBe('a.json');
    expect(configurationFilePath(['--config=b.json'], { CONFIG_FILE: 'c.json' })).toBe('b.json');
    expect(configurationFilePath([], { CONFIG_FILE: 'c.json' })).toBe('c.json');
    expect(configurationFilePath([], {})).toBeNull();
  });

  test('--config without a path is an error', () => {
    expect(() => configurationFilePath(['--config'], {})).toThrow('--config needs a file path');
    expect(() => configurationFilePath(['--config='], {})).toThrow('--config needs a file path');
  });
});
