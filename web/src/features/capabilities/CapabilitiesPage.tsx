import { useState } from 'react';
import type { CapabilityItem, CapabilityKind, McpServerItem } from '@jarvis/shared';
import {
  useCanMutate,
  useCapabilities,
  useDeleteOwnerCapability,
  useOwnerCapability,
} from '../../api/queries';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EmptyState } from '../../components/EmptyState';
import { ErrorBlock } from '../../components/ErrorBlock';
import { Loading } from '../../components/Loading';
import { CapabilityForm } from './CapabilityForm';
import styles from './Capabilities.module.css';

type FormState = { kind: CapabilityKind; name?: string } | null;

function SourceBadge({ item }: { item: CapabilityItem }) {
  const label =
    item.source === 'builtin'
      ? 'Built-in'
      : item.source === 'owner'
        ? 'Yours'
        : `Repo ${item.repo}`;
  return <span className={`${styles.badge} ${styles[item.source]}`}>{label}</span>;
}

function CapabilityRow({
  item,
  isAgent,
  onEdit,
  onDelete,
}: {
  item: CapabilityItem;
  isAgent: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const canMutate = useCanMutate();
  return (
    <li className={styles.row} aria-label={item.name}>
      <div className={styles.rowMain}>
        <h3 className={styles.name}>
          {item.name} <SourceBadge item={item} />
        </h3>
        <p className={styles.description}>{item.description || 'No description.'}</p>
        {isAgent ? (
          <p className={styles.meta}>
            Model: {item.model ?? 'inherit'} · Tools: {item.tools?.join(', ') ?? 'all'}
          </p>
        ) : null}
      </div>
      {item.editable ? (
        <div className={styles.rowActions}>
          <button type="button" className={styles.button} disabled={!canMutate} onClick={onEdit}>
            Edit<span className="visually-hidden"> {item.name}</span>
          </button>
          <button
            type="button"
            className={`${styles.button} ${styles.danger}`}
            disabled={!canMutate}
            onClick={onDelete}
          >
            Delete<span className="visually-hidden"> {item.name}</span>
          </button>
        </div>
      ) : null}
    </li>
  );
}

function McpRow({ server }: { server: McpServerItem }) {
  return (
    <li className={styles.row} aria-label={server.name}>
      <div className={styles.rowMain}>
        <h3 className={styles.name}>
          {server.name}{' '}
          <span
            className={`${styles.badge} ${server.source === 'builtin' ? styles.builtin : styles.repo}`}
          >
            {server.source === 'builtin' ? 'Built-in' : 'Connector'}
          </span>
        </h3>
        <p className={styles.meta}>
          Roles: {server.roles.join(', ')} · Transport: {server.transport}
        </p>
        {server.command ? (
          <p className={styles.meta}>
            <code>{[server.command, ...(server.args ?? [])].join(' ')}</code>
          </p>
        ) : null}
        {server.url ? (
          <p className={styles.meta}>
            <code>{server.url}</code>
          </p>
        ) : null}
        <p className={styles.meta}>
          Environment variables: {server.envVars.length > 0 ? server.envVars.join(', ') : 'none'}
        </p>
      </div>
    </li>
  );
}

/** Opens the editor once the full item has loaded. */
function EditForm({
  kind,
  name,
  onDone,
}: {
  kind: CapabilityKind;
  name: string;
  onDone: () => void;
}) {
  const doc = useOwnerCapability(kind, name);
  if (doc.isPending) return <Loading label="Loading…" />;
  if (doc.error)
    return (
      <ErrorBlock error={doc.error} title="Could not load it" onRetry={() => void doc.refetch()} />
    );
  return <CapabilityForm kind={kind} initial={doc.data} onDone={onDone} />;
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className={styles.section} aria-label={title}>
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function CapabilitiesPage() {
  const { data, error, isPending, refetch } = useCapabilities();
  const canMutate = useCanMutate();
  const [form, setForm] = useState<FormState>(null);
  const [pending, setPending] = useState<{ kind: CapabilityKind; name: string } | null>(null);
  const removeSkill = useDeleteOwnerCapability('skills');
  const removeAgent = useDeleteOwnerCapability('agents');

  if (isPending) return <Loading label="Loading capabilities…" />;
  if (error) {
    return (
      <ErrorBlock
        error={error}
        title="Could not load capabilities"
        onRetry={() => void refetch()}
      />
    );
  }

  const newButton = (kind: CapabilityKind, label: string) => (
    <button
      type="button"
      className={`${styles.button} ${styles.primary}`}
      disabled={!canMutate}
      onClick={() => setForm({ kind })}
    >
      {label}
    </button>
  );

  function list(kind: CapabilityKind, items: CapabilityItem[]) {
    if (items.length === 0) {
      return <EmptyState title={`No ${kind === 'skills' ? 'skills' : 'subagents'} yet`} />;
    }
    return (
      <ul className={styles.list}>
        {items.map((item) => (
          <CapabilityRow
            key={`${item.source}:${item.repo ?? ''}:${item.name}`}
            item={item}
            isAgent={kind === 'agents'}
            onEdit={() => setForm({ kind, name: item.name })}
            onDelete={() => setPending({ kind, name: item.name })}
          />
        ))}
      </ul>
    );
  }

  const deleting = pending === null ? null : pending.kind === 'skills' ? removeSkill : removeAgent;

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Capabilities</h1>
      <p className={styles.intro}>
        What a run can use. Built-in and repository items change through git; yours live in{' '}
        <code>~/.jarvis/plugin</code> and apply from the next run.
      </p>

      {form ? (
        form.name === undefined ? (
          <CapabilityForm kind={form.kind} onDone={() => setForm(null)} />
        ) : (
          <EditForm kind={form.kind} name={form.name} onDone={() => setForm(null)} />
        )
      ) : null}

      <Section title="Skills" action={newButton('skills', 'New skill')}>
        {list('skills', data.skills)}
      </Section>
      <Section title="Subagents" action={newButton('agents', 'New subagent')}>
        {list('agents', data.agents)}
      </Section>
      <Section title="MCP servers">
        {data.mcpServers.length === 0 ? (
          <EmptyState title="No MCP servers" />
        ) : (
          <ul className={styles.list}>
            {data.mcpServers.map((server) => (
              <McpRow key={server.name} server={server} />
            ))}
          </ul>
        )}
        <p className={styles.hint}>
          Read-only: edit <code>~/.jarvis/mcp/servers.json</code>. Values of variables are never
          shown.
        </p>
      </Section>

      <ConfirmDialog
        open={pending !== null}
        title={`Delete ${pending?.kind === 'agents' ? 'subagent' : 'skill'} ${pending?.name ?? ''}?`}
        description="A copy is kept in ~/.jarvis/plugin-backups."
        confirmLabel="Delete"
        destructive
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (pending === null || deleting === null) return;
          deleting.mutate(pending.name, { onSettled: () => setPending(null) });
        }}
      />
      {deleting?.error ? <ErrorBlock error={deleting.error} title="Could not delete it" /> : null}
    </div>
  );
}
