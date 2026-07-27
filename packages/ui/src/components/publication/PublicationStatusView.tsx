import type {
  PublicationStatus,
  PublicationTargetSummary,
} from '../../api/types';
import { Badge } from '../ui/badge';

export function canPreviewPublication(status: PublicationStatus | null): boolean {
  return status?.state === 'ready' || status?.state === 'fork_confirmation_required';
}

export function publicationRouteSummary(status: PublicationStatus | null): string {
  if (!status) return 'Publication status is unavailable.';
  switch (status.state) {
    case 'unconfigured':
      return 'Configure a GitHub owner/repo target in Settings.';
    case 'login_required':
      return `Sign in to GitHub before contributing to ${status.target.slug}.`;
    case 'fork_confirmation_required':
      return `A public fork ${status.pushRepository} may be created after confirmation for ${status.target.slug}.`;
    case 'ready':
      return status.route === 'direct'
        ? `Contribute to ${status.target.slug}; push to the same repository.`
        : `Open a PR to ${status.target.slug} through ${status.pushRepository}.`;
    case 'blocked':
      return status.target
        ? `Publication to ${status.target.slug} is blocked.`
        : 'Publication is blocked; target details are unavailable.';
  }
}

function statusLabel(status: PublicationStatus): string {
  switch (status.state) {
    case 'unconfigured':
      return 'Unconfigured';
    case 'login_required':
      return 'Login required';
    case 'fork_confirmation_required':
      return 'Fork confirmation required';
    case 'ready':
      return status.route === 'direct' ? 'Ready · direct' : 'Ready · fork';
    case 'blocked':
      return 'Blocked';
  }
}

function targetFrom(status: PublicationStatus): PublicationTargetSummary | null {
  switch (status.state) {
    case 'unconfigured':
      return null;
    case 'blocked':
      return status.target ?? null;
    default:
      return status.target;
  }
}

interface PublicationStatusViewProps {
  status: PublicationStatus;
  detail?: 'compact' | 'full';
}

/** Exhaustive, safe presentation shared by Settings and exit cards. */
export function PublicationStatusView({
  status,
  detail = 'compact',
}: PublicationStatusViewProps): JSX.Element {
  const target = targetFrom(status);
  const actor =
    status.state === 'ready' || status.state === 'fork_confirmation_required'
      ? status.actor
      : null;
  const pushRepository =
    status.state === 'ready' || status.state === 'fork_confirmation_required'
      ? status.pushRepository
      : null;
  const route =
    status.state === 'ready'
      ? status.route
      : status.state === 'fork_confirmation_required'
        ? 'fork · created on submit after confirmation'
        : null;

  return (
    <div className="min-w-0 space-y-3" data-publication-state={status.state}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={canPreviewPublication(status) ? 'success' : 'secondary'}>
          {statusLabel(status)}
        </Badge>
        <span className="min-w-0 break-words text-sm text-text-muted">
          {publicationRouteSummary(status)}
        </span>
      </div>

      {detail === 'compact' ? (
        <CompactStatusFacts status={status} target={target} />
      ) : (
        <dl className="grid min-w-0 gap-x-5 gap-y-2 text-sm sm:grid-cols-2">
          <Fact label="Target revision" value={String(status.revision)} />
          {target ? (
            <>
              <Fact label="Canonical upstream" value={target.slug} mono />
              <Fact label="Visibility" value={target.visibility} />
              <Fact label="Default branch" value={target.defaultBranch} mono />
              <Fact label="Base commit" value={target.baseCommitSha} mono />
              <Fact label="Actor" value={actor} mono />
              <Fact label="Push route" value={route} />
              <Fact label="Push repository" value={pushRepository} mono />
              <Fact label="Dataset kind" value={target.manifest.kind} mono />
              <Fact label="Contract version" value={String(target.manifest.contractVersion)} />
              <Fact
                label="Accepted schemas"
                value={target.manifest.acceptedSchemaVersions.join(', ')}
                mono
              />
              <Fact label="License" value={target.manifest.license} mono />
              <Fact label="Manifest hash" value={target.manifest.contentHash} mono />
            </>
          ) : status.state === 'blocked' ? (
            <Fact label="Target details" value="Unavailable from the daemon." />
          ) : null}
        </dl>
      )}

      {status.state === 'blocked' && status.issues.length > 0 && (
        <ul className="space-y-2" aria-label="Publication issues">
          {status.issues.map((issue, index) => (
            <li
              key={`${issue.code}-${index}`}
              className="min-w-0 break-words rounded-md border border-border bg-surface-2 p-3 text-sm"
            >
              <p className="font-medium">{issue.message}</p>
              {issue.recovery && <p className="mt-1 text-text-muted">{issue.recovery}</p>}
              <p className="mt-1 text-xs text-text-subtle">
                {issue.retryable ? 'Retry may succeed.' : 'Configuration needs attention.'}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CompactStatusFacts({
  status,
  target,
}: {
  status: PublicationStatus;
  target: PublicationTargetSummary | null;
}): JSX.Element | null {
  if (status.state === 'unconfigured') return null;
  if (status.state === 'login_required') {
    return (
      <dl className="grid min-w-0 gap-x-5 gap-y-2 text-sm sm:grid-cols-2">
        <Fact label="Canonical upstream" value={status.target.slug} mono />
        <Fact label="Default branch" value={status.target.defaultBranch} mono />
      </dl>
    );
  }
  if (status.state === 'fork_confirmation_required') {
    return (
      <dl className="grid min-w-0 gap-x-5 gap-y-2 text-sm sm:grid-cols-2">
        <Fact label="Actor" value={status.actor} mono />
        <Fact label="Canonical upstream" value={status.target.slug} mono />
        <Fact label="Push repository" value={status.pushRepository} mono />
      </dl>
    );
  }
  if (status.state === 'ready') {
    return (
      <dl className="grid min-w-0 gap-x-5 gap-y-2 text-sm sm:grid-cols-2">
        <Fact label="Actor" value={status.actor} mono />
        <Fact label="Canonical upstream" value={status.target.slug} mono />
        <Fact label="Default branch" value={status.target.defaultBranch} mono />
        <Fact label="Base commit" value={status.target.baseCommitSha} mono />
        <Fact label="Push route" value={status.route} />
        <Fact label="Push repository" value={status.pushRepository} mono />
        <Fact label="Target revision" value={String(status.revision)} />
      </dl>
    );
  }
  return target ? (
    <dl className="grid min-w-0 gap-x-5 gap-y-2 text-sm sm:grid-cols-2">
      <Fact label="Canonical upstream" value={target.slug} mono />
      <Fact label="Default branch" value={target.defaultBranch} mono />
      <Fact label="Target revision" value={String(status.revision)} />
    </dl>
  ) : null;
}

function Fact({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string | null;
  mono?: boolean;
}): JSX.Element | null {
  if (!value) return null;
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium uppercase tracking-wide text-text-subtle">{label}</dt>
      <dd className={`mt-0.5 break-all text-text ${mono ? 'font-mono' : ''}`}>{value}</dd>
    </div>
  );
}
