import { useState, type FormEvent } from 'react';
import {
  CAPABILITY_DESCRIPTION_MAX,
  CAPABILITY_MODELS,
  type CapabilityKind,
  type OwnerCapabilityDoc,
} from '@jarvis/shared';
import { ApiError, useCanMutate, useSaveOwnerCapability } from '../../api/queries';
import styles from './Capabilities.module.css';

interface CapabilityFormProps {
  kind: CapabilityKind;
  /** The item being edited; undefined creates a new one. */
  initial?: OwnerCapabilityDoc;
  onDone: () => void;
}

type FieldErrors = Record<string, string>;

const FIELD_OF_PATH: Record<string, string> = {
  name: 'name',
  description: 'description',
  body: 'body',
  model: 'model',
  tools: 'tools',
};

/** Splits the engine's error into per-field messages; anything unplaced goes to the form. */
function errorsOf(error: unknown): { fields: FieldErrors; general: string | null } {
  if (!(error instanceof ApiError)) {
    return { fields: {}, general: error instanceof Error ? error.message : 'Could not save.' };
  }
  const fields: FieldErrors = {};
  if (Array.isArray(error.details)) {
    for (const detail of error.details as { path?: unknown; message?: unknown }[]) {
      const root = String(detail.path ?? '').split('.')[0] ?? '';
      const field = FIELD_OF_PATH[root];
      if (field !== undefined && fields[field] === undefined)
        fields[field] = String(detail.message);
    }
  }
  if (Object.keys(fields).length > 0) return { fields, general: null };
  // "built-in" refusals are about the name; the rest is shown on the form.
  if (/built-in/.test(error.message)) return { fields: { name: error.message }, general: null };
  return { fields: {}, general: error.message };
}

export function CapabilityForm({ kind, initial, onDone }: CapabilityFormProps) {
  const isAgent = kind === 'agents';
  const noun = isAgent ? 'subagent' : 'skill';
  const editing = initial !== undefined;
  const canMutate = useCanMutate();
  const save = useSaveOwnerCapability(kind);

  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [model, setModel] = useState(initial?.model ?? '');
  const [tools, setTools] = useState((initial?.tools ?? []).join(', '));
  const [body, setBody] = useState(initial?.body ?? '');
  const { fields, general } = save.error
    ? errorsOf(save.error)
    : { fields: {} as FieldErrors, general: null };

  function submit(event: FormEvent) {
    event.preventDefault();
    const toolList = tools
      .split(',')
      .map((tool) => tool.trim())
      .filter((tool) => tool !== '');
    save.mutate(
      {
        name: name.trim(),
        body: isAgent
          ? {
              description,
              body,
              ...(toolList.length > 0 ? { tools: toolList } : {}),
              ...(model === '' ? {} : { model: model as (typeof CAPABILITY_MODELS)[number] }),
            }
          : { description, body },
      },
      { onSuccess: onDone },
    );
  }

  const error = (field: string) =>
    fields[field] === undefined ? null : (
      <p id={`cap-${field}-error`} className={styles.fieldError} role="alert">
        {fields[field]}
      </p>
    );
  const invalid = (field: string) => (fields[field] === undefined ? undefined : true);
  const describedBy = (field: string) =>
    fields[field] === undefined ? undefined : `cap-${field}-error`;

  return (
    <form
      className={styles.form}
      onSubmit={submit}
      aria-label={`${editing ? 'Edit' : 'New'} ${noun}`}
    >
      <h2 className={styles.formTitle}>
        {editing ? `Edit ${noun} ${initial.name}` : `New ${noun}`}
      </h2>

      <label className={styles.field}>
        <span>Name</span>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          readOnly={editing}
          required
          maxLength={64}
          placeholder="release-notes"
          aria-invalid={invalid('name')}
          aria-describedby={describedBy('name')}
        />
      </label>
      {error('name')}

      <label className={styles.field}>
        <span>Description</span>
        <input
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          required
          maxLength={CAPABILITY_DESCRIPTION_MAX}
          aria-invalid={invalid('description')}
          aria-describedby={describedBy('description')}
        />
      </label>
      <p className={styles.hint}>
        One line: when the agent should use it. This is what the model reads to decide.
      </p>
      {error('description')}

      {isAgent ? (
        <>
          <label className={styles.field}>
            <span>Model</span>
            <select
              value={model}
              onChange={(event) => setModel(event.target.value)}
              aria-invalid={invalid('model')}
              aria-describedby={describedBy('model')}
            >
              <option value="">Inherit</option>
              {CAPABILITY_MODELS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          {error('model')}

          <label className={styles.field}>
            <span>Tools</span>
            <input
              value={tools}
              onChange={(event) => setTools(event.target.value)}
              placeholder="Read, Glob, Grep"
              aria-invalid={invalid('tools')}
              aria-describedby={describedBy('tools')}
            />
          </label>
          <p className={styles.hint}>Comma-separated. Empty means all tools.</p>
          {error('tools')}
        </>
      ) : null}

      <label className={styles.field}>
        <span>Instructions (markdown)</span>
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={12}
          aria-invalid={invalid('body')}
          aria-describedby={describedBy('body')}
        />
      </label>
      {error('body')}

      {general ? (
        <p className={styles.fieldError} role="alert">
          {general}
        </p>
      ) : null}

      <div className={styles.formActions}>
        <button type="button" className={styles.button} onClick={onDone}>
          Cancel
        </button>
        <button
          type="submit"
          className={`${styles.button} ${styles.primary}`}
          disabled={!canMutate || save.isPending}
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}
