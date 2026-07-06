import { z } from 'zod';

/**
 * A project grouping produced by reader enumeration — one decoded-cwd folder
 * under a CLI's sessions root. Mirrors elftia's `CliProjectRef`.
 */
export const CliProjectRefSchema = z.object({
  sourceId: z.string(),
  key: z.string(),
  cwd: z.string().nullable(),
  label: z.string(),
});
export type CliProjectRef = z.infer<typeof CliProjectRefSchema>;

/**
 * A single session (one transcript file) produced by reader enumeration.
 * Mirrors elftia's `CliSessionRef` minus the elftia-display-only
 * `startedInElftia` field.
 */
export const CliSessionRefSchema = z.object({
  sourceId: z.string(),
  projectKey: z.string(),
  id: z.string(),
  path: z.string(),
  title: z.string().nullable(),
  cwd: z.string().nullable(),
  updatedAt: z.number(),
  sizeBytes: z.number(),
});
export type CliSessionRef = z.infer<typeof CliSessionRefSchema>;
