import { z } from 'zod';

/**
 * Message role. Redefined locally (design D2) so `@mosga/*` never depends on
 * elftia's `@shared/chat-types`. The three-value union is exactly what the
 * reused Claude Code parser reads/writes.
 */
export const RoleSchema = z.enum(['user', 'assistant', 'system']);
export type Role = z.infer<typeof RoleSchema>;

/**
 * A single tool call on an assistant message. Redefined locally (design D2) —
 * the fields the reused parser (`parseJsonlEntriesToAgentMessages`) reads and
 * writes: `id`, `name`, `input`, a `status`, and an optional merged `result`.
 */
export const ToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
  status: z.enum(['completed', 'error']),
  result: z.string().optional(),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;
