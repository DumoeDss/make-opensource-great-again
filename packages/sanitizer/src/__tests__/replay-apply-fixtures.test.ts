import { describe, expect, it } from 'vitest';

import { canonicalJson } from '../canonical.js';
import { applyReplayDispositions } from '../replayApply.js';
import { scanReplayDraft } from '../replayScan.js';
import type { CompiledRuleset } from '../schemas.js';
import { makeReplayDraft } from './replay-fixtures.js';

const AT = '2026-07-27T00:00:00.000Z';

function ruleset(
  patterns: Array<{
    id: string;
    pattern: string;
    replacement?: string;
  }>,
): CompiledRuleset {
  return {
    rulesetVersion: 'rules-1',
    gitleaksVersion: 'fake',
    generatedAt: AT,
    rules: [],
    customRules: patterns.map((pattern) => ({
      kind: 'literal',
      ...pattern,
    })),
    degraded: [],
  };
}

function applyOptions(activeRuleset: CompiledRuleset) {
  return {
    ruleset: activeRuleset,
    expectedRulesetVersion: 'rules-1',
    decisionVersion: 'fixture-decisions-1',
    approvedAt: AT,
  };
}

describe('fake replay apply fixtures', () => {
  it('batch-applies native/metadata replacements and instruction deletion with no canaries in canonical content', () => {
    const replaceCanary = 'CROSS_ARTIFACT_REPLACE_CANARY';
    const deleteCanary = 'INSTRUCTION_DELETE_CANARY';
    const draft = makeReplayDraft();
    draft.nativeSession.files[0]!.rows[0]!.value = {
      type: 'future',
      nested: {
        secret: `before ${replaceCanary} after`,
        untouched: ['reference-1', 4, false, null],
      },
    };
    draft.instructionSnapshot.files[0]!.content =
      `approved ${deleteCanary} instructions`;
    draft.omissions[0]!.disclosure =
      `metadata ${replaceCanary} disclosure`;
    const before = structuredClone(draft);
    const activeRuleset = ruleset([
      {
        id: 'replace-canary',
        pattern: replaceCanary,
        replacement: '<SAFE_ALIAS>',
      },
      { id: 'delete-canary', pattern: deleteCanary },
    ]);
    const scan = scanReplayDraft(draft, activeRuleset, { generatedAt: AT });
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    const report = structuredClone(scan.report);
    report.findings = report.findings.map((finding) => ({
      ...finding,
      disposition:
        finding.ruleId === 'delete-canary'
          ? ('delete' as const)
          : finding.blocking
            ? ('replace' as const)
            : finding.disposition,
    }));

    const result = applyReplayDispositions(
      draft,
      report,
      scan.mapper,
      applyOptions(activeRuleset),
    );

    expect(result.ok).toBe(true);
    if (!result.ok || result.sealablePayload === null) return;
    expect(
      (
        result.draft.nativeSession.files[0]!.rows[0]!.value as {
          nested: { secret: string };
        }
      ).nested.secret,
    ).toBe('before <SAFE_ALIAS> after');
    expect(result.draft.instructionSnapshot.files[0]!.content).toBe(
      'approved  instructions',
    );
    expect(result.draft.omissions[0]!.disclosure).toBe(
      'metadata <SAFE_ALIAS> disclosure',
    );
    const canonicalContent = canonicalJson(result.sealablePayload);
    expect(canonicalContent).not.toContain(replaceCanary);
    expect(canonicalContent).not.toContain(deleteCanary);
    expect(draft).toEqual(before);
  });

  it.each(['claude-code', 'codex'] as const)(
    'preserves %s native rows, unknown fields, scalar types, and references',
    (sourceCli) => {
      const canary = 'STRUCTURE_PRESERVATION_CANARY';
      const draft = makeReplayDraft();
      if (sourceCli === 'codex') {
        draft.source = {
          ...draft.source,
          sourceCli: 'codex',
          sourceFormat: 'codex-jsonl',
        };
        draft.nativeSession.sourceCli = 'codex';
        draft.nativeSession.sourceFormat = 'codex-jsonl';
        draft.terminalManifestSeed.source = structuredClone(draft.source);
      }
      draft.nativeSession.files[0]!.rows =
        sourceCli === 'codex'
          ? [
              {
                ordinal: 0,
                value: {
                  type: 'session_meta',
                  payload: {
                    id: 'session-reference',
                    future: { scalar: 3 },
                  },
                },
              },
              {
                ordinal: 1,
                value: {
                  type: 'turn_context',
                  payload: {
                    privateNote: `prefix ${canary} suffix`,
                    enabled: true,
                  },
                },
              },
              {
                ordinal: 2,
                value: {
                  type: 'response_item',
                  payload: {
                    type: 'function_call',
                    call_id: 'tool-reference',
                    arguments: '{"safe":true}',
                  },
                },
              },
              {
                ordinal: 3,
                value: {
                  type: 'event_msg',
                  payload: {
                    call_id: 'tool-reference',
                    mirrored: true,
                  },
                },
              },
            ]
          : [
              {
                ordinal: 0,
                value: {
                  type: 'assistant',
                  sessionId: 'session-reference',
                  uuid: 'assistant-reference',
                  parentUuid: 'user-reference',
                  message: {
                    content: `prefix ${canary} suffix`,
                  },
                  future: [null, 8, false],
                },
              },
              {
                ordinal: 1,
                value: {
                  type: 'tool_result',
                  parentUuid: 'assistant-reference',
                  toolUseId: 'tool-reference',
                  result: { ok: true },
                },
              },
            ];
      const before = structuredClone(draft);
      const activeRuleset = ruleset([
        {
          id: 'structure-canary',
          pattern: canary,
          replacement: '<SAFE>',
        },
      ]);
      const scan = scanReplayDraft(draft, activeRuleset, {
        generatedAt: AT,
      });
      expect(scan.ok).toBe(true);
      if (!scan.ok) return;
      const report = structuredClone(scan.report);
      report.findings = report.findings.map((finding) => ({
        ...finding,
        disposition: finding.blocking
          ? ('replace' as const)
          : finding.disposition,
      }));

      const result = applyReplayDispositions(
        draft,
        report,
        scan.mapper,
        applyOptions(activeRuleset),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const expected = structuredClone(before.nativeSession);
      const targetRow =
        sourceCli === 'codex'
          ? expected.files[0]!.rows[1]!
          : expected.files[0]!.rows[0]!;
      if (sourceCli === 'codex') {
        (
          targetRow.value as {
            payload: { privateNote: string };
          }
        ).payload.privateNote = 'prefix <SAFE> suffix';
      } else {
        (
          targetRow.value as {
            message: { content: string };
          }
        ).message.content = 'prefix <SAFE> suffix';
      }
      expect(result.draft.nativeSession).toEqual(expected);
      expect(draft).toEqual(before);
    },
  );

  it('refuses a report after an unknown native field changes', () => {
    const canary = 'STALE_UNKNOWN_FIELD_CANARY';
    const draft = makeReplayDraft();
    draft.nativeSession.files[0]!.rows[0]!.value = {
      type: 'future',
      privateFuture: canary,
    };
    const activeRuleset = ruleset([
      { id: 'stale-canary', pattern: canary },
    ]);
    const scan = scanReplayDraft(draft, activeRuleset, { generatedAt: AT });
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    const changed = structuredClone(draft);
    delete (
      changed.nativeSession.files[0]!.rows[0]!.value as {
        privateFuture?: string;
      }
    ).privateFuture;

    expect(
      applyReplayDispositions(
        changed,
        scan.report,
        scan.mapper,
        applyOptions(activeRuleset),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'draft-content-mismatch' },
    });
  });

  it('keeps pending opaque content unchanged and blocks a sealable payload', () => {
    const draft = makeReplayDraft();
    draft.nativeSession.files[0]!.rows[0]!.value = {
      type: 'user',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            data: 'FAKE_PENDING_IMAGE_BYTES',
          },
        },
      ],
    };
    const before = structuredClone(draft);
    const activeRuleset = ruleset([]);
    const scan = scanReplayDraft(draft, activeRuleset, { generatedAt: AT });
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;

    const result = applyReplayDispositions(
      draft,
      scan.report,
      scan.mapper,
      applyOptions(activeRuleset),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.gate).toMatchObject({
      opaquePending: 1,
      unlocked: false,
    });
    expect(result.sealablePayload).toBeNull();
    expect(result.draft).toEqual(before);
    expect(draft).toEqual(before);
  });
});
