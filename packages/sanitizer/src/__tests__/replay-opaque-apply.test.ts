import type { ReplayOpaqueItem } from '@mosga/contracts';
import { describe, expect, it } from 'vitest';

import { applyReplayOpaqueDecisions } from '../replayApply.js';
import {
  collectReplayOpaqueItems,
  replayOpaqueItemId,
} from '../replayScan.js';
import { makeReplayDraft } from './replay-fixtures.js';

function draftWithOpaque() {
  const draft = makeReplayDraft();
  draft.nativeSession.files[0]!.rows[0]!.value = {
    type: 'user',
    message: {
      content: [
        { type: 'text', text: 'before' },
        {
          type: 'image',
          source: { type: 'base64', data: 'obviously-fake-image-data' },
        },
        { type: 'text', text: 'after' },
      ],
    },
  };
  return draft;
}

describe('explicit replay opaque decisions', () => {
  it('leaves pending content unchanged and reports it non-sealable', () => {
    const draft = draftWithOpaque();
    const before = structuredClone(draft);
    const items = collectReplayOpaqueItems(draft);
    const result = applyReplayOpaqueDecisions(draft, items);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pendingOpaqueItems).toBe(1);
    expect(result.draft).toEqual(before);
    expect(draft).toEqual(before);
  });

  it('keeps content only after an explicit keep decision', () => {
    const draft = draftWithOpaque();
    const items = collectReplayOpaqueItems(draft).map((item) => ({
      ...item,
      disposition: 'keep' as const,
    }));
    const result = applyReplayOpaqueDecisions(draft, items);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pendingOpaqueItems).toBe(0);
    expect(result.draft.nativeSession).toEqual(draft.nativeSession);
    expect(result.draft.omissions).toEqual(draft.omissions);
  });

  it('removes only the addressed array block and records a safe omission', () => {
    const draft = draftWithOpaque();
    const items = collectReplayOpaqueItems(draft).map((item) => ({
      ...item,
      disposition: 'remove' as const,
    }));
    const result = applyReplayOpaqueDecisions(draft, items);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const content = (
      result.draft.nativeSession.files[0]!.rows[0]!.value as {
        message: { content: unknown[] };
      }
    ).message.content;
    expect(content).toEqual([
      { type: 'text', text: 'before' },
      { type: 'text', text: 'after' },
    ]);
    expect(result.draft.omissions.at(-1)).toEqual({
      id: `reviewed-opaque-${items[0]!.id}`,
      category: 'opaque-content',
      reason: 'removed-after-review',
      disclosure:
        'Opaque image content was explicitly removed during replay review.',
      relatedId: items[0]!.id,
    });
    expect(JSON.stringify(result.draft.omissions)).not.toContain(
      'obviously-fake-image-data',
    );
  });

  it('removes adjacent opaque array items without shifting the later location', () => {
    const draft = makeReplayDraft();
    draft.nativeSession.files[0]!.rows[0]!.value = {
      content: [
        { type: 'image', data: 'FIRST_FAKE_IMAGE' },
        { type: 'input_image', data: 'SECOND_FAKE_IMAGE' },
        { type: 'text', text: 'after' },
      ],
    };
    const items = collectReplayOpaqueItems(draft).map((item) => ({
      ...item,
      disposition: 'remove' as const,
    }));

    const result = applyReplayOpaqueDecisions(draft, items);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      (
        result.draft.nativeSession.files[0]!.rows[0]!.value as {
          content: unknown[];
        }
      ).content,
    ).toEqual([{ type: 'text', text: 'after' }]);
    expect(result.draft.omissions.filter((item) =>
      item.id.startsWith('reviewed-opaque-'),
    )).toHaveLength(2);
  });

  it('prevalidates and applies nested opaque removals child-first', () => {
    const draft = makeReplayDraft();
    draft.nativeSession.files[0]!.rows[0]!.value = {
      content: [
        {
          type: 'image',
          variants: [
            { type: 'input_image', data: 'NESTED_FAKE_IMAGE' },
          ],
        },
      ],
    };
    const items = collectReplayOpaqueItems(draft).map((item) => ({
      ...item,
      disposition: 'remove' as const,
    }));
    expect(items).toHaveLength(2);

    const result = applyReplayOpaqueDecisions(draft, items);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      (
        result.draft.nativeSession.files[0]!.rows[0]!.value as {
          content: unknown[];
        }
      ).content,
    ).toEqual([]);
    expect(result.draft.omissions.filter((item) =>
      item.id.startsWith('reviewed-opaque-'),
    )).toHaveLength(2);
  });

  it('replaces the addressed block with explicit JSON and records omission', () => {
    const draft = draftWithOpaque();
    const replacement = {
      type: 'text',
      text: '[reviewed image omission]',
    };
    const items = collectReplayOpaqueItems(draft).map((item) => ({
      ...item,
      disposition: 'replace' as const,
      replacement,
    }));
    const result = applyReplayOpaqueDecisions(draft, items);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const content = (
      result.draft.nativeSession.files[0]!.rows[0]!.value as {
        message: { content: unknown[] };
      }
    ).message.content;
    expect(content[1]).toEqual(replacement);
    expect(result.draft.omissions.at(-1)?.disclosure).toContain(
      'explicitly replaced',
    );
  });

  it('fails without partial output for a missing or invalid decision', () => {
    const draft = draftWithOpaque();
    const original = collectReplayOpaqueItems(draft)[0]!;
    const missing: ReplayOpaqueItem = {
      ...original,
      id: replayOpaqueItemId(
        original.location.fileId,
        original.location.rowOrdinal,
        '/message/content/99',
        original.blockType,
      ),
      location: {
        ...original.location,
        jsonPointer: '/message/content/99',
      },
      disposition: 'remove',
    };
    expect(applyReplayOpaqueDecisions(draft, [missing])).toMatchObject({
      ok: false,
      error: { code: 'missing-opaque-location' },
    });

    expect(
      applyReplayOpaqueDecisions(draft, [
        { ...original, disposition: 'replace', replacement: null },
      ]),
    ).toMatchObject({
      ok: false,
      error: { code: 'missing-opaque-replacement' },
    });
  });
});
