/**
 * SettingsPage — the 设置 destination: a three-state theme toggle
 * (light / dark / system) driving `lib/theme.ts`, the daemon address + health
 * (`useDaemonStatus`), the read-only data-repo status, and the INTERACTIVE
 * provider surface: the allowlisted vendor presets (read-only) plus custom
 * providers (add / edit / delete) and per-provider API-key set/clear. Key entry
 * is write-only — the page shows only a `configured` status, never a key value,
 * and discloses that a submitted key is stored encrypted at rest.
 */
import { Monitor, Moon, Sun } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import type { ApiClient } from '../api/client';
import { API_FORMATS, type ApiFormat, type KeyStatusMap, type ProviderTarget } from '../api/types';
import { cn } from '../lib/cn';
import { getTheme, setTheme, subscribe, type ThemeChoice } from '../lib/theme';
import { useDaemonStatus } from '../lib/useDaemonStatus';
import { usePreflight } from '../lib/usePreflight';

interface SettingsPageProps {
  client: ApiClient;
}

const THEME_OPTIONS: Array<{ id: ThemeChoice; label: string; icon: typeof Sun }> = [
  { id: 'light', label: '浅色', icon: Sun },
  { id: 'dark', label: '深色', icon: Moon },
  { id: 'system', label: '跟随系统', icon: Monitor },
];

interface ProviderFormState {
  id: string;
  name: string;
  apiBaseUrl: string;
  models: string;
  apiFormat: ApiFormat;
}

const EMPTY_FORM: ProviderFormState = {
  id: '',
  name: '',
  apiBaseUrl: '',
  models: '',
  apiFormat: 'openai',
};

