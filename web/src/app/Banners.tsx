import { useConnections, useLiveStream, useOverview } from '../api/queries';
import { RelativeTime } from '../components/RelativeTime';
import { usageLevel } from '../components/UsageMeter';
import styles from './Banners.module.css';

/** Full-width notices above every screen: budget pause, lost connection, API billing risk. */
export function Banners() {
  return (
    <>
      <DisconnectedBanner />
      <BudgetBanner />
      <BillingBanner />
    </>
  );
}

function DisconnectedBanner() {
  const { status, lastSeenAt } = useLiveStream();
  if (status === 'live') return null;
  return (
    <div role="status" className={`${styles.banner} ${styles.warning}`}>
      <strong>{status === 'offline' ? 'Offline' : 'Reconnecting…'}</strong> Changes are disabled
      until the engine is back.
      {lastSeenAt !== null ? (
        <>
          {' '}
          Last seen <RelativeTime at={new Date(lastSeenAt).toISOString()} />.
        </>
      ) : null}
    </div>
  );
}

function BudgetBanner() {
  const { data } = useOverview();
  if (!data || usageLevel(data.usage) !== 'paused') return null;
  return (
    <div role="status" className={`${styles.banner} ${styles.danger}`}>
      <strong>Paused: daily budget reached</strong> New tasks wait in the queue. Resets{' '}
      <RelativeTime at={data.usage.resetsAt} />.
    </div>
  );
}

function BillingBanner() {
  const { data } = useConnections();
  if (!data || (!data.billingEnvDetected && data.claudeSubscription !== false)) return null;
  return (
    <div role="alert" className={`${styles.banner} ${styles.danger}`}>
      <strong>API billing risk</strong>{' '}
      {data.billingEnvDetected
        ? 'ANTHROPIC_API_KEY is set, so the CLI would bill the API instead of your subscription.'
        : 'Claude is logged in with an API account, not your subscription.'}
    </div>
  );
}
