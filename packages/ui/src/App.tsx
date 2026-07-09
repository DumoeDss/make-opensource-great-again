import { useState } from 'react';

import { apiClient, type ApiClient } from './api/client';
import type { CreateReviewResponse } from './api/types';
import { Picker } from './components/Picker';
import { ReviewView } from './components/ReviewView';

interface AppProps {
  /** Injectable for tests; defaults to the real same-origin client. */
  client?: ApiClient;
}

export function App({ client = apiClient }: AppProps): JSX.Element {
  const [review, setReview] = useState<CreateReviewResponse | null>(null);

  return (
    <div className="min-h-screen bg-background p-6 text-foreground">
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
    </div>
  );
}
