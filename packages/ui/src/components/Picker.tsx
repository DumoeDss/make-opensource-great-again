import { useEffect, useState } from 'react';

import type { ApiClient } from '../api/client';
import type {
  CreateReviewResponse,
  ProjectAnnotation,
  SessionRef,
  SourceRef,
} from '../api/types';
import { Badge } from './ui/badge';

interface PickerProps {
  client: ApiClient;
  onReviewCreated: (review: CreateReviewResponse) => void;
}

/**
 * Whitelist picker (source → project → session). Projects default to the
 * `recommended` (public-git-remote) set — the design doc's first
 * "专有代码不泄漏" defense — with an explicit "show all" opt-in. Selecting a
 * session creates a review and hands the scanned report up.
 */
export function Picker({ client, onReviewCreated }: PickerProps): JSX.Element {
  const [sources, setSources] = useState<SourceRef[]>([]);
  const [sourceId, setSourceId] = useState<string>('');
  const [projects, setProjects] = useState<ProjectAnnotation[]>([]);
  const [projectCounts, setProjectCounts] = useState({ total: 0, recommended: 0 });
  const [showAll, setShowAll] = useState(false);
  const [projectKey, setProjectKey] = useState<string>('');
  const [sessions, setSessions] = useState<SessionRef[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    client
      .listSources()
      .then((s) => {
        setSources(s);
        if (s[0]) setSourceId(s[0].id);
      })
      .catch((e: unknown) => setError(String(e)));
  }, [client]);

  useEffect(() => {
    if (!sourceId) return;
    setProjectKey('');
    setSessions([]);
    client
      .listProjects(sourceId, showAll)
      .then((r) => {
        setProjects(r.projects);
        setProjectCounts({ total: r.totalCount, recommended: r.recommendedCount });
      })
      .catch((e: unknown) => setError(String(e)));
  }, [client, sourceId, showAll]);

  useEffect(() => {
    if (!sourceId || !projectKey) return;
    client
      .listSessions(sourceId, projectKey)
      .then(setSessions)
      .catch((e: unknown) => setError(String(e)));
  }, [client, sourceId, projectKey]);

  const startReview = (sessionId: string): void => {
    setCreating(true);
    setError(null);
    client
      .createReview(sourceId, projectKey, sessionId)
      .then(onReviewCreated)
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setCreating(false));
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6" data-testid="picker">
      <h1 className="text-2xl font-semibold">Select a session to review</h1>
      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-text-muted">1 · Source</h2>
        <select
          value={sourceId}
          onChange={(e) => setSourceId(e.target.value)}
          className="rounded-md border border-input bg-surface-1 px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          data-testid="source-select"
        >
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.displayName}
            </option>
          ))}
        </select>
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-text-muted">2 · Project</h2>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={showAll}
              onChange={(e) => setShowAll(e.target.checked)}
              data-testid="show-all-toggle"
              className="accent-primary"
            />
            show all projects ({projectCounts.recommended} recommended / {projectCounts.total} total)
          </label>
        </div>
        {!showAll && (
          <p className="text-xs text-text-subtle">
            Showing only projects with a public git remote (recommended). Private/unpushed
            projects are hidden until you opt in.
          </p>
        )}
        <ul className="divide-y divide-border rounded-md border border-border" data-testid="project-list">
          {projects.map((p) => (
            <li key={p.key}>
              <button
                type="button"
                onClick={() => setProjectKey(p.key)}
                data-testid={`project-${p.key}`}
                className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-surface-2 ${
                  projectKey === p.key ? 'bg-primary-soft/40' : ''
                }`}
              >
                <span>
                  <b>{p.label}</b>
                  <span className="ml-2 text-xs text-text-subtle">{p.cwd ?? p.key}</span>
                </span>
                <Badge
                  variant={p.recommended ? 'success' : 'secondary'}
                  title={p.recommendReason}
                >
                  {p.recommended ? 'recommended' : 'not recommended'}
                </Badge>
              </button>
            </li>
          ))}
          {projects.length === 0 && (
            <li className="px-3 py-4 text-center text-sm text-text-subtle">
              No projects to show{showAll ? '.' : ' — try "show all projects".'}
            </li>
          )}
        </ul>
      </section>

      {projectKey && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-text-muted">3 · Session</h2>
          <ul className="divide-y divide-border rounded-md border border-border" data-testid="session-list">
            {sessions.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  disabled={creating}
                  onClick={() => startReview(s.id)}
                  data-testid={`session-${s.id}`}
                  className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-surface-2 disabled:opacity-50"
                >
                  <span>{s.title ?? s.id}</span>
                  <span className="text-xs text-text-subtle">
                    {new Date(s.updatedAt).toLocaleString()}
                  </span>
                </button>
              </li>
            ))}
            {sessions.length === 0 && (
              <li className="px-3 py-4 text-center text-sm text-text-subtle">No sessions.</li>
            )}
          </ul>
          {creating && <p className="text-sm text-text-subtle">Scanning session…</p>}
        </section>
      )}
    </div>
  );
}
