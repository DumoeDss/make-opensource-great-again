import type { SanitizedSession } from '../api/types';
import { AdvancedFold } from './ui/advanced-fold';
import { Badge } from './ui/badge';

interface ExportPreviewProps {
  session: SanitizedSession | null;
}

/**
 * Human-readable summary of the stamped `SanitizedSession` (`meta.sanitized:true`,
 * ruleset version stamped) as the primary content; the raw JSON is demoted into a
 * collapsed 「高级」 fold (design premise 3 — no bare `<pre>` JSON as primary).
 */
export function ExportPreview({ session }: ExportPreviewProps): JSX.Element {
  if (!session) {
    return (
      <p className="text-sm text-text-subtle" data-testid="export-empty">
        Unlock the gate and export to preview the stamped sanitized session here.
      </p>
    );
  }
  return (
    <div className="space-y-3" data-testid="export-preview">
      <div className="flex flex-wrap gap-3 text-sm">
        <Badge variant="success">sanitized: {String(session.meta.sanitized)}</Badge>
        <Badge variant="secondary">
          ruleset: {session.meta.sanitizationRulesetVersion ?? '—'}
        </Badge>
        <Badge variant="secondary">contributor: {session.meta.contributorAlias}</Badge>
      </div>
      <AdvancedFold label="高级：原始 JSON" data-testid="export-advanced">
        <pre className="max-h-[28rem] overflow-auto rounded-md bg-surface-2 p-3 font-mono text-xs text-text-muted">
          {JSON.stringify(session, null, 2)}
        </pre>
      </AdvancedFold>
    </div>
  );
}
