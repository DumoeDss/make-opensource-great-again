import type { SanitizedSession } from '../api/types';
import { Badge } from './ui/badge';

interface ExportPreviewProps {
  session: SanitizedSession | null;
}

/**
 * Shows the stamped `SanitizedSession` JSON returned by the export endpoint
 * (`meta.sanitized:true`, ruleset version stamped) — the hand-off to slice 4.
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
    <div data-testid="export-preview">
      <div className="mb-2 flex flex-wrap gap-3 text-sm">
        <Badge variant="success">sanitized: {String(session.meta.sanitized)}</Badge>
        <Badge variant="secondary">
          ruleset: {session.meta.sanitizationRulesetVersion ?? '—'}
        </Badge>
        <Badge variant="secondary">contributor: {session.meta.contributorAlias}</Badge>
      </div>
      <pre className="max-h-[28rem] overflow-auto rounded-md bg-surface-2 p-3 font-mono text-xs text-text-muted">
        {JSON.stringify(session, null, 2)}
      </pre>
    </div>
  );
}
