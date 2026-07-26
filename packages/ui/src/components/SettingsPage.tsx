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
import { useTranslation } from 'react-i18next';

import type { ApiClient } from '../api/client';
import { API_FORMATS, type ApiFormat, type KeyStatusMap, type ProviderTarget } from '../api/types';
import { cn } from '../lib/cn';
import type { Language } from '../lib/i18n';
import { getLanguage, setLanguage } from '../lib/lang';
import { getTheme, setTheme, subscribe, type ThemeChoice } from '../lib/theme';
import { useDaemonStatus } from '../lib/useDaemonStatus';
import { usePreflight } from '../lib/usePreflight';

interface SettingsPageProps {
  client: ApiClient;
}

const THEME_OPTIONS: Array<{ id: ThemeChoice; label: string; icon: typeof Sun }> = [
  { id: 'light', label: 'settings.theme.light', icon: Sun },
  { id: 'dark', label: 'settings.theme.dark', icon: Moon },
  { id: 'system', label: 'settings.theme.system', icon: Monitor },
];

const LANG_OPTIONS: Array<{ id: Language; label: string }> = [
  { id: 'zh', label: '中文' },
  { id: 'ja', label: '日本語' },
  { id: 'en', label: 'English' },
  { id: 'ko', label: '한국어' },
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
  const { t, i18n } = useTranslation();
  const [theme, setThemeState] = useState<ThemeChoice>(getTheme());
  const [lang, setLangState] = useState<Language>(getLanguage());
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

  useEffect(() => {
    const handler = (lng: string): void => setLangState(lng as Language);
    i18n.on('languageChanged', handler);
    return () => {
      i18n.off('languageChanged', handler);
    };
  }, [i18n]);

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
      <h1 className="text-xl font-semibold">{t('settings.heading')}</h1>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-text-muted">{t('settings.theme.label')}</h2>
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
                {t(opt.label)}
              </button>
            );
          })}
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-text-muted">{t('settings.language.label')}</h2>
        <div className="inline-flex rounded-md border border-border bg-surface-1 p-1" data-testid="lang-toggle">
          {LANG_OPTIONS.map((opt) => {
            const active = lang === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => setLanguage(opt.id)}
                aria-pressed={active}
                data-testid={`lang-${opt.id}`}
                className={cn(
                  'flex items-center gap-1.5 rounded px-3 py-1.5 text-sm transition-colors',
                  active
                    ? 'bg-surface-2 text-foreground'
                    : 'text-text-muted hover:text-foreground',
                )}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-text-muted">{t('settings.daemon.heading')}</h2>
        <div className="rounded-md border border-border bg-surface-1 p-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-text-muted">{t('settings.daemon.address')}</span>
            <span className="font-mono" data-testid="settings-daemon-address">{daemon.address}</span>
          </div>
          <div className="mt-1 flex items-center justify-between">
            <span className="text-text-muted">{t('settings.daemon.health')}</span>
            <span data-testid="settings-daemon-health">
              {daemon.status === 'ok'
                ? t('settings.daemon.healthOk', { name: daemon.name ?? 'daemon', version: daemon.version ?? '' })
                : daemon.status === 'probing'
                  ? t('settings.daemon.healthProbing')
                  : t('settings.daemon.healthUnreachable')}
            </span>
          </div>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-text-muted">{t('settings.dataRepo.heading')}</h2>
        <div className="rounded-md border border-border bg-surface-1 p-3 text-sm" data-testid="settings-data-repo">
          <div className="flex items-center justify-between">
            <span className="text-text-muted">{t('settings.dataRepo.status')}</span>
            <span data-testid="settings-data-repo-status">
              {flags == null ? t('settings.dataRepo.probing') : flags.dataRepoConfigured ? t('settings.dataRepo.configured') : t('settings.dataRepo.notConfigured')}
            </span>
          </div>
          <p className="mt-2 text-xs text-text-subtle">
            {t('settings.dataRepo.pathHintPrefix')}{' '}
            <code className="font-mono">{t('settings.dataRepo.pathHintCode')}</code>{' '}
            {t('settings.dataRepo.pathHintSuffix')}
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
        <h2 className="text-sm font-medium text-text-muted">{t('providers.heading')}</h2>
        <p className="text-xs text-text-subtle" data-testid="key-storage-disclosure">
          {t('providers.disclosurePrefix')}<code className="font-mono">{t('providers.disclosureCode')}</code>{t('providers.disclosureSuffix')}
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
                    {isCustom && <span className="ml-2 text-xs text-accent">{t('providers.custom')}</span>}
                  </span>
                  <span className="text-xs text-text-subtle">{t('providers.modelCount', { count: p.models.length })}</span>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-text-muted" data-testid={`key-status-${p.id}`}>
                    {configured ? t('providers.keyConfigured') : t('providers.keyNotConfigured')}
                  </span>
                  {showKeyInput ? (
                    <>
                      <input
                        type="password"
                        value={keyInputs[p.id] ?? ''}
                        onChange={(e) => setKeyInputs((prev) => ({ ...prev, [p.id]: e.target.value }))}
                        placeholder={isReplacing ? t('providers.keyPlaceholderNew') : t('providers.keyPlaceholder')}
                        data-testid={`key-input-${p.id}`}
                        className="min-w-0 flex-1 rounded border border-border bg-surface-1 px-2 py-1 text-xs"
                      />
                      <button
                        type="button"
                        onClick={() => void setKey(p.id)}
                        data-testid={`key-set-${p.id}`}
                        className="rounded border border-border px-2 py-1 text-xs hover:bg-surface-2"
                      >
                        {t('providers.saveKey')}
                      </button>
                      {isReplacing && (
                        <button
                          type="button"
                          onClick={() => cancelReplace(p.id)}
                          data-testid={`key-replace-cancel-${p.id}`}
                          className="rounded border border-border px-2 py-1 text-xs hover:bg-surface-2"
                        >
                          {t('providers.cancel')}
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
                        {t('providers.replaceKey')}
                      </button>
                      <button
                        type="button"
                        onClick={() => void clearKey(p.id)}
                        data-testid={`key-clear-${p.id}`}
                        className="rounded border border-border px-2 py-1 text-xs hover:bg-surface-2"
                      >
                        {t('providers.clearKey')}
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
                        {t('providers.edit')}
                      </button>
                      <button
                        type="button"
                        onClick={() => void deleteProvider(p.id)}
                        data-testid={`provider-delete-${p.id}`}
                        className="rounded border border-border px-2 py-1 text-xs hover:bg-surface-2"
                      >
                        {t('providers.delete')}
                      </button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
          {providers.length === 0 && (
            <li className="px-3 py-4 text-center text-sm text-text-subtle">{t('providers.empty')}</li>
          )}
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-text-muted">
          {editingId ? t('settings.customProvider.editing', { id: editingId }) : t('settings.customProvider.add')}
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
              placeholder={t('settings.customProvider.idPlaceholder')}
              data-testid="custom-provider-id"
              className="rounded border border-border bg-surface-1 px-2 py-1 text-xs disabled:opacity-60"
            />
            <input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder={t('settings.customProvider.namePlaceholder')}
              data-testid="custom-provider-name"
              className="rounded border border-border bg-surface-1 px-2 py-1 text-xs"
            />
          </div>
          <input
            value={form.apiBaseUrl}
            onChange={(e) => setForm((f) => ({ ...f, apiBaseUrl: e.target.value }))}
            placeholder={t('settings.customProvider.urlPlaceholder')}
            data-testid="custom-provider-base-url"
            className="w-full rounded border border-border bg-surface-1 px-2 py-1 text-xs"
          />
          <input
            value={form.models}
            onChange={(e) => setForm((f) => ({ ...f, models: e.target.value }))}
            placeholder={t('settings.customProvider.modelsPlaceholder')}
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
              {editingId ? t('providers.update') : t('providers.add')}
            </button>
            {editingId && (
              <button
                type="button"
                onClick={resetForm}
                data-testid="custom-provider-cancel"
                className="rounded border border-border px-3 py-1 text-xs hover:bg-surface-2"
              >
                {t('providers.cancel')}
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
