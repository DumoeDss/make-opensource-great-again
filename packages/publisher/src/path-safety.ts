const RAW_REF_FORBIDDEN = /[\u0000-\u0020\u007f~^:?*[\\/]/;
const BRANCH_REF_FORBIDDEN = /[\u0000-\u0020\u007f~^:?*[\\]/;
const ENCODED_SEGMENT = /^[A-Za-z0-9%._-]+$/;

function percentEncodeUtf8(value: string): string {
  let encoded = '';
  for (const byte of Buffer.from(value, 'utf8')) {
    const character = String.fromCharCode(byte);
    encoded += /[A-Za-z0-9._-]/.test(character)
      ? character
      : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return encoded;
}

function unsafeSegment(label: string, value: string, reason: string): never {
  throw new Error(
    `contribution bundle has unsafe ${label} ${JSON.stringify(value)}: ${reason}`,
  );
}

function assertWellFormedUtf16(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);

    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (
        index + 1 >= value.length ||
        nextCodeUnit < 0xdc00 ||
        nextCodeUnit > 0xdfff
      ) {
        unsafeSegment(label, value, 'ill-formed UTF-16 is forbidden');
      }
      index += 1;
      continue;
    }

    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      unsafeSegment(label, value, 'ill-formed UTF-16 is forbidden');
    }
  }
}

/**
 * Encode one untrusted domain identifier as a collision-free repo/ref segment.
 *
 * Characters outside the portable ASCII segment alphabet are UTF-8
 * percent-encoded instead of being silently discarded or replaced. Inputs that
 * have path traversal or Git-ref semantics are rejected before encoding.
 */
export function encodeRepoSegment(value: string, label: string): string {
  assertWellFormedUtf16(value, label);

  if (value.length === 0) {
    return unsafeSegment(label, value, 'the value is empty');
  }
  if (value === '.' || value === '..') {
    return unsafeSegment(label, value, 'dot path segments are forbidden');
  }
  if (value.startsWith('.')) {
    return unsafeSegment(label, value, 'dot-prefixed Git ref segments are forbidden');
  }
  if (value.endsWith('.')) {
    return unsafeSegment(label, value, 'segments ending in a dot are forbidden');
  }
  if (value.toLowerCase().endsWith('.lock')) {
    return unsafeSegment(label, value, 'segments ending in .lock are forbidden');
  }
  if (value.includes('..')) {
    return unsafeSegment(label, value, 'consecutive dots are forbidden');
  }
  if (value.includes('@{')) {
    return unsafeSegment(label, value, 'the Git ref sequence @{ is forbidden');
  }
  if (RAW_REF_FORBIDDEN.test(value)) {
    return unsafeSegment(
      label,
      value,
      'path separators, controls, spaces, and forbidden Git ref characters are rejected',
    );
  }

  const encoded = percentEncodeUtf8(value);
  assertSupportedGitRefSegment(encoded, label);
  return encoded;
}

/** Assert one already-encoded path/ref component satisfies the supported grammar. */
export function assertSupportedGitRefSegment(segment: string, label = 'Git ref segment'): void {
  if (
    segment.length === 0 ||
    segment === '.' ||
    segment === '..' ||
    segment.startsWith('.') ||
    segment.endsWith('.') ||
    segment.toLowerCase().endsWith('.lock') ||
    segment.includes('..') ||
    segment.includes('@{') ||
    RAW_REF_FORBIDDEN.test(segment) ||
    !ENCODED_SEGMENT.test(segment)
  ) {
    unsafeSegment(label, segment, 'the encoded segment is outside the supported grammar');
  }
}

/**
 * Assert a bundle file path is normalized POSIX-relative and contained beneath
 * the repository's `data/` directory.
 */
export function assertDataRepoPath(path: string): void {
  if (
    path.length === 0 ||
    path.startsWith('/') ||
    path.startsWith('\\') ||
    /^[A-Za-z]:/.test(path) ||
    path.includes('\\') ||
    /[\u0000-\u001f\u007f]/.test(path)
  ) {
    throw new Error(`contribution bundle emitted unsafe repo path ${JSON.stringify(path)}`);
  }

  const segments = path.split('/');
  if (
    segments.length < 2 ||
    segments[0] !== 'data' ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..') ||
    segments.join('/') !== path
  ) {
    throw new Error(
      `contribution bundle path must be normalized, POSIX-relative, and contained under data/: ${JSON.stringify(path)}`,
    );
  }
}

/**
 * Validate the in-memory Git branch grammar supported by publication. This is
 * intentionally at least as strict as the relevant `git check-ref-format`
 * rules, without spawning Git.
 */
export function assertSupportedGitBranch(branch: string): void {
  if (
    branch.length === 0 ||
    branch === '@' ||
    branch.startsWith('/') ||
    branch.endsWith('/') ||
    branch.includes('//') ||
    branch.includes('..') ||
    branch.includes('@{') ||
    branch.endsWith('.') ||
    BRANCH_REF_FORBIDDEN.test(branch)
  ) {
    throw new Error(
      `contribution bundle emitted unsupported Git branch ${JSON.stringify(branch)}`,
    );
  }

  const segments = branch.split('/');
  if (segments.length < 2) {
    throw new Error(
      `contribution bundle branch must contain at least two safe segments: ${JSON.stringify(branch)}`,
    );
  }
  for (const segment of segments) {
    assertSupportedGitRefSegment(segment);
  }
}
