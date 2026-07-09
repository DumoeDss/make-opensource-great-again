/**
 * SessionPicker — the tree-navigation picker (design B1). Composes the left
 * `SourceTree` + right `SessionCardGrid` and owns all of the picker's state:
 *   - tree data fetches (`listSources` / `listProjects` / `listSessions`), with
 *     projects loaded lazily on first expand and cached per source;
 *   - the cross-folder selection `Map` (keyed `${sourceId} ${projectKey} ${id}`)
 *     that a persistent selection bar summarizes;
 *   - queue creation: serial `createReview` per selected session with a scan
 *     progress line, collecting per-session failures so the successful remainder
 *     can still proceed.
 *
 * The whitelist defense (recommended-by-default + explicit show-all) is preserved:
 * toggling show-all re-fetches every expanded source's projects and drops the open
 * folder, since the visible project set changes.
 */
import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { ApiClient } from '../../api/client';
import type { ProjectAnnotation, QueueItem, SessionRef, SourceRef } from '../../api/types';
import { Button } from '../ui/button';
import { SessionCardGrid } from './SessionCardGrid';
import { SourceTree, type Scope, type SourceProjects } from './SourceTree';

interface SessionPickerProps {
  client: ApiClient;
  /** Hands the created review queue up to `App`, flipping it into the journey. */
  onQueueCreated: (queue: QueueItem[]) => void;
}

const selectionKey = (ref: SessionRef): string => `${ref.sourceId} ${ref.projectKey} ${ref.id}`;