export function SettingsPage({ client }: SettingsPageProps): JSX.Element {
  const [theme, setThemeState] = useState<ThemeChoice>(getTheme());
  const [providers, setProviders] = useState<ProviderTarget[]>([]);
  const [customIds, setCustomIds] = useState<Set<string>>(new Set());
  const [keyStatus, setKeyStatus] = useState<KeyStatusMap>({});
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({});
  // Ids whose write-only key input is revealed while ALREADY configured, so a
  // stored key can be rotated in place. We never render any stored value — this
  // only re-shows the empty input; the new key overwrites on save.
  const [replacing, setReplacing] = useState<Set<string>>(new Set());
  const [form, setForm] = useState<ProviderFormState>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const daemon = useDaemonStatus(client);
  const { flags } = usePreflight(client);

  useEffect(() => subscribe(setThemeState), []);

  const refresh = useCallback(async () => {
    const [all, custom, status] = await Promise.all([
      client.listProviders().catch(() => [] as ProviderTarget[]),
      client.listCustomProviders().catch(() => [] as ProviderTarget[]),
      client.getKeyStatus().catch(() => ({}) as KeyStatusMap),
    ]);
    setProviders(all);
    setCustomIds(new Set(custom.map((p) => p.id)));
    setKeyStatus(status);
  }, [client]);

  useEffect(() => {
    let active = true;
    void refresh().catch(() => {
      // A transient load failure leaves the last-known state; nothing to surface.
      if (!active) return;
    });
    return () => {
      active = false;
    };
  }, [refresh]);

  const resetForm = (): void => {
    setForm(EMPTY_FORM);
    setEditingId(null);
  };

  const submitForm = async (): Promise<void> => {
    setError(null);
    const models = form.models
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean);
    try {
      if (editingId) {
        await client.updateCustomProvider(editingId, {
          name: form.name,
          apiFormat: form.apiFormat,
          apiBaseUrl: form.apiBaseUrl,
          models,
        });
      } else {
        await client.createCustomProvider({
          id: form.id,
          name: form.name,
          apiFormat: form.apiFormat,
          apiBaseUrl: form.apiBaseUrl,
          models,
        });
      }
      resetForm();
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const startEdit = (p: ProviderTarget): void => {
    setEditingId(p.id);
    setForm({
      id: p.id,
      name: p.name,
      apiBaseUrl: p.apiBaseUrl,
      models: p.models.join(', '),
      apiFormat: (API_FORMATS as string[]).includes(p.apiFormat)
        ? (p.apiFormat as ApiFormat)
        : 'openai',
    });
  };

  const deleteProvider = async (id: string): Promise<void> => {
    setError(null);
    try {
      await client.deleteCustomProvider(id);
      if (editingId === id) resetForm();
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const startReplace = (id: string): void => {
    setReplacing((prev) => new Set(prev).add(id));
  };

  const cancelReplace = (id: string): void => {
    setReplacing((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setKeyInputs((prev) => ({ ...prev, [id]: '' }));
  };

  const setKey = async (id: string): Promise<void> => {
    const value = keyInputs[id];
    if (!value) return;
    setError(null);
    try {
      await client.setProviderKey(id, value);
      setKeyInputs((prev) => ({ ...prev, [id]: '' }));
      setReplacing((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const clearKey = async (id: string): Promise<void> => {
    setError(null);
    try {
      await client.clearProviderKey(id);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

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
        <h2 className="text-sm font-medium text-text-muted">数据仓库（出口①，只读）</h2>
        <div className="rounded-md border border-border bg-surface-1 p-3 text-sm" data-testid="settings-data-repo">
          <div className="flex items-center justify-between">
            <span className="text-text-muted">状态</span>
            <span data-testid="settings-data-repo-status">
              {flags == null ? '检测中…' : flags.dataRepoConfigured ? '已配置' : '未配置'}
            </span>
          </div>
          <p className="mt-2 text-xs text-text-subtle">
            数据仓库路径是服务端信任配置，仅可在启动时以{' '}
            <code className="font-mono">--data-repo &lt;路径&gt;</code>{' '}
            指定，不经界面填写、不经 HTTP 回显。修改请以该参数重启 daemon。
          </p>
        </div>
      </section>

      {error && (
        <div
          className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive"
          data-testid="settings-error"
        >
          {error}
        </div>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-text-muted">直投目标与密钥</h2>
        <p className="text-xs text-text-subtle" data-testid="key-storage-disclosure">
          预置厂商为固定的开源模型源，不可编辑。API 密钥仅用于出站请求认证，写入后加密存储于本地用户目录
          （<code className="font-mono">~/.mosga/provider-keys.json</code>，AES-256-GCM），永不回显、永不写入任何回执或日志。
        </p>
        <ul className="divide-y divide-border rounded-md border border-border" data-testid="provider-list">
          {providers.map((p) => {
            const isCustom = customIds.has(p.id);
            const configured = keyStatus[p.id]?.configured ?? false;
            const isReplacing = replacing.has(p.id);
            const showKeyInput = !configured || isReplacing;
            return (
              <li key={p.id} className="space-y-2 px-3 py-2 text-sm" data-testid={`provider-row-${p.id}`}>
                <div className="flex items-center justify-between">
                  <span>
                    <b>{p.name}</b>
                    <span className="ml-2 text-xs text-text-subtle">{p.apiFormat}</span>
                    {isCustom && <span className="ml-2 text-xs text-accent">自定义</span>}
                  </span>
                  <span className="text-xs text-text-subtle">{p.models.length} 个模型</span>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-text-muted" data-testid={`key-status-${p.id}`}>
                    {configured ? '密钥已配置' : '密钥未配置'}
                  </span>
                  {showKeyInput ? (
                    <>
                      <input
                        type="password"
                        value={keyInputs[p.id] ?? ''}
                        onChange={(e) => setKeyInputs((prev) => ({ ...prev, [p.id]: e.target.value }))}
                        placeholder={isReplacing ? '输入新的 API 密钥' : '输入 API 密钥'}
                        data-testid={`key-input-${p.id}`}
                        className="min-w-0 flex-1 rounded border border-border bg-surface-1 px-2 py-1 text-xs"
                      />
                      <button
                        type="button"
                        onClick={() => void setKey(p.id)}
                        data-testid={`key-set-${p.id}`}
                        className="rounded border border-border px-2 py-1 text-xs hover:bg-surface-2"
                      >
                        保存密钥
                      </button>
                      {isReplacing && (
                        <button
                          type="button"
                          onClick={() => cancelReplace(p.id)}
                          data-testid={`key-replace-cancel-${p.id}`}
                          className="rounded border border-border px-2 py-1 text-xs hover:bg-surface-2"
                        >
                          取消
                        </button>
                      )}
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => startReplace(p.id)}
                        data-testid={`key-replace-${p.id}`}
                        className="rounded border border-border px-2 py-1 text-xs hover:bg-surface-2"
                      >
                        更换密钥
                      </button>
                      <button
                        type="button"
                        onClick={() => void clearKey(p.id)}
                        data-testid={`key-clear-${p.id}`}
                        className="rounded border border-border px-2 py-1 text-xs hover:bg-surface-2"
                      >
                        清除密钥
                      </button>
                    </>
                  )}
                  {isCustom && (
                    <>
                      <button
                        type="button"
                        onClick={() => startEdit(p)}
                        data-testid={`provider-edit-${p.id}`}
                        className="rounded border border-border px-2 py-1 text-xs hover:bg-surface-2"
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        onClick={() => void deleteProvider(p.id)}
                        data-testid={`provider-delete-${p.id}`}
                        className="rounded border border-border px-2 py-1 text-xs hover:bg-surface-2"
                      >
                        删除
                      </button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
          {providers.length === 0 && (
            <li className="px-3 py-4 text-center text-sm text-text-subtle">未配置直投目标。</li>
          )}
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-text-muted">
          {editingId ? `编辑自定义 Provider：${editingId}` : '添加自定义 Provider'}
        </h2>
        <div
          className="space-y-2 rounded-md border border-border bg-surface-1 p-3 text-sm"
          data-testid="custom-provider-form"
        >
          <div className="grid grid-cols-2 gap-2">
            <input
              value={form.id}
              onChange={(e) => setForm((f) => ({ ...f, id: e.target.value }))}
              disabled={editingId != null}
              placeholder="id（唯一标识）"
              data-testid="custom-provider-id"
              className="rounded border border-border bg-surface-1 px-2 py-1 text-xs disabled:opacity-60"
            />
            <input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="显示名称"
              data-testid="custom-provider-name"
              className="rounded border border-border bg-surface-1 px-2 py-1 text-xs"
            />
          </div>
          <input
            value={form.apiBaseUrl}
            onChange={(e) => setForm((f) => ({ ...f, apiBaseUrl: e.target.value }))}
            placeholder="apiBaseUrl（https://…）"
            data-testid="custom-provider-base-url"
            className="w-full rounded border border-border bg-surface-1 px-2 py-1 text-xs"
          />
          <input
            value={form.models}
            onChange={(e) => setForm((f) => ({ ...f, models: e.target.value }))}
            placeholder="模型（逗号分隔）"
            data-testid="custom-provider-models"
            className="w-full rounded border border-border bg-surface-1 px-2 py-1 text-xs"
          />
          <div className="flex items-center gap-2">
            <select
              value={form.apiFormat}
              onChange={(e) => setForm((f) => ({ ...f, apiFormat: e.target.value as ApiFormat }))}
              data-testid="custom-provider-format"
              className="rounded border border-border bg-surface-1 px-2 py-1 text-xs"
            >
              {API_FORMATS.map((fmt) => (
                <option key={fmt} value={fmt}>
                  {fmt}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void submitForm()}
              data-testid="custom-provider-submit"
              className="rounded border border-border px-3 py-1 text-xs hover:bg-surface-2"
            >
              {editingId ? '更新' : '添加'}
            </button>
            {editingId && (
              <button
                type="button"
                onClick={resetForm}
                data-testid="custom-provider-cancel"
                className="rounded border border-border px-3 py-1 text-xs hover:bg-surface-2"
              >
                取消
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
