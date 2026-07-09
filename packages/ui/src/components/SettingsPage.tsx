/**
 * SettingsPage — the 设置 destination (design B2, scoped to slice 2): a
 * three-state theme toggle (light / dark / system) driving `lib/theme.ts`, the
 * daemon address + health (`useDaemonStatus`), and a read-only list of configured
 * provider targets (`/api/providers`, key-free). The data-repository path and
 * preflight provider-key status are deferred to slice 3 (their endpoints don't
 * exist yet).
 */
import { Monitor, Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { ApiClient } from '../api/client';
import type { ProviderTarget } from '../api/types';
import { cn } from '../lib/cn';
import { getTheme, setTheme, subscribe, type ThemeChoice } from '../lib/theme';
import { useDaemonStatus } from '../lib/useDaemonStatus';

interface SettingsPageProps {
  client: ApiClient;
}

const THEME_OPTIONS: Array<{ id: ThemeChoice; label: string; icon: typeof Sun }> = [
  { id: 'light', label: '浅色', icon: Sun },
  { id: 'dark', label: '深色', icon: Moon },
  { id: 'system', label: '跟随系统', icon: Monitor },
];

export function SettingsPage({ client }: SettingsPageProps): JSX.Element {
  const [theme, setThemeState] = useState<ThemeChoice>(getTheme());
  const [providers, setProviders] = useState<ProviderTarget[]>([]);
  const daemon = useDaemonStatus(client);

  useEffect(() => subscribe(setThemeState), []);

  useEffect(() => {
    let active = true;
    client
      .listProviders()
      .then((list) => active && setProviders(list))
      .catch(() => active && setProviders([]));
    return () => {
      active = false;
    };
  }, [client]);

  return (
    <div className="mx-auto max-w-2xl space-y-6" data-testid="settings-page">
      <h1 className="text-xl font-semibold">设置</h1>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-text-muted">深浅模式</h2>
        <div className="inline-flex rounded-md border border-border bg-surface-1 p-1" data-testid="theme-toggle">
          {THEME_OPTIONS.map((opt) => {
            const Icon = opt.icon;
            const active = theme === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => setTheme(opt.id)}
                aria-pressed={active}
                data-testid={`theme-${opt.id}`}
                className={cn(
                  'flex items-center gap-1.5 rounded px-3 py-1.5 text-sm transition-colors',
                  active
                    ? 'bg-surface-2 text-foreground'
                    : 'text-text-muted hover:text-foreground',
                )}
              >
                <Icon className="h-4 w-4" strokeWidth={1.5} />
                {opt.label}
              </button>
            );
          })}
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-text-muted">daemon 状态</h2>
        <div className="rounded-md border border-border bg-surface-1 p-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-text-muted">地址</span>
            <span className="font-mono" data-testid="settings-daemon-address">{daemon.address}</span>
          </div>
          <div className="mt-1 flex items-center justify-between">
            <span className="text-text-muted">健康</span>
            <span data-testid="settings-daemon-health">
              {daemon.status === 'ok'
                ? `已连接 (${daemon.name ?? 'daemon'} ${daemon.version ?? ''})`
                : daemon.status === 'probing'
                  ? '连接中…'
                  : '不可达'}
            </span>
          </div>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-text-muted">已配置的直投目标（只读）</h2>
        <ul className="divide-y divide-border rounded-md border border-border" data-testid="provider-list">
          {providers.map((p) => (
            <li key={p.id} className="flex items-center justify-between px-3 py-2 text-sm">
              <span>
                <b>{p.name}</b>
                <span className="ml-2 text-xs text-text-subtle">{p.apiFormat}</span>
              </span>
              <span className="text-xs text-text-subtle">{p.models.length} 个模型</span>
            </li>
          ))}
          {providers.length === 0 && (
            <li className="px-3 py-4 text-center text-sm text-text-subtle">未配置直投目标。</li>
          )}
        </ul>
      </section>
    </div>
  );
}
