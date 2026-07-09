import { useState } from 'react';

import { apiClient, type ApiClient } from './api/client';
import type { CreateReviewResponse } from './api/types';
import { Picker } from './components/Picker';
import { ReviewView } from './components/ReviewView';
import { AppShell } from './components/shell/AppShell';

interface AppProps {
  /** Injectable for tests; defaults to the real same-origin client. */
  client?: ApiClient;
}

export function App({ client = apiClient }: AppProps): JSX.Element {
  const [review, setReview] = useState<CreateReviewResponse | null>(null);

  // The 贡献 destination keeps the Picker↔journey toggle: Picker when no review
  // exists (step ①), the journey container once a review is created.
  return (
    <AppShell client={client}>
      {review ? (
        <ReviewView
          client={client}
          reviewId={review.reviewId}
          initialReport={review.report}
          warnings={review.rulesetWarnings}
          onRestart={() => setReview(null)}
        />
      ) : (
        <Picker client={client} onReviewCreated={setReview} />
      )}
    </AppShell>
  );
}
