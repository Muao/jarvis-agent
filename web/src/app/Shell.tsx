import { NavLink, Outlet } from 'react-router';
import { useOverview, useThreads } from '../api/queries';
import { Icon, type IconName } from '../components/Icon';
import { UsageMeter } from '../components/UsageMeter';
import { Banners } from './Banners';
import { ConnectionIndicator } from './ConnectionIndicator';
import { WaitingCounter } from './WaitingCounter';
import { currentDeploymentLabel } from './deployment-label';
import styles from './Shell.module.css';

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
}

const MAIN_NAV: readonly NavItem[] = [
  { to: '/chat', label: 'Chat', icon: 'chat' },
  { to: '/overview', label: 'Overview', icon: 'overview' },
  { to: '/tasks', label: 'Tasks', icon: 'tasks' },
];

const SERVICE_NAV: readonly NavItem[] = [
  { to: '/capabilities', label: 'Capabilities', icon: 'capabilities' },
  { to: '/usage', label: 'Usage', icon: 'usage' },
  { to: '/config', label: 'Config', icon: 'config' },
  { to: '/connections', label: 'Connections', icon: 'connections' },
];

function NavItems({ items }: { items: readonly NavItem[] }) {
  return items.map(({ to, label, icon }) => (
    <NavLink
      key={to}
      to={to}
      className={({ isActive }) => `${styles.link} ${isActive ? styles.active : ''}`}
    >
      <Icon name={icon} className={styles.linkIcon} />
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
        <span className={styles.brand}>
          <span className={styles.logo} aria-hidden="true">
            <Icon name="bot" size="md" />
          </span>
          <span className={styles.product}>Jarvis</span>
        </span>
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
