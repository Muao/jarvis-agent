import type { ConnectionDto, ConnectionId } from '@jarvis/shared';
import { useConnections } from '../../api/queries';
import { ErrorBlock } from '../../components/ErrorBlock';
import { Loading } from '../../components/Loading';
import { RelativeTime } from '../../components/RelativeTime';
import styles from './Connections.module.css';

const NAMES: Record<ConnectionId, string> = {
  claude: 'Claude CLI',
  github: 'GitHub',
  notion: 'Notion',
  google_docs: 'Google Docs',
  claude_design: 'Claude Design',
  slack: 'Slack',
};

const STATUS_LABEL: Record<ConnectionDto['status'], string> = {
  ok: 'Connected',
  warning: 'Warning',
  failed: 'Error',
  checking: 'Checking…',
  not_configured: 'Not configured',
  disabled: 'Disabled',
};

function ConnectionRow({
  connection,
  billingEnvDetected,
  claudeSubscription,
  checking,
  onCheck,
}: {
  connection: ConnectionDto;
  billingEnvDetected: boolean;
  claudeSubscription: boolean | null;
  checking: boolean;
  onCheck: () => void;
}) {
  const name = NAMES[connection.id];
  const inactive = connection.id === 'slack';
  // SEC-05: an API key in the environment, or a login that is not the subscription.
  const showBillingWarning =
    connection.id === 'claude' && (billingEnvDetected || claudeSubscription === false);
  const status = checking ? 'checking' : connection.status;

  return (
    <li className={`${styles.row} ${inactive ? styles.inactive : ''}`} aria-label={name}>
      <div>
        <h2 className={styles.name}>{name}</h2>
        {inactive ? (
          <p className={styles.muted}>Iteration 2</p>
        ) : (
          <>
            <p>
              <span
                className={`${styles.status} ${connection.status === 'ok' ? styles.ok : ''} ${connection.status === 'warning' ? styles.warning : ''} ${connection.status === 'failed' ? styles.failed : ''}`}
              >
                {connection.status === 'ok'
                  ? '✓ '
                  : connection.status === 'warning'
                    ? '⚠ '
                    : connection.status === 'failed'
                      ? '✕ '
                      : ''}
                {STATUS_LABEL[status]}
              </span>
              {connection.summary ? ` — ${connection.summary}` : null}
            </p>
            {connection.details.length > 0 ? (
              <dl className={styles.details}>
                {connection.details.map((d) => (
                  <div key={d.label}>
                    <dt>{d.label}:</dt>
                    <dd>{d.value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
            {connection.id === 'claude' && connection.status === 'not_configured' ? (
              <p className={styles.muted}>
                Not logged in. Run <code>claude login</code> in a terminal.
              </p>
            ) : null}
            {showBillingWarning ? (
              <p role="alert" className={styles.danger}>
                ⚠ API billing detected: the Claude CLI would charge the API instead of your
                subscription. Unset <code>ANTHROPIC_API_KEY</code> and log in with{' '}
                <code>claude login</code>.
              </p>
            ) : null}
            <p className={styles.muted}>
              {connection.checkedAt ? (
                <>
                  Checked <RelativeTime at={connection.checkedAt} />
                </>
              ) : (
                'Not checked yet'
              )}
            </p>
          </>
        )}
      </div>
      {inactive ? null : (
        <button type="button" className={styles.button} disabled={checking} onClick={onCheck}>
          Check again<span className="visually-hidden"> {name}</span>
        </button>
      )}
    </li>
  );
}

export function ConnectionsPage() {
  const { data, error, isPending, isFetching, refetch } = useConnections();

  if (isPending) return <Loading label="Loading connections…" />;
  if (error) {
    return (
      <ErrorBlock error={error} title="Could not load connections" onRetry={() => void refetch()} />
    );
  }

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Connections</h1>
      <ul className={styles.list}>
        {data.connections.map((connection) => (
          <ConnectionRow
            key={connection.id}
            connection={connection}
            billingEnvDetected={data.billingEnvDetected}
            claudeSubscription={data.claudeSubscription}
            checking={isFetching}
            onCheck={() => void refetch()}
          />
        ))}
      </ul>
    </div>
  );
}