export function SessionPicker({ client, onQueueCreated }: SessionPickerProps): JSX.Element {
  const [sources, setSources] = useState<SourceRef[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [projectsBySource, setProjectsBySource] = useState<Record<string, SourceProjects | undefined>>({});
  // Per-folder session cache (`${sourceId} ${projectKey}` → sessions), populated on
  // folder-open and on scope selection; lets a re-tick reuse fetched sessions.
  const [sessionsByProject, setSessionsByProject] = useState<Map<string, SessionRef[]>>(new Map());
  const [showAll, setShowAll] = useState(false);
  const [active, setActive] = useState<{ sourceId: string; projectKey: string; label: string } | null>(null);
  const [sessions, setSessions] = useState<SessionRef[]>([]);
  const [selection, setSelection] = useState<Map<string, SessionRef>>(new Map());
  const [loadingScope, setLoadingScope] = useState<Scope | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Queue creation: progress line while scanning, and any per-session failures.
  const [progress, setProgress] = useState<{ k: number; n: number } | null>(null);
  const [failures, setFailures] = useState<Array<{ ref: SessionRef; error: string }>>([]);
  const [succeeded, setSucceeded] = useState<QueueItem[]>([]);

  useEffect(() => {
    client
      .listSources()
      .then(setSources)
      .catch((e: unknown) => setError(String(e)));
  }, [client]);

  const fetchProjects = (sourceId: string, all: boolean): void => {
    client
      .listProjects(sourceId, all)
      .then((r) =>
        setProjectsBySource((m) => ({
          ...m,
          [sourceId]: {
            projects: r.projects,
            totalCount: r.totalCount,
            recommendedCount: r.recommendedCount,
          },
        })),
      )
      .catch((e: unknown) => setError(String(e)));
  };

  const sessionCacheKey = (sourceId: string, projectKey: string): string => `${sourceId} ${projectKey}`;

  /** Load (respecting show-all) + cache a source's projects; returns them. */
  const ensureProjects = async (sourceId: string): Promise<ProjectAnnotation[]> => {
    const cached = projectsBySource[sourceId];
    if (cached) return cached.projects;
    const r = await client.listProjects(sourceId, showAll);
    setProjectsBySource((m) => ({
      ...m,
      [sourceId]: { projects: r.projects, totalCount: r.totalCount, recommendedCount: r.recommendedCount },
    }));
    return r.projects;
  };

  /** Load + cache a folder's sessions; returns them. */
  const ensureSessions = async (sourceId: string, projectKey: string): Promise<SessionRef[]> => {
    const cached = sessionsByProject.get(sessionCacheKey(sourceId, projectKey));
    if (cached) return cached;
    const sess = await client.listSessions(sourceId, projectKey);
    setSessionsByProject((prev) => new Map(prev).set(sessionCacheKey(sourceId, projectKey), sess));
    return sess;
  };

  const onToggleSource = (sourceId: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(sourceId)) {
        next.delete(sourceId);
      } else {
        next.add(sourceId);
        if (!projectsBySource[sourceId]) fetchProjects(sourceId, showAll);
      }
      return next;
    });
  };

  const onToggleShowAll = (value: boolean): void => {
    setShowAll(value);
    // The recommended/all project set differs — invalidate the caches, drop the open
    // folder, and re-fetch every currently-expanded source under the new scope.
    setProjectsBySource({});
    setSessionsByProject(new Map());
    setActive(null);
    setSessions([]);
    for (const id of expanded) fetchProjects(id, value);
  };

  const onSelectProject = (sourceId: string, project: ProjectAnnotation): void => {
    setActive({ sourceId, projectKey: project.key, label: project.label });
    setSessions([]);
    ensureSessions(sourceId, project.key)
      .then(setSessions)
      .catch((e: unknown) => setError(String(e)));
  };

  // ---- Scope selection (checkbox on 全部 / source / project) ------------------
  const scopePrefix = (scope: Scope): string =>
    scope.kind === 'all'
      ? ''
      : scope.kind === 'source'
        ? `${scope.sourceId} `
        : `${scope.sourceId} ${scope.projectKey} `;

  const toggleScope = async (scope: Scope, checked: boolean): Promise<void> => {
    if (!checked) {
      // Unticking removes by selection-key prefix — no requests.
      const prefix = scopePrefix(scope);
      setSelection((prev) => {
        const next = new Map(prev);
        for (const key of [...next.keys()]) if (key.startsWith(prefix)) next.delete(key);
        return next;
      });
      return;
    }
    // Ticking collects every session under the scope (fetching as needed) and adds
    // them to the selection; the scope's checkbox spins while collecting.
    setLoadingScope(scope);
    setError(null);
    try {
      const targets: Array<{ sourceId: string; projectKey: string }> = [];
      if (scope.kind === 'project') {
        targets.push({ sourceId: scope.sourceId, projectKey: scope.projectKey });
      } else if (scope.kind === 'source') {
        for (const p of await ensureProjects(scope.sourceId)) {
          targets.push({ sourceId: scope.sourceId, projectKey: p.key });
        }
      } else {
        for (const s of sources) {
          for (const p of await ensureProjects(s.id)) targets.push({ sourceId: s.id, projectKey: p.key });
        }
      }
      const additions: SessionRef[] = [];
      for (const t of targets) additions.push(...(await ensureSessions(t.sourceId, t.projectKey)));
      setSelection((prev) => {
        const next = new Map(prev);
        for (const s of additions) {
          const key = selectionKey(s);
          if (!next.has(key)) next.set(key, s);
        }
        return next;
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingScope(null);
    }
  };

  // Checked derivation (no indeterminate state): a project is checked when its
  // cached sessions are all selected; a source when all its loaded projects are;
  // 全部 when all loaded sources are. Not-yet-loaded nodes read as unchecked.
  const isProjectChecked = (sourceId: string, projectKey: string): boolean => {
    const sess = sessionsByProject.get(sessionCacheKey(sourceId, projectKey));
    if (!sess || sess.length === 0) return false;
    return sess.every((s) => selection.has(selectionKey(s)));
  };
  const isSourceChecked = (sourceId: string): boolean => {
    const projs = projectsBySource[sourceId]?.projects;
    if (!projs || projs.length === 0) return false;
    return projs.every((p) => isProjectChecked(sourceId, p.key));
  };
  const allChecked = sources.length > 0 && sources.every((s) => isSourceChecked(s.id));

  const toggleSelect = (ref: SessionRef): void => {
    setSelection((prev) => {
      const next = new Map(prev);
      const key = selectionKey(ref);
      if (next.has(key)) next.delete(key);
      else next.set(key, ref);
      return next;
    });
  };

  const selectAll = (): void => {
    setSelection((prev) => {
      const next = new Map(prev);
      for (const s of sessions) next.set(selectionKey(s), s);
      return next;
    });
  };

  const clearSelection = (): void => setSelection(new Map());

  const startReview = async (): Promise<void> => {
    const refs = [...selection.values()];
    if (refs.length === 0) return;
    setError(null);
    setFailures([]);
    setSucceeded([]);
    const created: QueueItem[] = [];
    const failed: Array<{ ref: SessionRef; error: string }> = [];
    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i];
      setProgress({ k: i + 1, n: refs.length });
      try {
        const review = await client.createReview(ref.sourceId, ref.projectKey, ref.id);
        created.push({ review, ref });
      } catch (e) {
        failed.push({ ref, error: String(e) });
      }
    }
    setProgress(null);
    if (failed.length === 0) {
      onQueueCreated(created);
    } else {
      // Hold the successes; the user drops the failures and continues, or returns.
      setSucceeded(created);
      setFailures(failed);
    }
  };

  const creating = progress !== null;

  return (
    // Single-page layout: the picker fills the shell's height; the tree and the
    // card grid each keep their own scrollbar (min-h-0 lets the flex row shrink),
    // and the selection bar below the row sits at a fixed bottom position.
    <div className="mx-auto flex h-full min-h-0 w-full max-w-6xl flex-col gap-4" data-testid="session-picker">
      <h1 className="shrink-0 text-2xl font-semibold">选择要审阅的会话</h1>

      <div className="flex min-h-0 flex-1 gap-4">
        <SourceTree
          sources={sources}
          expanded={expanded}
          projectsBySource={projectsBySource}
          showAll={showAll}
          active={active}
          error={error}
          onToggleSource={onToggleSource}
          onSelectProject={onSelectProject}
          onToggleShowAll={onToggleShowAll}
          allChecked={allChecked}
          isSourceChecked={isSourceChecked}
          isProjectChecked={isProjectChecked}
          loadingScope={loadingScope}
          onToggleAll={(checked) => void toggleScope({ kind: 'all' }, checked)}
          onToggleSourceScope={(sourceId, checked) =>
            void toggleScope({ kind: 'source', sourceId }, checked)
          }
          onToggleProjectScope={(sourceId, project, checked) =>
            void toggleScope({ kind: 'project', sourceId, projectKey: project.key }, checked)
          }
        />
        <SessionCardGrid
          folderLabel={active?.label ?? null}
          sessions={sessions}
          selection={selection}
          selectionKey={selectionKey}
          onToggle={toggleSelect}
          onSelectAll={selectAll}
          onClear={clearSelection}
        />
      </div>

      {/* Persistent selection bar: appears once anything is selected. */}
      {selection.size > 0 && (
        <div
          className="flex items-center justify-between gap-4 rounded-lg border border-border bg-surface-1 px-4 py-3"
          data-testid="selection-bar"
        >
          <div className="text-sm">
            <span className="font-medium">已选 {selection.size} 个会话</span>
          </div>
          <Button
            type="button"
            onClick={() => void startReview()}
            disabled={creating}
            data-testid="start-review"
          >
            开始审阅 {selection.size} 个会话
          </Button>
        </div>
      )}

      {creating && progress && (
        <p className="text-sm text-text-muted" data-testid="create-progress">
          <Loader2 className="mr-1.5 inline h-4 w-4 animate-spin" strokeWidth={1.5} />
          正在扫描 {progress.k}/{progress.n}…
        </p>
      )}

      {failures.length > 0 && (
        <div
          className="space-y-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4"
          data-testid="create-failures"
        >
          <p className="text-sm font-medium text-destructive">
            {failures.length} 个会话扫描失败：
          </p>
          <ul className="space-y-1 text-xs text-destructive">
            {failures.map((f) => (
              <li key={selectionKey(f.ref)}>
                {f.ref.title ?? f.ref.id}：{f.error}
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              disabled={succeeded.length === 0}
              onClick={() => onQueueCreated(succeeded)}
              data-testid="continue-remainder"
            >
              继续（{succeeded.length} 个成功）
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                setFailures([]);
                setSucceeded([]);
              }}
              data-testid="return-picker"
            >
              返回选择
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
