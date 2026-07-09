/**
 * secrets.test.ts — the ported AES-256-GCM envelope codec + SecretBox tri-state
 * + master-key lifecycle (tasks 3.4).
 *
 * Covers: round-trip identity, random-IV (different ciphertext each encrypt),
 * `enc:v1:` format, tri-state passthrough ($ENV never encrypted / already-enc
 * not double-encrypted / legacy plaintext read passthrough), encryptMaybe /
 * decryptMaybe idempotence, the wrong-key GCM auth-tag failure UX, and master-key
 * resolution order (env beats keyfile + is not written; auto-generate last; lazy).
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  decryptValue,
  encryptValue,
  ENVELOPE_PREFIX,
  isEnvelope,
  parseEnvelope,
  MASTER_KEY_ENV,
  resolveMasterKey,
  SecretBox,
} from '../secrets/index.js';

const KEY_A = randomBytes(32);
const KEY_B = randomBytes(32);

describe('envelope codec (3.1)', () => {
  it('round-trips a plaintext byte-for-byte', () => {
    const env = encryptValue('sk-test-1234', KEY_A);
    expect(decryptValue(env, KEY_A)).toBe('sk-test-1234');
  });

  it('emits a well-formed enc:v1:<iv>:<tag>:<ciphertext> envelope', () => {
    const env = encryptValue('sk-test-1234', KEY_A);
    expect(env.startsWith('enc:v1:')).toBe(true);
    expect(isEnvelope(env)).toBe(true);
    const parts = env.split(':');
    expect(parts).toHaveLength(5);
    expect(`${parts[0]}:`).toBe(ENVELOPE_PREFIX);
    expect(parts[1]).toBe('v1');
    const parsed = parseEnvelope(env);
    expect(parsed.iv).toHaveLength(12);
    expect(parsed.tag).toHaveLength(16);
  });

  it('produces a DIFFERENT ciphertext each encrypt (random IV, no reuse)', () => {
    const a = encryptValue('same-plaintext', KEY_A);
    const b = encryptValue('same-plaintext', KEY_A);
    expect(a).not.toBe(b);
    expect(parseEnvelope(a).iv.equals(parseEnvelope(b).iv)).toBe(false);
    expect(decryptValue(a, KEY_A)).toBe('same-plaintext');
    expect(decryptValue(b, KEY_A)).toBe('same-plaintext');
  });

  it('round-trips unicode + empty + long values', () => {
    for (const v of ['', '🔐-secret-✓', 'x'.repeat(5000)]) {
      expect(decryptValue(encryptValue(v, KEY_A), KEY_A)).toBe(v);
    }
  });

  it('rejects a malformed envelope without leaking material', () => {
    expect(() => parseEnvelope('enc:v1:onlytwo')).toThrow(/malformed/);
    expect(() => parseEnvelope('enc:v2:aa:bb:cc')).toThrow(/version/);
  });
});

describe('SecretBox tri-state (3.3)', () => {
  const box = new SecretBox(KEY_A);

  it('encryptMaybe NEVER encrypts a $ENV reference', () => {
    expect(box.encryptMaybe('$OPENAI_KEY')).toBe('$OPENAI_KEY');
  });

  it('encryptMaybe does NOT double-encrypt an already-enc value', () => {
    const once = box.encryptMaybe('sk-literal');
    expect(isEnvelope(once)).toBe(true);
    const twice = box.encryptMaybe(once);
    expect(twice).toBe(once); // no enc:enc: nesting, byte-identical
  });

  it('encryptMaybe encrypts a legacy plaintext literal', () => {
    const out = box.encryptMaybe('sk-literal');
    expect(isEnvelope(out)).toBe(true);
    expect(box.decryptMaybe(out)).toBe('sk-literal');
  });

  it('decryptMaybe passes a $ENV reference + legacy plaintext through', () => {
    expect(box.decryptMaybe('$OPENAI_KEY')).toBe('$OPENAI_KEY');
    expect(box.decryptMaybe('sk-legacy-plain')).toBe('sk-legacy-plain');
  });

  it('decryptMaybe is idempotent on a non-envelope value', () => {
    expect(box.decryptMaybe(box.decryptMaybe('sk-legacy'))).toBe('sk-legacy');
  });

  it('encryptMaybe/decryptMaybe pass empty string through', () => {
    expect(box.encryptMaybe('')).toBe('');
    expect(box.decryptMaybe('')).toBe('');
  });
});

describe('wrong-key / tamper UX (3.4)', () => {
  it('decrypting with a DIFFERENT key throws a clear, secret-free error', () => {
    const env = encryptValue('sk-secret-value-zzz', KEY_A);
    const boxB = new SecretBox(KEY_B);
    let thrown: Error | undefined;
    try {
      boxB.decrypt(env);
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.message).toMatch(/master key does not match|tampered/i);
    expect(thrown!.message).not.toContain(env);
    expect(thrown!.message).not.toContain('sk-secret-value-zzz');
    expect(thrown!.message).not.toContain(KEY_A.toString('base64'));
    expect(thrown!.message).not.toContain(KEY_B.toString('base64'));
  });

  it('a tampered ciphertext fails GCM verification', () => {
    const env = encryptValue('sk-secret', KEY_A);
    const parts = env.split(':');
    const ct = parts[4];
    parts[4] = ct.slice(0, -1) + (ct.endsWith('A') ? 'B' : 'A');
    const tampered = parts.join(':');
    const box = new SecretBox(KEY_A);
    expect(() => box.decrypt(tampered)).toThrow(/master key does not match|tampered/i);
  });

  it('SecretBox rejects a non-32-byte key', () => {
    expect(() => new SecretBox(randomBytes(16))).toThrow(/32-byte/);
  });
});

describe('master key resolution (3.2)', () => {
  const HEX_64 = 'a'.repeat(64); // 32 bytes of 0xaa
  const B64_32 = Buffer.alloc(32, 7).toString('base64');
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mosga-mk-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('auto-generates a 32-byte keyfile when none exists', () => {
    const keyFilePath = join(tmpDir, 'sub', 'master.key');
    expect(existsSync(keyFilePath)).toBe(false);
    const key = resolveMasterKey({ envVar: undefined, keyFilePath });
    expect(key).toHaveLength(32);
    expect(existsSync(keyFilePath)).toBe(true);
    expect(readFileSync(keyFilePath)).toHaveLength(32);
  });

  it('reuses an existing keyfile (stable key across resolves)', () => {
    const keyFilePath = join(tmpDir, 'master.key');
    const first = resolveMasterKey({ envVar: undefined, keyFilePath });
    const second = resolveMasterKey({ envVar: undefined, keyFilePath });
    expect(first.equals(second)).toBe(true);
  });

  it.runIf(process.platform !== 'win32')('writes the auto-gen keyfile with 0600 mode (POSIX)', () => {
    const keyFilePath = join(tmpDir, 'master.key');
    resolveMasterKey({ envVar: undefined, keyFilePath });
    const mode = statSync(keyFilePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('env (64 hex) beats the keyfile AND is NOT written to disk', () => {
    const keyFilePath = join(tmpDir, 'master.key');
    writeFileSync(keyFilePath, Buffer.alloc(32, 9));
    const before = readFileSync(keyFilePath);
    const key = resolveMasterKey({ envVar: HEX_64, keyFilePath });
    expect(key.equals(Buffer.from(HEX_64, 'hex'))).toBe(true);
    expect(readFileSync(keyFilePath).equals(before)).toBe(true);
  });

  it('env accepts base64-encoded 32 bytes', () => {
    const key = resolveMasterKey({ envVar: B64_32, keyFilePath: join(tmpDir, 'k') });
    expect(key.equals(Buffer.from(B64_32, 'base64'))).toBe(true);
  });

  it('env does NOT auto-generate a keyfile (highest priority, no disk write)', () => {
    const keyFilePath = join(tmpDir, 'never.key');
    resolveMasterKey({ envVar: HEX_64, keyFilePath });
    expect(existsSync(keyFilePath)).toBe(false);
  });

  it('fails fast on an invalid env length (no silent half-key)', () => {
    expect(() => resolveMasterKey({ envVar: 'too-short', keyFilePath: join(tmpDir, 'k') })).toThrow(
      new RegExp(MASTER_KEY_ENV),
    );
  });

  it('is lazy: a SecretBox that only passes plaintext through writes no keyfile', () => {
    const keyFilePath = join(tmpDir, 'lazy.key');
    const box = new SecretBox(() => resolveMasterKey({ envVar: undefined, keyFilePath }));
    expect(box.decryptMaybe('sk-legacy-plain')).toBe('sk-legacy-plain');
    expect(box.encryptMaybe('$ENV_REF')).toBe('$ENV_REF');
    expect(existsSync(keyFilePath)).toBe(false); // key never resolved → no keyfile
  });
});
