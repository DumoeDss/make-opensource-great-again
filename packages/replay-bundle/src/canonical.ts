import {
  canonicalizeReplayJson,
  InstructionSnapshotFileSchema,
  NativeJsonlFileSchema,
  type InstructionSnapshotFile,
  type NativeJsonlFile,
} from '@mosga/contracts';

export { canonicalizeReplayJson };

/** Canonical LF-terminated native JSONL byte serialization entry point. */
export function serializeNativeJsonl(file: NativeJsonlFile): Uint8Array {
  const parsed = NativeJsonlFileSchema.safeParse(file);
  if (!parsed.success) {
    throw new TypeError('Native replay JSONL file is invalid.');
  }
  const text = parsed.data.rows
    .map((row) =>
      new TextDecoder().decode(canonicalizeReplayJson(row.value)),
    )
    .join('\n');
  return new TextEncoder().encode(`${text}\n`);
}

/** UTF-8 instruction byte serialization entry point. */
export function serializeInstructionFile(
  file: InstructionSnapshotFile,
): Uint8Array {
  const parsed = InstructionSnapshotFileSchema.safeParse(file);
  if (!parsed.success || parsed.data.content.includes('\r')) {
    throw new TypeError(
      'Replay instruction content must be valid LF-normalized text.',
    );
  }
  const content = parsed.data.content.endsWith('\n')
    ? parsed.data.content
    : `${parsed.data.content}\n`;
  return new TextEncoder().encode(content);
}
