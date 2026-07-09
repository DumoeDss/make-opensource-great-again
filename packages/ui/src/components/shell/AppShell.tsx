/**
 * AppShell — the NavRail + content router (design B2). Holds the
 * `'contribute' | 'settings'` view state: the contribute destination renders the
 * journey (passed as children from `App`, so App keeps owning the Picker↔journey
 * toggle), and the settings destination renders `SettingsPage`.
 */
import { useState } from 'react';

import type { ApiClient } from '../../api/client';
import { SettingsPage } from '../SettingsPage';
import { NavRail, type ShellView } from './NavRail';

interface AppShellProps {
  client: ApiClient;
  /** The 贡献 journey content (Picker or the review journey), owned by `App`. */
  children: React.ReactNode;
}

export function AppShell({ client, children }: AppShellProps): JSX.Element {
  const [view, setView] = useState<ShellView>('contribute');

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <NavRail client={client} activeView={view} onNavigate={setView} />
      <main className="min-w-0 flex-1 overflow-y-auto p-6" data-testid="shell-content">
        {view === 'contribute' ? children : <SettingsPage client={client} />}
      </main>
    </div>
  );
}
