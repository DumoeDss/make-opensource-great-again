import { useState } from 'react';

import { apiClient, type ApiClient } from './api/client';
import type { QueueItem } from './api/types';
import { SessionPicker } from './components/picker/SessionPicker';
import { ReviewView } from './components/ReviewView';
import { AppShell } from './components/shell/AppShell';

interface AppProps {
  /** Injectable for tests; defaults to the real same-origin client. */
  client?: ApiClient;
}

export function App({ client = apiClient }: AppProps): JSX.Element {
  const [queue, setQueue] = useState<QueueItem[] | null>(null);

  // The 贡献 destination keeps the picker↔journey toggle: the SessionPicker when no
  // queue exists (step ①), the queue-aware journey container once a queue is created.
  return (
    <AppShell client={client}>
      {queue ? (
        <ReviewView client={client} items={queue} onRestart={() => setQueue(null)} />
      ) : (
        <SessionPicker client={client} onQueueCreated={setQueue} />
      )}
    </AppShell>
  );
}
