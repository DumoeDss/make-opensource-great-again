/**
 * SourceTree — the picker's left pane (design B1 + the checkbox-selection UX fix).
 * A source → project tree where sources (CLI types) are expandable group headers
 * and projects are the leaf rows that load a folder's sessions into the card grid.
 *
 * Every node carries a selection CHECKBOX (source / project) plus a top-level
 * 「选择全部项目」; ticking a node selects all sessions under it (respecting the
 * visible scope), unticking removes that range. The 「显示全部项目」
 * whitelist opt-in (recommended-by-default) is preserved but moved to the pinned
 * BOTTOM of the pane. Project rows reveal the full `cwd` path via a native tooltip.
 *
 * Pure presentation — all data + fetch orchestration + checked derivation live in
 * `SessionPicker`; this component only renders and emits intents.
 */
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';

import type { ProjectAnnotation, SourceRef } from '../../api/types';
import { cn } from '../../lib/cn';
import { Badge } from '../ui/badge';

/** Per-source project data, populated lazily on first expand (cache-on-expand). */
export interface SourceProjects {
  projects: ProjectAnnotation[];
  totalCount: number;
  recommendedCount: number;
}

/** A selection scope: everything visible, one source, or one project. */
export type Scope =
  | { kind: 'all' }
  | { kind: 'source'; sourceId: string }
  | { kind: 'project'; sourceId: string; projectKey: string };

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
  // ---- Scope selection ----
  allChecked: boolean;
  isSourceChecked: (sourceId: string) => boolean;
  isProjectChecked: (sourceId: string, projectKey: string) => boolean;
  /** The scope whose sessions are currently being collected (its checkbox spins). */
  loadingScope: Scope | null;
  onToggleAll: (checked: boolean) => void;
  onToggleSourceScope: (sourceId: string, checked: boolean) => void;
  onToggleProjectScope: (sourceId: string, project: ProjectAnnotation, checked: boolean) => void;
}

/** A checkbox that flips to a spinner while its scope's sessions are collected. */
function ScopeBox({
  checked,
  loading,
  onChange,
  testId,
  label,
}: {
  checked: boolean;
  loading: boolean;
  onChange: (checked: boolean) => void;
  testId: string;
  label: string;
}): JSX.Element {
  if (loading) {
    return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-text-subtle" strokeWidth={1.5} />;
  }
  return (
    <input
      type="checkbox"
      checked={checked}
      aria-label={label}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => {
        e.stopPropagation();
        onChange(e.target.checked);
      }}
      data-testid={testId}
      className="h-4 w-4 shrink-0 accent-primary"
    />
  );
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
  allChecked,
  isSourceChecked,
  isProjectChecked,
  loadingScope,
  onToggleAll,
  onToggleSourceScope,
  onToggleProjectScope,
}: SourceTreeProps): JSX.Element {
  return (
    <div
      className="flex w-72 shrink-0 flex-col rounded-lg border border-border bg-surface-1"
      data-testid="source-tree"
    >
      {/* Tree top: select-all-projects. */}
      <div className="border-b border-border px-3 py-2.5">
        <label className="flex items-center gap-2 text-sm font-medium">
          <ScopeBox
            checked={allChecked}
            loading={loadingScope?.kind === 'all'}
            onChange={onToggleAll}
            testId="select-all-projects"
            label="选择全部项目"
          />
          选择全部项目
        </label>
      </div>

      {error && (
        <div className="border-b border-border bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {sources.map((source) => {
          const isOpen = expanded.has(source.id);
          const loaded = projectsBySource[source.id];
          const Chevron = isOpen ? ChevronDown : ChevronRight;
          return (
            <div key={source.id}>
              <div className="flex items-center gap-1.5 rounded-md px-1 hover:bg-surface-2">
                <ScopeBox
                  checked={isSourceChecked(source.id)}
                  loading={loadingScope?.kind === 'source' && loadingScope.sourceId === source.id}
                  onChange={(checked) => onToggleSourceScope(source.id, checked)}
                  testId={`scope-source-${source.id}`}
                  label={`选择 ${source.displayName} 下全部会话`}
                />
                <button
                  type="button"
                  onClick={() => onToggleSource(source.id)}
                  data-testid={`source-${source.id}`}
                  aria-expanded={isOpen}
                  className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left text-sm font-medium"
                >
                  <Chevron className="h-4 w-4 shrink-0 text-text-subtle" strokeWidth={1.5} />
                  <span className="min-w-0 flex-1 truncate">{source.displayName}</span>
                  {loaded && (
                    <span className="shrink-0 text-xs text-text-subtle">{loaded.projects.length}</span>
                  )}
                </button>
              </div>

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
                        <div
                          className={cn(
                            'flex items-center gap-2 rounded-md px-1 hover:bg-surface-2',
                            isActive && 'bg-primary-soft/40',
                          )}
                        >
                          <ScopeBox
                            checked={isProjectChecked(source.id, project.key)}
                            loading={
                              loadingScope?.kind === 'project' &&
                              loadingScope.sourceId === source.id &&
                              loadingScope.projectKey === project.key
                            }
                            onChange={(checked) => onToggleProjectScope(source.id, project, checked)}
                            testId={`scope-project-${project.key}`}
                            label={`选择 ${project.label} 下全部会话`}
                          />
                          <button
                            type="button"
                            onClick={() => onSelectProject(source.id, project)}
                            data-testid={`project-${project.key}`}
                            title={project.cwd ?? project.key}
                            className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left text-sm"
                          >
                            <span className="min-w-0 flex-1 truncate">{project.label}</span>
                            {project.recommended && (
                              <Badge variant="success" title={project.recommendReason}>
                                recommended
                              </Badge>
                            )}
                          </button>
                        </div>
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

      {/* Pinned bottom: the whitelist opt-in + its defense copy (mt-auto via flex). */}
      <div className="mt-auto border-t border-border px-3 py-2.5">
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
    </div>
  );
}
