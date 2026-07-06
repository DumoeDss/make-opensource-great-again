import { z } from 'zod';

import { RoleSchema, ToolCallSchema } from './primitives.js';

/**
 * Marker stamped on a `ParsedMessage` when its source entry carried content
 * blocks that are NOT text/thinking/tool_use/tool_result (e.g. `image`, binary
 * attachments, unknown types). Presence of this field means non-text content
 * was detected and MUST be surfaced to the downstream ⚠ human-review path — the
 * reused parser drops such blocks silently, which the design doc forbids
 * ("mark, not strip"; no silent truncation). `blockTypes` lists the detected
 * block `type` strings so the reviewer knows what to look at.
 */
export const NonTextContentMarkerSchema = z.object({
  blockTypes: z.array(z.string()),
});
export type NonTextContentMarker = z.infer<typeof NonTextContentMarkerSchema>;

/**
 * One parsed transcript message — structurally a superset of elftia's
 * `ParsedAgentMessage`. Required core plus optional tool/thinking/command fields
 * and the non-text marker (`session-readers` stamps it via `parseClaudeSession`).
 * Kept isomorphic to the source JSONL turn so 出口② replay stays possible.
 */
export const ParsedMessageSchema = z.object({
  sdkUuid: z.string(),
  parentUuid: z.string().nullable(),
  role: RoleSchema,
  content: z.string(),
  sdkMessageType: z.string(),
  timestamp: z.number(),
  toolCalls: z.array(ToolCallSchema).optional(),
  toolResults: z
    .array(
      z.object({
        toolUseId: z.string(),
        content: z.string(),
        isError: z.boolean(),
      }),
    )
    .optional(),
  thinking: z.string().optional(),
  isSidechain: z.boolean().optional(),
  commandName: z.string().optional(),
  commandMessage: z.string().optional(),
  commandArgs: z.string().optional(),
  nonTextContent: NonTextContentMarkerSchema.optional(),
});
export type ParsedMessage = z.infer<typeof ParsedMessageSchema>;
