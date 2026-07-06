/**
 * Shannon entropy (bits per character) of a string — mirrors gitleaks' own
 * `entropy` gate (design D4). A rule that declares an `entropy` threshold only
 * fires when the captured secret's entropy meets it, suppressing low-entropy
 * false positives.
 */
export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}
