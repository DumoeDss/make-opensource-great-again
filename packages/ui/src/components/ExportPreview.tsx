import type { SanitizedSession } from '../api/types';

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
      <p className="text-sm text-gray-500" data-testid="export-empty">
        Unlock the gate and export to preview the stamped sanitized session here.
      </p>
    );
  }
  return (
    <div data-testid="export-preview">
      <div className="mb-2 flex flex-wrap gap-3 text-sm">
        <span className="rounded bg-green-100 px-2 py-0.5 text-green-800">
          sanitized: {String(session.meta.sanitized)}
        </span>
        <span className="rounded bg-gray-100 px-2 py-0.5 text-gray-700">
          ruleset: {session.meta.sanitizationRulesetVersion ?? '—'}
        </span>
        <span className="rounded bg-gray-100 px-2 py-0.5 text-gray-700">
          contributor: {session.meta.contributorAlias}
        </span>
      </div>
      <pre className="max-h-[28rem] overflow-auto rounded bg-gray-900 p-3 text-xs text-gray-100">
        {JSON.stringify(session, null, 2)}
      </pre>
    </div>
  );
}
