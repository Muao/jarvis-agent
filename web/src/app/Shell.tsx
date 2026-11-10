import { NavLink, Outlet } from 'react-router';
import { useOverview, useThreads } from '../api/queries';
import { UsageMeter } from '../components/UsageMeter';
import { Banners } from './Banners';
import { ConnectionIndicator } from './ConnectionIndicator';
import { WaitingCounter } from './WaitingCounter';
import { currentDeploymentLabel } from './deployment-label';
import styles from './Shell.module.css';

const MAIN_NAV = [
  { to: '/chat', label: 'Chat' },
  { to: '/overview', label: 'Overview' },
  { to: '/tasks', label: 'Tasks' },
] as const;

const SERVICE_NAV = [
  { to: '/capabilities', label: 'Capabilities' },
  { to: '/usage', label: 'Usage' },
  { to: '/config', label: 'Config' },
  { to: '/connections', label: 'Connections' },
] as const;

function NavItems({ items }: { items: readonly { to: string; label: string }[] }) {
  return items.map(({ to, label }) => (
    <NavLink
      key={to}
      to={to}
      className={({ isActive }) => `${styles.link} ${isActive ? styles.active : ''}`}
    >
      {label}
    </NavLink>
  ));
}

export function Shell() {
  const overview = useOverview();
  const threads = useThreads();
  const deployment = currentDeploymentLabel();
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <span className={styles.product}>Jarvis</span>
        <span className={styles.local} title={deployment.title}>
          {deployment.text}
        </span>
        <div className={styles.status}>
          {overview.data ? <UsageMeter usage={overview.data.usage} /> : null}
          <WaitingCounter threads={threads.data ?? []} />
          <ConnectionIndicator />
        </div>
      </header>
      <Banners />
      <div className={styles.body}>
        <nav className={styles.nav} aria-label="Main">
          <div className={styles.group}>
            <NavItems items={MAIN_NAV} />
          </div>
          <div className={styles.group}>
            <NavItems items={SERVICE_NAV} />
          </div>
        </nav>
        <main className={styles.main}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
