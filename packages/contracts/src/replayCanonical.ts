import {
  ReplayBundleDraftSchema,
  type ReplayBundleDraft,
  type ReplayBundlePayload,
} from './replay.js';

export const REPLAY_REVIEWED_DRAFT_DOMAIN =
  'mosga-replay-reviewed-draft:v1' as const;

function invalidJson(): never {
  throw new TypeError(
    'Replay canonicalization accepts only finite, acyclic JSON values.',
  );
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (value) =>
    value.codePointAt(0),
  );
  const rightPoints = Array.from(right, (value) =>
    value.codePointAt(0),
  );
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference =
      leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

function canonicalText(
  value: unknown,
  active: WeakSet<object>,
): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return invalidJson();
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') return invalidJson();
  if (active.has(value)) return invalidJson();
  active.add(value);

  try {
    if (Array.isArray(value)) {
      if (
        Reflect.ownKeys(value).some(
          (key) =>
            typeof key === 'symbol' ||
            (key !== 'length' && !/^(0|[1-9]\d*)$/.test(key)),
        )
      ) {
        return invalidJson();
      }
      const entries: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (!descriptor || !('value' in descriptor)) {
          return invalidJson();
        }
        entries.push(canonicalText(descriptor.value, active));
      }
      return `[${entries.join(',')}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (
      prototype !== Object.prototype &&
      prototype !== null
    ) {
      return invalidJson();
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      return invalidJson();
    }
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).sort(compareCodePoints);
    const entries = keys.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (!descriptor || !('value' in descriptor)) {
        return invalidJson();
      }
      return `${JSON.stringify(key)}:${canonicalText(
        descriptor.value,
        active,
      )}`;
    });
    return `{${entries.join(',')}}`;
  } finally {
    active.delete(value);
  }
}

/** `mosga-replay-canonical-json-v1`: sorted keys, stable arrays, UTF-8. */
export function canonicalizeReplayJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(
    canonicalText(value, new WeakSet()),
  );
}

/**
 * Derive the complete draft projection from either a draft or reviewed
 * payload. Removing only `review` lets the strict draft schema catch drift if
 * any other field is added or omitted.
 */
export function projectReplayBundleDraft(
  input: ReplayBundleDraft | ReplayBundlePayload,
): ReplayBundleDraft {
  const { review: _review, ...draft } = input as ReplayBundlePayload;
  void _review;
  return ReplayBundleDraftSchema.parse(draft);
}

/**
 * Canonical reviewed-content preimage shared by apply, seal, and validation.
 * Every draft field and every array position is covered.
 */
export function canonicalizeReplayReviewedDraft(
  input: ReplayBundleDraft | ReplayBundlePayload,
): Uint8Array {
  return canonicalizeReplayJson({
    domain: REPLAY_REVIEWED_DRAFT_DOMAIN,
    draft: projectReplayBundleDraft(input),
  });
}
