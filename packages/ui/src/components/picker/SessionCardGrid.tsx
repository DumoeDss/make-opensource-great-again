/**
 * SessionCardGrid — the picker's right pane (design B1). A responsive card grid of
 * the active folder's sessions; each card toggles its own selection. Selection is
 * owned by `SessionPicker` and accumulates across folders, so this component is a
 * controlled view: it renders the passed `selection` and emits toggle/select-all/
 * clear intents.
 *
 * A card shows the truncated title (full title via a native `title` tooltip),
 * relative update time, and humanized size. The whole card is the click target
 * (elftia parity), with a checkbox glyph as the affordance and a ring on selection.
 */
import { Check } from 'lucide-react';

import type { SessionRef } from '../../api/types';
import { cn } from '../../lib/cn';
import { formatBytes, formatRelativeTime } from '../../lib/format';
import { Button } from '../ui/button';

interface SessionCardGridProps {
  /** The active folder's label, or `null` when no folder is open yet. */
  folderLabel: string | null;
  sessions: SessionRef[];
  selection: Map<string, SessionRef>;
  selectionKey: (ref: SessionRef) => string;
  onToggle: (ref: SessionRef) => void;
  onSelectAll: () => void;
  onClear: () => void;
}

export function SessionCardGrid({
  folderLabel,
  sessions,
  selection,
  selectionKey,
  onToggle,
  onSelectAll,
  onClear,
}: SessionCardGridProps): JSX.Element {
  if (folderLabel === null) {
    return (
      <div
        className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-border text-sm text-text-subtle"
        data-testid="grid-empty"
      >
        从左侧选择一个文件夹以查看会话。
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="min-w-0 truncate text-sm font-medium text-text-muted" title={folderLabel}>
          {folderLabel}
        </h2>
        <div className="flex shrink-0 gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onSelectAll}
            disabled={sessions.length === 0}
            data-testid="select-all"
          >
            全选本文件夹
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClear}
            disabled={selection.size === 0}
            data-testid="clear-selection"
          >
            清空
          </Button>
        </div>
      </div>

      {sessions.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-8 text-center text-sm text-text-subtle">
          该文件夹没有会话。
        </p>
      ) : (
        // The grid scrolls on its own; the folder header + 全选/清空 stay pinned above.
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(240px,1fr))]">
          {sessions.map((session) => {
            const selected = selection.has(selectionKey(session));
            return (
              <button
                key={session.id}
                type="button"
                onClick={() => onToggle(session)}
                aria-pressed={selected}
                data-testid={`session-card-${session.id}`}
                className={cn(
                  'flex flex-col gap-2 rounded-lg border p-3 text-left transition-colors',
                  selected
                    ? 'border-primary bg-primary-soft/25'
                    : 'border-border bg-surface-1 hover:border-text-subtle/40',
                )}
              >
                <div className="flex items-start gap-2">
                  <span
                    className={cn(
                      'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                      selected ? 'border-primary bg-primary text-primary-foreground' : 'border-border',
                    )}
                    aria-hidden="true"
                  >
                    {selected && <Check className="h-3 w-3" strokeWidth={2} />}
                  </span>
                  <span
                    className="min-w-0 flex-1 truncate text-sm font-medium"
                    title={session.title ?? session.id}
                  >
                    {session.title ?? session.id}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs text-text-subtle">
                  <span>{formatRelativeTime(session.updatedAt)}</span>
                  <span>{formatBytes(session.sizeBytes)}</span>
                </div>
              </button>
            );
          })}
          </div>
        </div>
      )}
    </div>
  );
}
