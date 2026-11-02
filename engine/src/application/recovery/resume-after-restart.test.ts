import { describe, expect, it } from 'vitest';
import { startRun } from '../../domain/index.js';
import { buildTestApp } from '../testing/build-test-app.js';

describe('ResumeAfterRestart', () => {
  it('interrupts lost runs, denies their permissions and re-queues the task (ST-04, ST-05)', async () => {
    const app = buildTestApp();
    const { task, thread } = await app.seed.task({ stage: 'Implementing' });
    const run = startRun({
      id: 'r-lost',
      sessionId: 's-1',
      role: 'worker',
      threadId: thread.id,
      taskId: task.id,
      at: app.clock.now(),
    });
    await app.uow.run((tx) => tx.runs.save(run));
    await app.requestPermission.execute(
      { ...app.identity.worker(task), runId: run.id },
      { tool_name: 'Bash', input: {} },
    );
    app.clock.advanceMinutes(3);
    app.clearEffects();

    await app.resumeAfterRestart.execute();

    expect(app.db.tables.runs.get('r-lost')).toMatchObject({
      status: 'interrupted',
      finishedAt: app.clock.now(),
    });
    expect(app.db.tables.permissions.get('p-1')?.status).toBe('timeout');
    expect(app.task(task.id).stage).toBe('Implementing');
    expect(app.runs.calls).toEqual([{ type: 'worker_run', taskId: task.id, reason: 'resume' }]);
    const lines = app.messagesOf(thread.id).filter((m) => m.kind === 'system');
    expect(lines.map((m) => m.body.text)).toEqual(['Worker restarted from stage Implementing']);
    expect(app.db.tables.journal.map((e) => e.type)).toEqual(
      expect.arrayContaining(['run_interrupted', 'worker_restarted']),
    );
  });

  it('changes nothing and posts nothing the second time (NFR-04)', async () => {
    const app = buildTestApp();
    const { task, thread } = await app.seed.task({ stage: 'Fixing' });
    await app.uow.run((tx) =>
      tx.runs.save(
        startRun({
          id: 'r-lost',
          sessionId: 's-1',
          role: 'worker',
          threadId: thread.id,
          taskId: task.id,
          at: app.clock.now(),
        }),
      ),
    );
    await app.resumeAfterRestart.execute();
    const before = {
      messages: app.db.tables.messages.size,
      journal: app.db.tables.journal.length,
      runs: structuredClone(app.db.tables.runs.get('r-lost')),
    };

    await app.resumeAfterRestart.execute();

    expect(app.db.tables.messages.size).toBe(before.messages);
    expect(app.db.tables.journal).toHaveLength(before.journal);
    expect(app.db.tables.runs.get('r-lost')).toEqual(before.runs);
  });

  it('resumes every worker stage and leaves tasks that wait for someone else', async () => {
    const app = buildTestApp();
    const working = [] as string[];
    for (const stage of ['Intake', 'Context', 'Verifying', 'Reviewing'] as const) {
      working.push((await app.seed.task({ stage })).task.id);
    }
    const waiting = await app.seed.task({ stage: 'Spec Review' });
    const pr = await app.seed.task({ stage: 'PR Open' });
    const done = await app.seed.task({ stage: 'Implementing' });
    await app.cancelTask.execute({ taskId: done.task.id });
    app.clearEffects();

    await app.resumeAfterRestart.execute();

    expect(app.runs.calls.map((c) => c.type === 'worker_run' && c.taskId)).toEqual(working);
    expect(app.runs.calls.map((c) => c.type)).not.toContain('dispatcher_turn');
    const asked = app.runs.calls.flatMap((c) => (c.type === 'worker_run' ? [c.taskId] : []));
    expect(asked).not.toContain(waiting.task.id);
    expect(asked).not.toContain(pr.task.id);
    expect(asked).not.toContain(done.task.id);
  });

  it('gives a thread with unprocessed owner messages and no task its dispatcher turn', async () => {
    const app = buildTestApp();
    const idle = await app.seed.thread();
    const withTask = await app.seed.task({ stage: 'PR Open' });
    await app.postOwnerMessage.execute({ threadId: idle.id, text: 'Add a /health endpoint' });
    await app.postOwnerMessage.execute({ threadId: withTask.thread.id, text: 'status?' });
    app.clearEffects();

    await app.resumeAfterRestart.execute();

    expect(app.runs.calls).toEqual([{ type: 'dispatcher_turn', threadId: idle.id }]);
  });
});
