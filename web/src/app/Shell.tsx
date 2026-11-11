import { NavLink, Outlet } from 'react-router';
import { useOverview, useThreads } from '../api/queries';
import { Icon, type IconName } from '../components/Icon';
import { UsageMeter } from '../components/UsageMeter';
import { Banners } from './Banners';
import { ConnectionIndicator } from './ConnectionIndicator';
import { WaitingCounter } from './WaitingCounter';
import { currentDeploymentLabel } from './deployment-label';
import styles from './Shell.module.css';
import { usePersistentState } from './usePersistentState';

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

const NAV_COLLAPSED_KEY = 'jarvis.nav.collapsed';
const asBoolean = (raw: unknown) => (typeof raw === 'boolean' ? raw : undefined);

function NavItems({ items, collapsed }: { items: readonly NavItem[]; collapsed: boolean }) {
  return items.map(({ to, label, icon }) => (
    <NavLink
      key={to}
      to={to}
      title={collapsed ? label : undefined}
      className={({ isActive }) => `${styles.link} ${isActive ? styles.active : ''}`}
    >
      <Icon name={icon} className={styles.linkIcon} />
      {/* Hidden only visually when collapsed, so the link keeps its accessible name. */}
      <span className={collapsed ? 'visually-hidden' : styles.linkLabel}>{label}</span>
    </NavLink>
  ));
}

export function Shell() {
  const overview = useOverview();
  const threads = useThreads();
  const deployment = currentDeploymentLabel();
  const [collapsed, setCollapsed] = usePersistentState(NAV_COLLAPSED_KEY, false, asBoolean);
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <button
          type="button"
          className={styles.navToggle}
          aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          title={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          aria-expanded={!collapsed}
          aria-controls="main-nav"
          onClick={() => setCollapsed(!collapsed)}
        >
          <Icon name={collapsed ? 'panel-left-open' : 'panel-left-close'} />
        </button>
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
        <nav
          id="main-nav"
          className={`${styles.nav} ${collapsed ? styles.collapsed : ''}`}
          aria-label="Main"
        >
          <div className={styles.group}>
            <NavItems items={MAIN_NAV} collapsed={collapsed} />
          </div>
          <div className={styles.group}>
            <NavItems items={SERVICE_NAV} collapsed={collapsed} />
          </div>
        </nav>
        <main className={styles.main}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
