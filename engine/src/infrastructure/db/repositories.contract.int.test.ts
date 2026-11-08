// One set of scenarios, run against the in-memory fakes and against Postgres, so the two cannot drift apart.
import { describe, expect, it } from 'vitest';
import type { RunEventBody } from '../../application/ports/agent-runner.js';
import type { Watch } from '../../application/ports/watch-repository.js';
import type { Repositories } from '../../application/ports/unit-of-work.js';
import { InMemoryDatabase } from '../../application/testing/in-memory-database.js';
import { inMemoryRepositories } from '../../application/testing/in-memory-repositories.js';
import {
  createTask,
  createThread,
  requestPermission,
  startRun,
  taskEvent,
  transition,
  type Message,
  type Run,
  type Task,
} from '../../domain/index.js';
import { useTestDatabase } from '../../../test/db.js';

/** A minute offset from a fixed start, as the ISO string the domain uses. */
const at = (minutes: number): string => new Date(Date.UTC(2026, 0, 1, 0, minutes)).toISOString();

const THREAD = 'th-1';

async function seedThread(repos: Repositories, id = THREAD): Promise<void> {
  await repos.threads.save(createThread({ id, title: `Thread ${id}`, at: at(0) }));
}

async function seedTask(
  repos: Repositories,
  id: string,
  patch: Partial<Task> = {},
  threadId = THREAD,
): Promise<Task> {
  const task = {
    ...createTask({ id, threadId, title: id, branch: `jarvis/${id}`, at: at(0) }),
    ...patch,
  };
  await repos.tasks.save(task);
  return task;
}

function message(id: string, patch: Partial<Message> = {}): Message {
  return {
    id,
    threadId: THREAD,
    taskId: null,
    kind: 'jarvis',
    body: { text: id },
    at: at(0),
    answer: null,
    answeredAt: null,
    ...patch,
  };
}

async function seedRun(repos: Repositories, id: string, patch: Partial<Run> = {}): Promise<Run> {
  const sessionId = `s-${id}`;
  await repos.sessions.save({
    id: sessionId,
    role: 'worker',
    threadId: THREAD,
    taskId: null,
    claudeSessionId: null,
  });
  const run = {
    ...startRun({ id, sessionId, role: 'worker', threadId: THREAD, taskId: null, at: at(0) }),
    ...patch,
  };
  await repos.runs.save(run);
  return run;
}

const text = (value: string): RunEventBody => ({ kind: 'text', payload: { text: value } });

