import type { RunEvent } from '@jarvis/shared';
import type {
  Message,
  PermissionRequest,
  Run,
  Task,
  TaskEvent,
  Thread,
} from '../../domain/index.js';
import type { Session } from '../ports/session-repository.js';
import type { Watch } from '../ports/watch-repository.js';

/** The rows the fake repositories read and write. Plain data, so a snapshot is a structured clone. */
export interface Tables {
  threads: Map<string, Thread>;
  messages: Map<string, Message>;
  tasks: Map<string, Task>;
  journal: TaskEvent[];
  sessions: Map<string, Session>;
  runs: Map<string, Run>;
  /** Run events by run id, in `seq` order. */
  runEvents: Map<string, RunEvent[]>;
  permissions: Map<string, PermissionRequest>;
  watches: Map<string, Watch>;
  /** Reset moments, oldest first. */
  budgetResets: string[];
}

function emptyTables(): Tables {
  return {
    threads: new Map(),
    messages: new Map(),
    tasks: new Map(),
    journal: [],
    sessions: new Map(),
    runs: new Map(),
    runEvents: new Map(),
    permissions: new Map(),
    watches: new Map(),
    budgetResets: [],
  };
}

export class InMemoryDatabase {
  tables: Tables = emptyTables();
  /** Like a Postgres sequence: survives a rollback, so ids are never reused. */
  private taskSequence = 0;

  nextTaskId(): string {
    this.taskSequence += 1;
    return `T-${this.taskSequence}`;
  }

  snapshot(): Tables {
    return structuredClone(this.tables);
  }

  restore(snapshot: Tables): void {
    this.tables = snapshot;
  }
}
