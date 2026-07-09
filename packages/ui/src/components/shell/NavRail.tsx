/**
 * NavRail — the app's left rail (design B2): the MOSGA logo + subtitle, the two
 * v0.x destinations (贡献 / 设置) with lucide icons + active state, and a footer
 * showing the daemon address + health (from `useDaemonStatus`). The 历史
 * destination is out of scope (Later list). Pure presentation; navigation state
 * lives in `AppShell` and flows in via props.
 */
import { HeartHandshake, type LucideIcon, Settings } from 'lucide-react';

import type { ApiClient } from '../../api/client';
import { cn } from '../../lib/cn';
import { useDaemonStatus } from '../../lib/useDaemonStatus';

export type ShellView = 'contribute' | 'settings';

interface NavItemDef {
  id: ShellView;
  icon: LucideIcon;
  label: string;
}

const NAV_ITEMS: NavItemDef[] = [
  { id: 'contribute', icon: HeartHandshake, label: '贡献' },
  { id: 'settings', icon: Settings, label: '设置' },
];

interface NavRailProps {
  client: ApiClient;
  activeView: ShellView;
  onNavigate: (view: ShellView) => void;
}

export function NavRail({ client, activeView, onNavigate }: NavRailProps): JSX.Element {
  const daemon = useDaemonStatus(client);
  const healthy = daemon.status === 'ok';

  return (
    <aside
      className="flex w-56 shrink-0 flex-col border-r border-border bg-surface-1"
      data-testid="nav-rail"
    >
      <div className="border-b border-border/60 px-4 py-4">
        <div className="flex items-center gap-2">
          <HeartHandshake className="h-5 w-5 text-primary" strokeWidth={1.5} aria-hidden="true" />
          <span className="font-display text-base font-semibold">MOSGA</span>
        </div>
        <p className="mt-1 text-xs text-text-subtle">让数据捐赠有尊严</p>
      </div>

      <nav className="flex-1 space-y-1 p-2">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = item.id === activeView;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onNavigate(item.id)}
              aria-current={active ? 'page' : undefined}
              data-testid={`nav-${item.id}`}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                active
                  ? 'bg-surface-2/60 text-foreground'
                  : 'text-text-muted hover:bg-surface-2/40 hover:text-foreground',
              )}
            >
              <Icon className="h-4 w-4 shrink-0" strokeWidth={1.5} />
              <span className="truncate">{item.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="border-t border-border/60 p-3" data-testid="daemon-footer">
        <div className="flex items-center gap-1.5 text-[11px] text-text-muted">
          <span
            className={cn(
              'h-2 w-2 shrink-0 rounded-full',
              healthy ? 'bg-success' : 'bg-destructive',
            )}
            aria-hidden="true"
          />
          <span data-testid="daemon-health">
            {healthy ? 'daemon 已连接' : daemon.status === 'probing' ? 'daemon 连接中…' : 'daemon 不可达'}
          </span>
        </div>
        <p className="mt-1 truncate text-[10px] text-text-subtle/80" title={daemon.address}>
          {daemon.address}
        </p>
      </div>
    </aside>
  );
}