function contract(name: string, make: () => Repositories): void {
  describe(`repositories (${name})`, () => {
    describe('threads', () => {
      it('returns null for an unknown id, stores and updates a thread', async () => {
        const repos = make();
        expect(await repos.threads.get('nope')).toBeNull();
        const thread = createThread({ id: 'th-1', title: 'First', at: at(0) });
        await repos.threads.save(thread);
        expect(await repos.threads.get('th-1')).toEqual(thread);
        const touched = { ...thread, title: 'Renamed', updatedAt: at(5) };
        await repos.threads.save(touched);
        expect(await repos.threads.get('th-1')).toEqual(touched);
      });

      it('lists threads most recently active first, ties by id', async () => {
        const repos = make();
        expect(await repos.threads.list()).toEqual([]);
        const thread = (id: string, minutes: number) =>
          createThread({ id, title: id, at: at(minutes) });
        await repos.threads.save(thread('th-b', 5));
        await repos.threads.save(thread('th-new', 9));
        await repos.threads.save(thread('th-a', 5));
        await repos.threads.save(thread('th-old', 1));

        expect((await repos.threads.list()).map((t) => t.id)).toEqual([
          'th-new',
          'th-a',
          'th-b',
          'th-old',
        ]);
      });
    });

    describe('tasks', () => {
      it('hands out sequential T-<n> ids', async () => {
        const repos = make();
        expect([
          await repos.tasks.nextId(),
          await repos.tasks.nextId(),
          await repos.tasks.nextId(),
        ]).toEqual(['T-1', 'T-2', 'T-3']);
      });

      it('round-trips every field and updates in place', async () => {
        const repos = make();
        await seedThread(repos);
        const task = await seedTask(repos, 'T-1', {
          pr: { number: 7, url: 'https://github.com/o/r/pull/7' },
          counters: { checkRetries: 1, ciFixRounds: 2, reviewRounds: 3 },
          workerSessionId: 'sess-1',
          reason: 'because',
          targetRepo: { owner: 'owner', name: 'name' },
        });
        expect(await repos.tasks.get('T-1')).toEqual(task);
        expect(await repos.tasks.get('T-9')).toBeNull();

        const { task: moved } = transition(task, 'Context', { cause: 'worker_started', at: at(3) });
        await repos.tasks.save(moved);
        expect(await repos.tasks.get('T-1')).toEqual(moved);
      });

      it('finds the non-terminal task of a thread and lists active tasks oldest first', async () => {
        const repos = make();
        await seedThread(repos);
        await seedThread(repos, 'th-2');
        await seedTask(repos, 'T-1', { stage: 'Done', startedAt: at(1) });
        await seedTask(repos, 'T-2', { stage: 'Implementing', startedAt: at(30) });
        await seedTask(
          repos,
          'T-3',
          { stage: 'Blocked', resumeStage: 'Context', startedAt: at(10) },
          'th-2',
        );
        await seedTask(repos, 'T-4', { stage: 'Cancelled', startedAt: at(2) }, 'th-2');

        expect((await repos.tasks.activeForThread(THREAD))?.id).toBe('T-2');
        expect((await repos.tasks.activeForThread('th-2'))?.id).toBe('T-3');
        expect(await repos.tasks.activeForThread('th-3')).toBeNull();
        expect((await repos.tasks.listActive()).map((t) => t.id)).toEqual(['T-3', 'T-2']);
      });

      it('lists every task, finished ones too, and the tasks of one thread, oldest first', async () => {
        const repos = make();
        await seedThread(repos);
        await seedThread(repos, 'th-2');
        await seedTask(repos, 'T-1', { stage: 'Done', startedAt: at(30) });
        await seedTask(repos, 'T-2', { stage: 'Implementing', startedAt: at(10) });
        await seedTask(repos, 'T-3', { stage: 'Cancelled', startedAt: at(20) }, 'th-2');

        expect((await repos.tasks.listAll()).map((t) => t.id)).toEqual(['T-2', 'T-3', 'T-1']);
        expect((await repos.tasks.listByThread(THREAD)).map((t) => t.id)).toEqual(['T-2', 'T-1']);
        expect((await repos.tasks.listByThread('th-2')).map((t) => t.id)).toEqual(['T-3']);
        expect(await repos.tasks.listByThread('th-9')).toEqual([]);
      });
    });

    describe('messages', () => {
      it('stores, reads and updates a message (answer, delivery)', async () => {
        const repos = make();
        await seedThread(repos);
        await seedTask(repos, 'T-1');
        const card = message('m-1', {
          kind: 'question',
          taskId: 'T-1',
          body: { question: 'Which?' },
        });
        await repos.messages.add(card);
        expect(await repos.messages.get('m-1')).toEqual(card);
        expect(await repos.messages.get('nope')).toBeNull();

        const answered = { ...card, answer: { text: 'This one' }, answeredAt: at(4) };
        await repos.messages.save(answered);
        expect(await repos.messages.get('m-1')).toEqual(answered);
      });

      it('finds the status card and the permission card', async () => {
        const repos = make();
        await seedThread(repos);
        await seedTask(repos, 'T-1');
        await seedTask(repos, 'T-2');
        await repos.messages.add(message('m-1', { kind: 'status', taskId: 'T-1' }));
        await repos.messages.add(message('m-2', { kind: 'status', taskId: 'T-2' }));
        await repos.messages.add(
          message('m-3', { kind: 'permission', taskId: 'T-1', body: { permissionId: 'p-1' } }),
        );
        await repos.messages.add(
          message('m-4', { kind: 'permission', taskId: 'T-1', body: { permissionId: 'p-2' } }),
        );

        expect((await repos.messages.statusCardOf('T-1'))?.id).toBe('m-1');
        expect(await repos.messages.statusCardOf('T-3')).toBeNull();
        expect((await repos.messages.permissionCardOf('p-2'))?.id).toBe('m-4');
        expect(await repos.messages.permissionCardOf('p-9')).toBeNull();
      });

      it('lists unanswered cards of a task, oldest first', async () => {
        const repos = make();
        await seedThread(repos);
        await seedTask(repos, 'T-1');
        await seedTask(repos, 'T-2');
        await repos.messages.add(message('late', { kind: 'decision', taskId: 'T-1', at: at(9) }));
        await repos.messages.add(message('early', { kind: 'question', taskId: 'T-1', at: at(2) }));
        await repos.messages.add(
          message('done', {
            kind: 'decision',
            taskId: 'T-1',
            at: at(1),
            answer: {},
            answeredAt: at(3),
          }),
        );
        await repos.messages.add(message('plain', { kind: 'jarvis', taskId: 'T-1', at: at(1) }));
        await repos.messages.add(message('other', { kind: 'decision', taskId: 'T-2', at: at(1) }));

        expect((await repos.messages.openCards('T-1')).map((m) => m.id)).toEqual(['early', 'late']);
      });

      it('returns queued owner input for a worker and for a dispatcher, oldest first', async () => {
        const repos = make();
        await seedThread(repos);
        await seedThread(repos, 'th-2');
        await seedTask(repos, 'T-1');
        const owner = (id: string, minutes: number, patch: Partial<Message> = {}): Message =>
          message(id, {
            kind: 'owner',
            at: at(minutes),
            body: { text: id, delivery: 'queued' },
            ...patch,
          });
        await repos.messages.add(owner('w2', 8, { taskId: 'T-1' }));
        await repos.messages.add(owner('w1', 3, { taskId: 'T-1' }));
        await repos.messages.add(
          owner('w-delivered', 2, { taskId: 'T-1', body: { text: 'x', delivery: 'delivered' } }),
        );
        await repos.messages.add(owner('w-jarvis', 1, { taskId: 'T-1', kind: 'jarvis' }));
        await repos.messages.add(owner('d2', 7));
        await repos.messages.add(owner('d1', 5));
        await repos.messages.add(
          owner('d-delivered', 4, { body: { text: 'x', delivery: 'delivered' } }),
        );
        await repos.messages.add(owner('d-other-thread', 6, { threadId: 'th-2' }));

        expect((await repos.messages.queuedWorkerInput('T-1')).map((m) => m.id)).toEqual([
          'w1',
          'w2',
        ]);
        expect((await repos.messages.queuedDispatcherInput(THREAD)).map((m) => m.id)).toEqual([
          'd1',
          'd2',
        ]);
        expect((await repos.messages.queuedDispatcherInput('th-2')).map((m) => m.id)).toEqual([
          'd-other-thread',
        ]);
        expect(await repos.messages.threadsWithQueuedDispatcherInput()).toEqual([THREAD, 'th-2']);
      });

      it('lists the messages of one thread oldest first', async () => {
        const repos = make();
        await seedThread(repos);
        await seedThread(repos, 'th-2');
        await repos.messages.add(message('late', { at: at(9) }));
        await repos.messages.add(message('early', { at: at(1) }));
        await repos.messages.add(message('elsewhere', { threadId: 'th-2', at: at(5) }));

        expect((await repos.messages.listByThread(THREAD)).map((m) => m.id)).toEqual([
          'early',
          'late',
        ]);
        expect(await repos.messages.listByThread('th-9')).toEqual([]);
      });

      it('finds the threads that have an unanswered card, with or without a task', async () => {
        const repos = make();
        for (const id of ['th-1', 'th-2', 'th-3', 'th-4']) await seedThread(repos, id);
        await seedTask(repos, 'T-1', {}, 'th-1');
        await repos.messages.add(
          message('c1', { kind: 'decision', taskId: 'T-1', threadId: 'th-1', at: at(7) }),
        );
        await repos.messages.add(
          message('c2', { kind: 'permission', threadId: 'th-2', at: at(3) }),
        );
        await repos.messages.add(
          message('answered', {
            kind: 'question',
            threadId: 'th-3',
            answer: {},
            answeredAt: at(4),
          }),
        );
        await repos.messages.add(message('plain', { kind: 'jarvis', threadId: 'th-4' }));

        expect(await repos.messages.threadsWithOpenCards()).toEqual(['th-2', 'th-1']);
      });
    });

    describe('journal', () => {
      it('lists the events of one task in the order they were appended', async () => {
        const repos = make();
        await seedThread(repos);
        await seedTask(repos, 'T-1');
        await seedTask(repos, 'T-2');
        const first = taskEvent('T-1', 'task_created', at(0), 'agent', { title: 'x' });
        const second = taskEvent('T-1', 'stage_changed', at(1), 'system', {
          from: 'Intake',
          to: 'Context',
        });
        await repos.journal.append(first);
        await repos.journal.append(taskEvent('T-2', 'note', at(1), 'owner'));
        await repos.journal.append(second);
        expect(await repos.journal.list('T-1')).toEqual([first, second]);
        expect(await repos.journal.list('T-9')).toEqual([]);
      });

      it('numbers rows with a growing seq, per task oldest first and across tasks newest first', async () => {
        const repos = make();
        await seedThread(repos);
        await seedTask(repos, 'T-1');
        await seedTask(repos, 'T-2');
        const a = taskEvent('T-1', 'task_created', at(0), 'agent', { title: 'x' });
        const b = taskEvent('T-2', 'note', at(1), 'owner');
        const c = taskEvent('T-1', 'stage_changed', at(2), 'system', { to: 'Context' });
        for (const event of [a, b, c]) await repos.journal.append(event);

        const own = await repos.journal.entries('T-1');
        expect(own).toMatchObject([a, c]);
        expect(own[0]?.seq).toBeLessThan(own[1]?.seq ?? 0);

        const recent = await repos.journal.recent(2);
        expect(recent).toMatchObject([c, b]);
        expect(recent[0]?.seq).toBe(own[1]?.seq);
        expect(recent[0]?.seq).toBeGreaterThan(recent[1]?.seq ?? Infinity);
        expect(await repos.journal.recent(10)).toHaveLength(3);
        expect(await repos.journal.entries('T-9')).toEqual([]);
      });
    });

    describe('sessions', () => {
      it('stores a session, updates the CLI session id and finds the dispatcher of a thread', async () => {
        const repos = make();
        await seedThread(repos);
        await seedTask(repos, 'T-1');
        const worker = {
          id: 's-w',
          role: 'worker',
          threadId: THREAD,
          taskId: 'T-1',
          claudeSessionId: null,
        } as const;
        const dispatcher = {
          id: 's-d',
          role: 'dispatcher',
          threadId: THREAD,
          taskId: null,
          claudeSessionId: null,
        } as const;
        await repos.sessions.save(worker);
        expect(await repos.sessions.dispatcherOf(THREAD)).toBeNull();
        await repos.sessions.save(dispatcher);
        expect(await repos.sessions.dispatcherOf(THREAD)).toEqual(dispatcher);
        expect(await repos.sessions.dispatcherOf('th-2')).toBeNull();

        await repos.sessions.save({ ...dispatcher, claudeSessionId: 'claude-123' });
        expect((await repos.sessions.get('s-d'))?.claudeSessionId).toBe('claude-123');
        expect(await repos.sessions.get('nope')).toBeNull();
        expect(await repos.sessions.get('s-w')).toEqual(worker);
      });
    });

    describe('runs', () => {
      it('round-trips a run with usage and an exit code', async () => {
        const repos = make();
        await seedThread(repos);
        const run = await seedRun(repos, 'r-1', {
          status: 'failed',
          finishedAt: at(9),
          costUsd: 0.42,
          turns: 5,
          usage: { input: 10, output: 20, cacheRead: 3_000_000_000, cacheWrite: 40 },
          stopReason: 'error',
          modelUsage: {
            'claude-opus': {
              input: 10,
              output: 20,
              cacheRead: 3_000_000_000,
              cacheWrite: 40,
              costUsd: 0.42,
            },
          },
          exitCode: 1,
          error: 'boom',
        });
        expect(await repos.runs.get('r-1')).toEqual(run);
        expect(await repos.runs.get('nope')).toBeNull();
      });

      it('knows whether a dispatcher run is going and lists running runs', async () => {
        const repos = make();
        await seedThread(repos);
        await seedThread(repos, 'th-2');
        expect(await repos.runs.dispatcherBusy(THREAD)).toBe(false);
        await seedRun(repos, 'r-w', { role: 'worker' });
        expect(await repos.runs.dispatcherBusy(THREAD)).toBe(false);
        await seedRun(repos, 'r-d', { role: 'dispatcher' });
        expect(await repos.runs.dispatcherBusy(THREAD)).toBe(true);
        expect(await repos.runs.dispatcherBusy('th-2')).toBe(false);
        await seedRun(repos, 'r-done', { status: 'completed' });

        expect((await repos.runs.listRunning()).map((r) => r.id).sort()).toEqual(['r-d', 'r-w']);
        const done = await repos.runs.get('r-d');
        await repos.runs.save({ ...done!, status: 'completed', finishedAt: at(2) });
        expect(await repos.runs.dispatcherBusy(THREAD)).toBe(false);
      });

      it('lists the runs of a task oldest first', async () => {
        const repos = make();
        await seedThread(repos);
        await seedTask(repos, 'T-1');
        await seedRun(repos, 'r-b', { taskId: 'T-1', startedAt: at(20) });
        await seedRun(repos, 'r-a', { taskId: 'T-1', startedAt: at(10) });
        await seedRun(repos, 'r-x', { taskId: null, startedAt: at(1) });
        expect((await repos.runs.listByTask('T-1')).map((r) => r.id)).toEqual(['r-a', 'r-b']);
      });

      it('lists the runs of a session oldest first and finds the newest run of a role', async () => {
        const repos = make();
        await seedThread(repos);
        expect(await repos.runs.latestOfRole('worker')).toBeNull();
        await seedRun(repos, 'r-late', { startedAt: at(20), role: 'dispatcher' });
        await seedRun(repos, 'r-early', { startedAt: at(5), role: 'worker' });
        await repos.runs.save({
          ...startRun({
            id: 'r-again',
            sessionId: 's-r-early',
            role: 'worker',
            threadId: THREAD,
            taskId: null,
            at: at(30),
          }),
        });

        expect((await repos.runs.listBySession('s-r-early')).map((r) => r.id)).toEqual([
          'r-early',
          'r-again',
        ]);
        expect(await repos.runs.listBySession('nope')).toEqual([]);
        expect((await repos.runs.latestOfRole('worker'))?.id).toBe('r-again');
        expect((await repos.runs.latestOfRole('dispatcher'))?.id).toBe('r-late');
      });

      it('totals the runs and cost of every task, leaving out runs without a task', async () => {
        const repos = make();
        await seedThread(repos);
        await seedTask(repos, 'T-1');
        await seedTask(repos, 'T-2');
        await seedRun(repos, 'r-1', { taskId: 'T-1', costUsd: 0.5 });
        await seedRun(repos, 'r-2', { taskId: 'T-1', costUsd: 0.25 });
        await seedRun(repos, 'r-3', { taskId: 'T-2', costUsd: 2 });
        await seedRun(repos, 'r-4', { taskId: null, costUsd: 9 });

        const totals = await repos.runs.totalsByTask();

        expect(new Map(totals)).toEqual(
          new Map([
            ['T-1', { runCount: 2, costUsd: 0.75 }],
            ['T-2', { runCount: 1, costUsd: 2 }],
          ]),
        );
      });

      it('splits the cost since a moment by role (every role present) and by task, dearest first', async () => {
        const repos = make();
        await seedThread(repos);
        await seedTask(repos, 'T-1');
        await seedTask(repos, 'T-2');
        expect(await repos.runs.usageSince(at(0))).toEqual({
          byRole: { dispatcher: 0, worker: 0 },
          byTask: [],
        });
        await seedRun(repos, 'r-old', { taskId: 'T-1', startedAt: at(0), costUsd: 100 });
        await seedRun(repos, 'r-1', { taskId: 'T-1', startedAt: at(10), costUsd: 0.5 });
        await seedRun(repos, 'r-2', { taskId: 'T-2', startedAt: at(11), costUsd: 1.5 });
        await seedRun(repos, 'r-3', { taskId: 'T-1', startedAt: at(12), costUsd: 0.25 });
        await seedRun(repos, 'r-d', { role: 'dispatcher', startedAt: at(13), costUsd: 0.125 });

        expect(await repos.runs.usageSince(at(10))).toEqual({
          byRole: { dispatcher: 0.125, worker: 2.25 },
          byTask: [
            { taskId: 'T-2', costUsd: 1.5 },
            { taskId: 'T-1', costUsd: 0.75 },
          ],
        });
      });

      it('returns the events after a seq in order', async () => {
        const repos = make();
        await seedThread(repos);
        await seedRun(repos, 'r-1');
        await seedRun(repos, 'r-2');
        for (const word of ['a', 'b', 'c']) await repos.runs.appendEvent('r-1', text(word), at(1));
        await repos.runs.appendEvent('r-2', text('other'), at(1));

        const seqs = async (afterSeq?: number) =>
          (await repos.runs.events('r-1', afterSeq)).map((e) => e.seq);
        expect(await seqs()).toEqual([0, 1, 2]);
        expect(await seqs(-1)).toEqual([0, 1, 2]);
        expect(await seqs(0)).toEqual([1, 2]);
        expect(await seqs(2)).toEqual([]);
        expect(await repos.runs.events('r-9')).toEqual([]);
        expect((await repos.runs.events('r-1', 1))[0]).toEqual({
          kind: 'text',
          payload: { text: 'c' },
          seq: 2,
          runId: 'r-1',
          at: at(1),
        });
      });

      describe('usage report', () => {
        const usage = (input: number) => ({
          input,
          output: input * 2,
          cacheRead: 3,
          cacheWrite: 4,
        });
        const WINDOW = { from: '2026-01-01T00:00:00.000Z', to: '2026-01-03T00:00:00.000Z' };

        async function seedReportRuns(repos: Repositories): Promise<void> {
          await seedThread(repos);
          await seedTask(repos, 'T-1');
          await seedTask(repos, 'T-2', { stage: 'Done' });
          for (const id of ['s-a', 's-b']) {
            await repos.sessions.save({
              id,
              role: 'worker',
              threadId: THREAD,
              taskId: null,
              claudeSessionId: null,
            });
          }
          const opus = { 'claude-opus': { ...usage(10), costUsd: 1 } };
          const mixed = {
            'claude-opus': { ...usage(1), costUsd: 0.5 },
            'claude-haiku': { ...usage(2), costUsd: 0.25 },
          };
          // Two sessions, three runs; r-3 starts after UTC midnight and is still running.
          await seedRun(repos, 'r-1', {
            sessionId: 's-a',
            taskId: 'T-1',
            startedAt: '2026-01-01T23:30:00.000Z',
            finishedAt: '2026-01-01T23:31:00.000Z',
            status: 'completed',
            stopReason: 'success',
            costUsd: 1,
            turns: 3,
            usage: usage(10),
            modelUsage: opus,
          });
          await seedRun(repos, 'r-2', {
            sessionId: 's-a',
            taskId: 'T-1',
            startedAt: '2026-01-02T00:30:00.000Z',
            finishedAt: '2026-01-02T00:30:30.000Z',
            status: 'failed',
            stopReason: 'error',
            costUsd: 0.75,
            turns: 2,
            usage: usage(3),
            modelUsage: mixed,
          });
          await seedRun(repos, 'r-3', {
            sessionId: 's-b',
            taskId: 'T-2',
            startedAt: '2026-01-02T12:00:00.000Z',
            costUsd: 0.5,
            turns: 1,
            usage: usage(5),
          });
          // Outside the window: before `from`, and exactly at `to` (excluded).
          await seedRun(repos, 'r-old', { startedAt: '2025-12-31T23:59:59.000Z', costUsd: 100 });
          await seedRun(repos, 'r-edge', { startedAt: WINDOW.to, costUsd: 100 });
        }

        it('groups by session with summed tokens, role, thread and task', async () => {
          const repos = make();
          await seedReportRuns(repos);

          const { rows, total } = await repos.runs.usageReport(WINDOW, 'session');

          expect(rows).toEqual([
            {
              key: 's-a',
              role: 'worker',
              threadId: THREAD,
              taskId: 'T-1',
              runs: 2,
              costUsd: 1.75,
              turns: 5,
              tokens: { input: 13, output: 26, cacheRead: 6, cacheWrite: 8 },
              stopReasons: { success: 1, error: 1 },
              durationMs: 90_000,
            },
            {
              key: 's-b',
              role: 'worker',
              threadId: THREAD,
              taskId: 'T-2',
              runs: 1,
              costUsd: 0.5,
              turns: 1,
              tokens: { input: 5, output: 10, cacheRead: 3, cacheWrite: 4 },
              stopReasons: { running: 1 },
              durationMs: 0,
            },
          ]);
          expect(total).toEqual({
            runs: 3,
            costUsd: 2.25,
            turns: 6,
            tokens: { input: 18, output: 36, cacheRead: 9, cacheWrite: 12 },
            stopReasons: { success: 1, error: 1, running: 1 },
            durationMs: 90_000,
          });
        });

        it('buckets by the UTC day of started_at, oldest day first', async () => {
          const repos = make();
          await seedReportRuns(repos);

          const { rows } = await repos.runs.usageReport(WINDOW, 'day');

          expect(rows.map((r) => [r.key, r.runs, r.costUsd])).toEqual([
            ['2026-01-01', 1, 1],
            ['2026-01-02', 2, 1.25],
          ]);
        });

        it('groups by task with its stage, leaving task-less runs to the total', async () => {
          const repos = make();
          await seedReportRuns(repos);
          await seedRun(repos, 'r-none', { startedAt: '2026-01-02T01:00:00.000Z', costUsd: 7 });

          const { rows, total } = await repos.runs.usageReport(WINDOW, 'task');

          expect(rows.map((r) => [r.key, r.stage, r.costUsd])).toEqual([
            ['T-1', 'Intake', 1.75],
            ['T-2', 'Done', 0.5],
          ]);
          expect(total.runs).toBe(4);
          expect(total.costUsd).toBeCloseTo(9.25);
        });

        it('groups by model from the per-run model_usage, and counts a run once in the total', async () => {
          const repos = make();
          await seedReportRuns(repos);

          const { rows, total } = await repos.runs.usageReport(WINDOW, 'model');

          expect(rows.map((r) => [r.key, r.runs, r.costUsd, r.tokens.input, r.turns])).toEqual([
            ['claude-opus', 2, 1.5, 11, 0],
            ['claude-haiku', 1, 0.25, 2, 0],
          ]);
          expect(rows[0]?.stopReasons).toEqual({ success: 1, error: 1 });
          expect(total.runs).toBe(3);
        });

        it('returns no rows and a zero total for an empty window', async () => {
          const repos = make();
          await seedReportRuns(repos);

          const empty = { from: '2030-01-01T00:00:00.000Z', to: '2030-01-02T00:00:00.000Z' };
          for (const groupBy of ['day', 'session', 'task', 'model'] as const) {
            const { rows, total } = await repos.runs.usageReport(empty, groupBy);
            expect(rows).toEqual([]);
            expect(total.runs).toBe(0);
            expect(total.stopReasons).toEqual({});
          }
        });
      });

      it('sums the cost of runs started at or after a moment', async () => {
        const repos = make();
        await seedThread(repos);
        expect(await repos.runs.costSince(at(0))).toBe(0);
        await seedRun(repos, 'r-1', { startedAt: at(0), costUsd: 1.5 });
        await seedRun(repos, 'r-2', { startedAt: at(10), costUsd: 0.25 });
        await seedRun(repos, 'r-3', { startedAt: at(20), costUsd: 2 });
        expect(await repos.runs.costSince(at(10))).toBeCloseTo(2.25);
        expect(await repos.runs.costSince(at(0))).toBeCloseTo(3.75);
        expect(await repos.runs.costSince(at(21))).toBe(0);
      });

      it('numbers the events of each run 0, 1, 2 and returns the newest as the last event', async () => {
        const repos = make();
        await seedThread(repos);
        await seedRun(repos, 'r-1');
        await seedRun(repos, 'r-2');
        expect(await repos.runs.lastEvent('r-1')).toBeNull();

        const a = await repos.runs.appendEvent('r-1', text('a'), at(1));
        await repos.runs.appendEvent('r-2', text('other run'), at(1));
        const b = await repos.runs.appendEvent(
          'r-1',
          {
            kind: 'tool_use',
            payload: { toolUseId: 'u1', name: 'Bash', input: { command: 'ls' } },
            parentToolUseId: 'p1',
          },
          at(2),
        );
        const c = await repos.runs.appendEvent('r-1', text('c'), at(3));

        expect([a.seq, b.seq, c.seq]).toEqual([0, 1, 2]);
        expect(a).toEqual({
          kind: 'text',
          payload: { text: 'a' },
          seq: 0,
          runId: 'r-1',
          at: at(1),
        });
        expect(b.parentToolUseId).toBe('p1');
        expect(await repos.runs.lastEvent('r-1')).toEqual(c);
        expect((await repos.runs.lastEvent('r-2'))?.seq).toBe(0);
      });
    });

    describe('permissions', () => {
      it('stores requests, updates a decision and lists the pending ones oldest first', async () => {
        const repos = make();
        await seedThread(repos);
        await seedRun(repos, 'r-1');
        const request = (id: string, minutes: number) =>
          requestPermission({
            id,
            runId: 'r-1',
            threadId: THREAD,
            taskId: null,
            tool: 'Bash',
            description: `run ${id}`,
            input: { command: 'npm test', nested: { a: [1, 2] } },
            at: at(minutes),
            timeoutMinutes: 30,
          });
        const late = request('p-late', 9);
        const early = request('p-early', 2);
        const decided = request('p-decided', 1);
        await repos.permissions.save(late);
        await repos.permissions.save(early);
        await repos.permissions.save(decided);
        await repos.permissions.save({ ...decided, status: 'allow', decidedAt: at(2) });

        expect(await repos.permissions.get('p-early')).toEqual(early);
        expect((await repos.permissions.get('p-decided'))?.status).toBe('allow');
        expect(await repos.permissions.get('nope')).toBeNull();
        expect((await repos.permissions.listPending()).map((p) => p.id)).toEqual([
          'p-early',
          'p-late',
        ]);
      });
    });

    describe('watches', () => {
      const watch = (taskId: string, patch: Partial<Watch> = {}): Watch => ({
        taskId,
        prNumber: 12,
        state: null,
        lastCheckedAt: null,
        summary: null,
        lastGreen: null,
        rerunHeadSha: null,
        ...patch,
      });

      it('round-trips state and summary and updates in place', async () => {
        const repos = make();
        await seedThread(repos);
        await seedTask(repos, 'T-1', { stage: 'PR Open' });
        const first = watch('T-1');
        await repos.watches.save(first);
        expect(await repos.watches.get('T-1')).toEqual(first);
        expect(await repos.watches.get('T-9')).toBeNull();

        const polled = watch('T-1', {
          state: {
            headSha: 'abc',
            checks: [{ id: 1, status: 'completed', conclusion: 'success' }],
            reviews: [{ id: 2, state: 'approved' }],
            seenCommentIds: ['98', '99'],
          },
          lastCheckedAt: at(5),
          summary: {
            headSha: 'abc',
            checks: [{ name: 'ci', status: 'passed', url: null }],
            earlierChecks: [],
            ciGreen: true,
            review: 'approved',
            comments: [
              { id: '99', author: 'rev', body: 'lgtm', handling: 'pending', ignoredBecause: null },
            ],
          } as unknown as Watch['summary'],
          lastGreen: { headSha: 'abc', checkNames: ['ci'] },
          rerunHeadSha: 'abc',
        });
        await repos.watches.save(polled);
        expect(await repos.watches.get('T-1')).toEqual(polled);
      });

      it('lists only watches of unfinished tasks, oldest task first', async () => {
        const repos = make();
        await seedThread(repos);
        // Created oldest first: the fake lists in insertion order, Postgres sorts by task start.
        await seedTask(repos, 'T-2', { stage: 'Done', startedAt: at(1) });
        await seedTask(repos, 'T-3', { stage: 'Fixing', startedAt: at(10) });
        await seedTask(repos, 'T-1', { stage: 'PR Open', startedAt: at(20) });
        for (const id of ['T-2', 'T-3', 'T-1']) await repos.watches.save(watch(id));
        expect((await repos.watches.listActive()).map((w) => w.taskId)).toEqual(['T-3', 'T-1']);
      });
    });
  });
}

contract('in-memory fake', () => inMemoryRepositories(new InMemoryDatabase()));

const pg = useTestDatabase();
contract('Postgres', () => pg.repos);
