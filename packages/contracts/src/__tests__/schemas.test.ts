import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CliProjectRefSchema,
  CliSessionRefSchema,
  ParsedMessageSchema,
  RoleSchema,
  SanitizedSessionSchema,
} from '../index.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// A fully-populated, reader-shaped envelope built from obviously-fake canary
// values — never real session data or keys.
function fakeEnvelope() {
  return {
    schemaVersion: '0.1.0',
    meta: {
      contributorAlias: 'fake-contributor-0001',
      sourceCli: 'claude-code' as const,
      toolVersion: 'mosga-test-0.0.0',
      sanitizationRulesetVersion: null,
      exportedAt: '2026-07-07T00:00:00.000Z',
      license: null,
      sanitized: false,
    },
    session: {
      sessionId: 'fake-session-id',
      sourceId: 'claude-code',
      projectKey: 'C--fake-project',
      cwd: 'C:\\fake\\project',
      title: 'a fake session',
      updatedAt: 1_700_000_000_000,
    },
    messages: [
      {
        sdkUuid: 'uuid-1',
        parentUuid: null,
        role: 'user' as const,
        content: 'hello from a fake fixture',
        sdkMessageType: 'user',
        timestamp: 1_700_000_000_000,
      },
    ],
  };
}

describe('reader reference schemas', () => {
  it('accepts a well-formed project ref', () => {
    const ref = { sourceId: 'claude-code', key: 'slug', cwd: null, label: 'slug' };
    expect(CliProjectRefSchema.parse(ref)).toEqual(ref);
  });

  it('rejects a session ref missing a required field (path)', () => {
    const bad = {
      sourceId: 'claude-code',
      projectKey: 'slug',
      id: 'sess',
      // path missing
      title: null,
      cwd: null,
      updatedAt: 1,
      sizeBytes: 1,
    };
    expect(CliSessionRefSchema.safeParse(bad).success).toBe(false);
  });
});

describe('parsed-message schema', () => {
  it('round-trips a message carrying tool calls and thinking', () => {
    const msg = {
      sdkUuid: 'uuid-2',
      parentUuid: 'uuid-1',
      role: 'assistant' as const,
      content: '',
      sdkMessageType: 'assistant',
      timestamp: 2,
      thinking: 'fake reasoning',
      toolCalls: [
        {
          id: 'tool-1',
          name: 'Read',
          input: { file: 'x' },
          status: 'completed' as const,
          result: 'ok',
        },
      ],
    };
    expect(ParsedMessageSchema.parse(msg)).toEqual(msg);
  });

  it('rejects a role outside user|assistant|system', () => {
    expect(RoleSchema.safeParse('robot').success).toBe(false);
    const msg = {
      sdkUuid: 'u',
      parentUuid: null,
      role: 'robot',
      content: 'x',
      sdkMessageType: 'user',
      timestamp: 1,
    };
    expect(ParsedMessageSchema.safeParse(msg).success).toBe(false);
  });
});

describe('sanitized-session envelope', () => {
  it('accepts a reader-produced envelope (sanitized:false, ruleset:null)', () => {
    expect(SanitizedSessionSchema.safeParse(fakeEnvelope()).success).toBe(true);
  });

  it('accepts sourceCli "claude-code"', () => {
    const env = fakeEnvelope();
    env.meta.sourceCli = 'claude-code';
    expect(SanitizedSessionSchema.safeParse(env).success).toBe(true);
  });

  it('rejects an envelope missing a required meta field', () => {
    const env = fakeEnvelope() as Record<string, any>;
    delete env.meta.toolVersion;
    expect(SanitizedSessionSchema.safeParse(env).success).toBe(false);
  });
});

// --- doc/code anti-drift (task 2.8) ---------------------------------------

/** Recursively collect every field name reachable in a zod schema shape. */
function collectSchemaKeys(schema: any, out: Set<string>): void {
  if (!schema) return;
  if (typeof schema.unwrap === 'function') {
    collectSchemaKeys(schema.unwrap(), out);
    return;
  }
  const element = schema.element;
  if (element) {
    collectSchemaKeys(element, out);
    return;
  }
  const shape = schema.shape;
  if (shape && typeof shape === 'object') {
    for (const [key, value] of Object.entries(shape)) {
      out.add(key);
      collectSchemaKeys(value, out);
    }
  }
}

/** Field names documented in SCHEMA.md = the first cell of each table data row. */
function documentedFieldNames(md: string): string[] {
  const names: string[] = [];
  for (const line of md.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = trimmed.split('|').map((c) => c.trim());
    // cells[0] is '' (leading pipe); cells[1] is the Field column.
    const field = (cells[1] ?? '').replace(/`/g, '').trim();
    if (!field) continue;
    if (field === 'Field') continue; // header row
    if (/^-+$/.test(field)) continue; // separator row
    names.push(field);
  }
  return names;
}

describe('SCHEMA.md ↔ SanitizedSessionSchema (no doc/code drift)', () => {
  const md = readFileSync(path.join(here, '..', '..', 'SCHEMA.md'), 'utf-8');

  it('carries the calibration banner as its first content block', () => {
    const firstContent = md.split('\n').find((l) => l.trim().length > 0) ?? '';
    expect(firstContent).toContain('待发起人腹稿校准');
  });

  it('every documented field exists in SanitizedSessionSchema', () => {
    const schemaKeys = new Set<string>();
    collectSchemaKeys(SanitizedSessionSchema, schemaKeys);
    const documented = documentedFieldNames(md);
    // sanity: the walker actually found the nested keys
    expect(schemaKeys.has('contributorAlias')).toBe(true);
    expect(schemaKeys.has('blockTypes')).toBe(true);
    const missing = documented.filter((name) => !schemaKeys.has(name));
    expect(missing).toEqual([]);
  });
});
