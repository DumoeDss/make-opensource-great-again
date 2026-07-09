/**
 * SourceTree — the picker's left pane (design B1). A source → project tree where
 * sources (CLI types) are expandable group headers and projects are the leaf rows
 * that load a folder's sessions into the card grid on the right.
 *
 * Whitelist defense (the design doc's first "专有代码不泄漏" line) is preserved
 * verbatim: only `recommended` (public-git-remote) projects show by default; the
 * `show-all-toggle` at the tree top is the explicit, deliberate opt-in. A project
 * row's full `cwd` path is revealed via a native `title` tooltip (zero-cost; elftia
 * has the data but never wired it).
 *
 * Pure presentation — all data + fetch orchestration lives in `SessionPicker`; this
 * component only renders and emits toggle/select intents.
 */
import { ChevronDown, ChevronRight } from 'lucide-react';

import type { ProjectAnnotation, SourceRef } from '../../api/types';
import { cn } from '../../lib/cn';
import { Badge } from '../ui/badge';

/** Per-source project data, populated lazily on first expand (cache-on-expand). */
export interface SourceProjects {
  projects: ProjectAnnotation[];
  totalCount: number;
  recommendedCount: number;
}

interface SourceTreeProps {
  sources: SourceRef[];
  /** Expanded source ids. */
  expanded: Set<string>;
  /** Loaded project data keyed by source id; absent while an expanded source loads. */
  projectsBySource: Record<string, SourceProjects | undefined>;
  showAll: boolean;
  /** The currently-open folder, highlighted in the tree. */
  active: { sourceId: string; projectKey: string } | null;
  error: string | null;
  onToggleSource: (sourceId: string) => void;
  onSelectProject: (sourceId: string, project: ProjectAnnotation) => void;
  onToggleShowAll: (showAll: boolean) => void;
}

export function SourceTree({
  sources,
  expanded,
  projectsBySource,
  showAll,
  active,
  error,
  onToggleSource,
  onSelectProject,
  onToggleShowAll,
}: SourceTreeProps): JSX.Element {
  return (
    <div
      className="flex min-h-0 w-72 shrink-0 flex-col self-stretch rounded-lg border border-border bg-surface-1"
      data-testid="source-tree"
    >
      {/* Tree top: the whitelist opt-in + its defense copy. */}
      <div className="border-b border-border px-3 py-2.5">
        <label className="flex items-center gap-2 text-xs text-text-muted">
          <input
            type="checkbox"
            checked={showAll}
            onChange={(e) => onToggleShowAll(e.target.checked)}
            data-testid="show-all-toggle"
            className="accent-primary"
          />
          显示全部项目（含无公开远端）
        </label>
        {!showAll && (
          <p className="mt-1 text-[11px] leading-snug text-text-subtle">
            默认仅显示有公开 git 远端的项目（推荐）。私有 / 未推送项目在你显式开启前隐藏。
          </p>
        )}
      </div>

      {error && (
        <div className="border-b border-border bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-1.5">
        {sources.map((source) => {
          const isOpen = expanded.has(source.id);
          const loaded = projectsBySource[source.id];
          const Chevron = isOpen ? ChevronDown : ChevronRight;
          return (
            <div key={source.id}>
              <button
                type="button"
                onClick={() => onToggleSource(source.id)}
                data-testid={`source-${source.id}`}
                aria-expanded={isOpen}
                className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm font-medium hover:bg-surface-2"
              >
                <Chevron className="h-4 w-4 shrink-0 text-text-subtle" strokeWidth={1.5} />
                <span className="min-w-0 flex-1 truncate">{source.displayName}</span>
                {loaded && (
                  <span className="shrink-0 text-xs text-text-subtle">{loaded.projects.length}</span>
                )}
              </button>

              {isOpen && (
                <ul className="ml-3 border-l border-border pl-1.5">
                  {!loaded && (
                    <li className="px-2 py-1.5 text-xs text-text-subtle">加载中…</li>
                  )}
                  {loaded?.projects.map((project) => {
                    const isActive =
                      active?.sourceId === source.id && active.projectKey === project.key;
                    return (
                      <li key={project.key}>
                        <button
                          type="button"
                          onClick={() => onSelectProject(source.id, project)}
                          data-testid={`project-${project.key}`}
                          title={project.cwd ?? project.key}
                          className={cn(
                            'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-2',
                            isActive && 'bg-primary-soft/40 text-foreground',
                          )}
                        >
                          <span className="min-w-0 flex-1 truncate">{project.label}</span>
                          {project.recommended && (
                            <Badge variant="success" title={project.recommendReason}>
                              recommended
                            </Badge>
                          )}
                        </button>
                      </li>
                    );
                  })}
                  {loaded && loaded.projects.length === 0 && (
                    <li className="px-2 py-1.5 text-xs text-text-subtle">
                      无项目{showAll ? '。' : '（试试「显示全部项目」）。'}
                    </li>
                  )}
                </ul>
              )}
            </div>
          );
        })}
        {sources.length === 0 && (
          <p className="px-2 py-3 text-center text-xs text-text-subtle">没有可用来源。</p>
        )}
      </div>
    </div>
  );
}
