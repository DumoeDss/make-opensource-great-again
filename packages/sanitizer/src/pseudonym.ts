import type { NormalizationCategory } from './schemas.js';

const CATEGORY_PREFIX: Record<NormalizationCategory, string> = {
  path: 'PATH',
  username: 'USER',
  email: 'EMAIL',
  ipv4: 'IPV4',
  ipv6: 'IPV6',
};

/**
 * Session-scoped deterministic pseudonym mapping (design D6).
 *
 * Created fresh per `SanitizedSession`. `map(category, original)` assigns a
 * stable placeholder (`<PATH_1>`, `<EMAIL_1>`, …) on first encounter and returns
 * the same placeholder for the same original for the rest of the session.
 * Assignment is first-encounter-order sequential within the session, which makes
 * it cross-session INCONSISTENT by construction: the same value may be `<PATH_1>`
 * in one session and `<PATH_4>` in another, so a placeholder cannot link a
 * contributor across sessions. The table is never persisted across sessions.
 */
export class PseudonymMapper {
  private readonly tables = new Map<NormalizationCategory, Map<string, string>>();
  private readonly counters = new Map<NormalizationCategory, number>();

  map(category: NormalizationCategory, original: string): string {
    let table = this.tables.get(category);
    if (!table) {
      table = new Map();
      this.tables.set(category, table);
    }
    const existing = table.get(original);
    if (existing !== undefined) return existing;

    const next = (this.counters.get(category) ?? 0) + 1;
    this.counters.set(category, next);
    const placeholder = `<${CATEGORY_PREFIX[category]}_${next}>`;
    table.set(original, placeholder);
    return placeholder;
  }

  /** The placeholder already assigned to an original, if any (no assignment). */
  peek(category: NormalizationCategory, original: string): string | undefined {
    return this.tables.get(category)?.get(original);
  }

  /**
   * The primary contributor username placeholder — the first username mapped in
   * the session — used to fill `meta.contributorAlias`. Falls back to a neutral
   * alias when no username was ever detected.
   */
  primaryContributorAlias(): string {
    const usernames = this.tables.get('username');
    if (usernames && usernames.size > 0) {
      return usernames.values().next().value as string;
    }
    return '<CONTRIBUTOR>';
  }
}
