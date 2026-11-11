import type { ReactNode } from 'react';
import type { ConfigDto, JarvisConfig } from '@jarvis/shared';
import { useConfig } from '../../api/queries';
import { ErrorBlock } from '../../components/ErrorBlock';
import { Loading } from '../../components/Loading';
import { Markdown } from '../../components/Markdown';
import { RelativeTime } from '../../components/RelativeTime';
import { UsageMeter } from '../../components/UsageMeter';
import styles from './Config.module.css';

type ValidConfig = Extract<ConfigDto, { valid: true }>;

const usd = (value: number) => `$${value.toFixed(2)}`;

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className={styles.section} aria-labelledby={id}>
      <h2 id={id} className={styles.sectionTitle}>
        {title}
      </h2>
      {children}
    </section>
  );
}

function limitRows(config: JarvisConfig): [string, string, string][] {
  const { limits, watch, models } = config;
  return [
    [
      'maxConcurrentWorkers',
      String(limits.maxConcurrentWorkers),
      'Worker sessions that may run at once',
    ],
    [
      'checkRetries',
      String(limits.checkRetries),
      'Attempts to make the repo checks pass before the task is Blocked',
    ],
    ['ciFixRounds', String(limits.ciFixRounds), 'Rounds of fixing a failing CI run on an open PR'],
    ['reviewRounds', String(limits.reviewRounds), 'Rounds of addressing review comments'],
    ['taskTimeout', `${limits.taskTimeoutMinutes} min`, 'Wall-clock limit for one task'],
    ['maxTurnsPerRun', String(limits.maxTurnsPerRun), 'Agent turns allowed in one run'],
    [
      'maxBudgetUsdPerRun',
      `notional ${usd(limits.maxBudgetUsdPerRun)}`,
      'Notional spend cap for one run',
    ],
    [
      'dailyBudgetTokens',
      limits.dailyBudgetTokens.toLocaleString('en-US'),
      'Tokens per day, all kinds together; new runs wait when it is reached',
    ],
    [
      'permissionTimeout',
      `${limits.permissionTimeoutMinutes} min`,
      'How long a permission request waits for you',
    ],
    [
      'stallMinutes',
      `${limits.stallMinutes} min`,
      'Silence after which a session is marked stalled',
    ],
    ['watcherPollInterval', `${watch.pollSeconds} s`, 'How often open PRs are checked'],
    ['model · dispatcher', models.dispatcher, 'Model for the dispatcher'],
    ['model · worker', models.worker, 'Model for workers'],
    ['model · reviewer', models.reviewer, 'Model for the reviewer'],
  ];
}

function ProfileFile({ label, file }: { label: string; file: ValidConfig['profile']['soul'] }) {
  return (
    <div>
      <h3 className={styles.sectionTitle}>{label}</h3>
      <p className={styles.muted}>
        <span className={styles.mono}>{file.path}</span>
        {file.modifiedAt ? (
          <>
            {' · modified '}
            <RelativeTime at={file.modifiedAt} />
          </>
        ) : null}
      </p>
      {file.content === null ? (
        <p className={styles.warning}>File not found.</p>
      ) : (
        <div className={styles.profile}>
          <Markdown>{file.content}</Markdown>
        </div>
      )}
    </div>
  );
}

function StringList({ items, empty }: { items: string[]; empty: string }) {
  return items.length === 0 ? (
    <p className={styles.muted}>{empty}</p>
  ) : (
    <ul className={styles.list}>
      {items.map((item) => (
        <li key={item} className={styles.mono}>
          {item}
        </li>
      ))}
    </ul>
  );
}

function ValidConfigView({ data }: { data: ValidConfig }) {
  const { config, usage, repository, profile } = data;
  return (
    <>
      <Section id="cfg-usage" title="Usage">
        <UsageMeter usage={usage} variant="full" />
        <h3 className={styles.sectionTitle}>By role</h3>
        <ul className={styles.list}>
          {Object.entries(usage.byRole).map(([role, cost]) => (
            <li key={role}>
              {role}: notional {usd(cost)}
            </li>
          ))}
        </ul>
        <h3 className={styles.sectionTitle}>By task</h3>
        {usage.byTask.length === 0 ? (
          <p className={styles.muted}>No spend today.</p>
        ) : (
          <ul className={styles.list}>
            {usage.byTask.map((item) => (
              <li key={item.taskId}>
                {item.taskId}: notional {usd(item.costUsd)}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section id="cfg-limits" title="Limits">
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Parameter</th>
              <th scope="col">Value</th>
              <th scope="col">Meaning</th>
            </tr>
          </thead>
          <tbody>
            {limitRows(config).map(([name, value, meaning]) => (
              <tr key={name}>
                <th scope="row" className={styles.mono}>
                  {name}
                </th>
                <td>{value}</td>
                <td>{meaning}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className={styles.muted}>
          Config file <span className={styles.mono}>{data.path}</span> · last read{' '}
          <RelativeTime at={data.loadedAt} />. Values change in the file; this page is read-only.
        </p>
      </Section>

      <Section id="cfg-repo" title="Repository">
        <dl>
          <dt>Repository</dt>
          <dd className={styles.mono}>{config.repo.path}</dd>
          <dt>Base branch</dt>
          <dd className={styles.mono}>{config.repo.baseBranch}</dd>
          <dt>Check commands</dt>
          <dd>
            <StringList items={repository.checkCommands} empty="None found in AGENTS.md" />
          </dd>
          <dt>Dev command</dt>
          <dd className={styles.mono}>{repository.devCommand ?? 'None found in AGENTS.md'}</dd>
        </dl>
        {repository.warning ? (
          <p role="alert" className={styles.warning}>
            {repository.warning}
          </p>
        ) : null}
      </Section>

      <Section id="cfg-profile" title="Profile">
        <ProfileFile label="SOUL.md" file={profile.soul} />
        <ProfileFile label="USER.md" file={profile.user} />
      </Section>

      <Section id="cfg-allow" title="Allowlists">
        <h3 className={styles.sectionTitle}>GitHub reviewers whose comments are handled</h3>
        <StringList items={config.allowlist.githubReviewers} empty="No reviewers allowed" />
        <h3 className={styles.sectionTitle}>Commands allowed without asking</h3>
        <StringList items={config.allowlist.autoAllowedCommands} empty="No commands allowed" />
      </Section>
    </>
  );
}

export function ConfigPage() {
  const { data, error, isPending, refetch } = useConfig();

  if (isPending) return <Loading label="Loading config…" />;
  if (error) {
    return (
      <ErrorBlock error={error} title="Could not load the config" onRetry={() => void refetch()} />
    );
  }

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Config &amp; limits</h1>
      {data.valid ? (
        <ValidConfigView data={data} />
      ) : (
        <section className={styles.section} aria-labelledby="cfg-invalid">
          <h2 id="cfg-invalid" className={styles.sectionTitle}>
            Config is invalid
          </h2>
          <p className={styles.muted}>
            File <span className={styles.mono}>{data.path}</span>
          </p>
          <ul className={styles.errors} aria-label="Config errors">
            {data.errors
              .flatMap((entry) => entry.split('\n'))
              .map((line) => (
                <li key={line}>{line}</li>
              ))}
          </ul>
          <p role="alert" className={styles.warning}>
            Tasks do not start until the config is fixed.
          </p>
        </section>
      )}
    </div>
  );
}
