/**
 * codex parse-layer tests.
 *
 * Exercises `parseCodexRolloutToMessages` (response_item → ParsedMessage
 * mapping, event_msg ignored, shell normalization + error status, inline
 * non-text marker) and the `parseCodexSession` file entry (missing / `.zst`
 * → `[]`).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseCodexSession } from '../parseCodexSession.js';
import { parseCodexRolloutToMessages } from '../parsers/codexRollout.js';

/** One rollout line JSON string. */
function line(obj: object): string {
  return JSON.stringify(obj);
}

describe('parseCodexRolloutToMessages — response_item mapping', () => {
  it('maps user/assistant/function_call+output and ignores the event_msg mirror', () => {
    const lines = [
      line({ type: 'session_meta', payload: { id: 't1', cwd: '/p' } }),
      // The response_item SSOT stream.
      line({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      }),
      line({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'hi there' }],
        },
      }),
      line({
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'c1',
          name: 'shell',
          arguments: JSON.stringify({ command: ['bash', '-lc', 'ls'] }),
        },
      }),
      line({
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'c1',
          output: JSON.stringify({ output: 'a\nb', metadata: { exit_code: 0 } }),
        },
      }),
      // The mirror event_msg stream — MUST NOT double any message.
      line({ type: 'event_msg', payload: { type: 'user_message', message: 'hello' } }),
      line({ type: 'event_msg', payload: { type: 'agent_message', message: 'hi there' } }),
    ];

    const messages = parseCodexRolloutToMessages(lines);
    // user + assistant text + assistant-with-toolcall = exactly 3.
    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({ role: 'user', content: 'hello' });
    expect(messages[1]).toMatchObject({ role: 'assistant', content: 'hi there' });

    const toolMsg = messages[2]!;
    expect(toolMsg.role).toBe('assistant');
    expect(toolMsg.toolCalls).toHaveLength(1);
    const call = toolMsg.toolCalls![0]!;
    expect(call.id).toBe('c1');
    expect(call.name).toBe('Bash');
    expect(call.input.command).toBe('ls');
    expect(call.result).toBe('a\nb');
    expect(call.status).toBe('completed');
  });

  it('normalizes shell to Bash and marks a nonzero exit as error', () => {
    const lines = [
      line({
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'c9',
          name: 'shell',
          arguments: JSON.stringify({ command: ['bash', '-lc', 'exit 2'] }),
        },
      }),
      line({
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'c9',
          output: JSON.stringify({ output: 'boom', metadata: { exit_code: 2 } }),
        },
      }),
    ];

    const messages = parseCodexRolloutToMessages(lines);
    expect(messages).toHaveLength(1);
    const call = messages[0]!.toolCalls![0]!;
    expect(call.name).toBe('Bash');
    expect(call.input.command).toBe('exit 2');
    expect(call.status).toBe('error');
  });

  it('marks a non-input_text part but leaves a pure-text turn unmarked', () => {
    const lines = [
      line({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'look at this' },
            { type: 'input_image', image_url: 'data:image/png;base64,ZmFrZQ==' },
          ],
        },
      }),
      line({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'plain text only' }],
        },
      }),
    ];

    const messages = parseCodexRolloutToMessages(lines);
    expect(messages).toHaveLength(2);
    // The image turn is marked with the part's type — never silently dropped.
    expect(messages[0]!.content).toBe('look at this');
    expect(messages[0]!.nonTextContent?.blockTypes).toContain('input_image');
    // The pure-text turn carries no marker.
    expect(messages[1]!.nonTextContent).toBeUndefined();
  });

  it('marks a scaffolding turn carrying a non-text part but skips a pure-text one (M2)', () => {
    const lines = [
      // Scaffolding text + an image: the image must survive as a marked, empty
      // message (mark, not strip) even though the scaffolding text is dropped.
      line({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: '<environment_context>cwd=/p</environment_context>' },
            { type: 'input_image', image_url: 'data:image/png;base64,ZmFrZQ==' },
          ],
        },
      }),
      // Pure-text scaffolding stays skipped entirely.
      line({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '<user_instructions>be nice</user_instructions>' }],
        },
      }),
    ];

    const messages = parseCodexRolloutToMessages(lines);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe('user');
    expect(messages[0]!.content).toBe('');
    expect(messages[0]!.nonTextContent?.blockTypes).toContain('input_image');
  });

  it('marks a non-user/assistant message with a non-text part, skips a pure-text one (m3)', () => {
    const lines = [
      line({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'system',
          content: [
            { type: 'input_text', text: 'ignored system text' },
            { type: 'input_image', image_url: 'x' },
          ],
        },
      }),
      line({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: 'pure text, skipped' }],
        },
      }),
    ];

    const messages = parseCodexRolloutToMessages(lines);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toBe('');
    expect(messages[0]!.nonTextContent?.blockTypes).toContain('input_image');
  });

  it('marks a content part with a missing/non-string type as unknown, never dropped (m4)', () => {
    const lines = [
      line({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'hi' }, { text: 'typeless part' }],
        },
      }),
    ];

    const messages = parseCodexRolloutToMessages(lines);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toBe('hi');
    expect(messages[0]!.nonTextContent?.blockTypes).toContain('unknown');
  });

  it('surfaces a compacted summary as an assistant message (lower-risk fallback)', () => {
    const lines = [
      line({ type: 'compacted', payload: { message: 'summary of the prior turns' } }),
      // An empty compacted summary emits nothing.
      line({ type: 'compacted', payload: { message: '' } }),
    ];

    const messages = parseCodexRolloutToMessages(lines);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: 'assistant', content: 'summary of the prior turns' });
  });

  it('maps reasoning.summary to an assistant thinking message with empty content', () => {
    const lines = [
      line({
        type: 'response_item',
        payload: {
          type: 'reasoning',
          summary: [
            { type: 'summary_text', text: 'first thought' },
            { type: 'summary_text', text: 'second thought' },
          ],
        },
      }),
    ];

    const messages = parseCodexRolloutToMessages(lines);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe('assistant');
    expect(messages[0]!.content).toBe('');
    expect(messages[0]!.thinking).toBe('first thought\nsecond thought');
  });

  it('maps custom_tool_call + custom_tool_call_output paired by call_id', () => {
    const lines = [
      line({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          call_id: 'p1',
          name: 'apply_patch',
          // A raw (non-JSON) freeform string is preserved under `input`.
          input: '*** Begin Patch\n*** End Patch',
        },
      }),
      line({
        type: 'response_item',
        payload: { type: 'custom_tool_call_output', call_id: 'p1', output: 'Success' },
      }),
    ];

    const messages = parseCodexRolloutToMessages(lines);
    expect(messages).toHaveLength(1);
    const call = messages[0]!.toolCalls![0]!;
    expect(call.name).toBe('apply_patch');
    expect(call.input.input).toBe('*** Begin Patch\n*** End Patch');
    expect(call.result).toBe('Success');
    expect(call.status).toBe('completed');
  });

  it('normalizes update_plan to TodoWrite', () => {
    const lines = [
      line({
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'u1',
          name: 'update_plan',
          arguments: JSON.stringify({
            plan: [
              { step: 'do a', status: 'completed' },
              { step: 'do b', status: 'in_progress' },
            ],
          }),
        },
      }),
    ];

    const messages = parseCodexRolloutToMessages(lines);
    expect(messages).toHaveLength(1);
    const call = messages[0]!.toolCalls![0]!;
    expect(call.name).toBe('TodoWrite');
    const todos = call.input.todos as Array<Record<string, unknown>>;
    expect(todos).toHaveLength(2);
    expect(todos[0]).toMatchObject({ content: 'do a', status: 'completed', activeForm: 'do a' });
    expect(todos[1]).toMatchObject({ content: 'do b', status: 'in_progress' });
  });
});

describe('parseCodexSession — file entry', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'mosga-codex-parse-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns [] for a missing/unreadable file', () => {
    expect(parseCodexSession(path.join(dir, 'nope.jsonl'))).toEqual([]);
  });

  it('returns [] for a .jsonl.zst path without decompressing', () => {
    const zst = path.join(dir, 'rollout-x.jsonl.zst');
    writeFileSync(zst, 'not real zstd bytes', 'utf-8');
    expect(parseCodexSession(zst)).toEqual([]);
  });

  it('parses a real .jsonl rollout file to messages', () => {
    const file = path.join(dir, 'rollout-real.jsonl');
    writeFileSync(
      file,
      `${[
        line({ type: 'session_meta', payload: { id: 't', cwd: '/p' } }),
        line({
          type: 'response_item',
          payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'q' }] },
        }),
      ].join('\n')}\n`,
      'utf-8',
    );
    const messages = parseCodexSession(file);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: 'user', content: 'q' });
  });
});
