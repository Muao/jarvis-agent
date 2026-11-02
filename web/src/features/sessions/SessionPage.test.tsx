import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { RunDto, RunEvent, SessionDto, TaskStage } from '@jarvis/shared';
import { FakeEventSource } from '../../test/FakeEventSource';
import { stubFetch, type FakeRoutes } from '../../test/fakeFetch';
import { overview, usage } from '../../test/fixtures';
import { renderWithProviders } from '../../test/renderWithProviders';
import { taskDetail } from '../tasks/fixtures';
import { SessionPage } from './SessionPage';

const AT = '2026-10-26T10:00:00.000Z';
const at = (seconds: number) => new Date(Date.parse(AT) + seconds * 1000).toISOString();

const run = (patch: Partial<RunDto> = {}): RunDto => ({
  id: 'run-1',
  sessionId: 's-1',
  taskId: 'T-1',
  role: 'worker',
  stage: 'Implementing',
  status: 'running',
  startedAt: AT,
  endedAt: null,
  usage: { input: 1200, output: 340, cacheRead: 5000, cacheWrite: 70 },
  costUsd: 0.42,
  turns: 3,
  maxTurns: 50,
  exitCode: null,
  error: null,
  ...patch,
});

const session = (patch: Partial<SessionDto> = {}): SessionDto => ({
  id: 's-1',
  role: 'worker',
  taskId: 'T-1',
  threadId: 'th-1',
  model: 'sonnet',
  status: 'running',
  claudeSessionId: 'cli-abc',
  stalled: false,
  runs: [run()],
  ...patch,
});

type Draft<K extends RunEvent['kind']> = Extract<RunEvent, { kind: K }>['payload'];
const ev = <K extends RunEvent['kind']>(
  seq: number,
  kind: K,
  payload: Draft<K>,
  parentToolUseId?: string,
): RunEvent =>
  ({ seq, runId: 'run-1', at: at(seq), kind, payload, parentToolUseId }) as unknown as RunEvent;

function setup(
  opts: {
    session?: SessionDto;
    events?: RunEvent[];
    paused?: boolean;
    taskStage?: TaskStage;
    extra?: FakeRoutes;
    route?: string;
  } = {},
) {
  const fetchSpy = stubFetch({
    'GET /api/sessions/s-1': opts.session ?? session(),
    'GET /api/runs/run-1/events': { events: opts.events ?? [] },
    'GET /api/overview': overview({ usage: usage({ paused: opts.paused ?? false }) }),
    'GET /api/tasks/T-1': taskDetail({ id: 'T-1', stage: opts.taskStage ?? 'Implementing' }),
    ...opts.extra,
  });
  const view = renderWithProviders(
    <Routes>
      <Route path="/sessions/:sessionId" element={<SessionPage />} />
    </Routes>,
    { route: opts.route ?? '/sessions/s-1' },
  );
  FakeEventSource.current.open();
  return { fetchSpy, ...view };
}

const sampleEvents: RunEvent[] = [
  ev(0, 'system', { subtype: 'init', message: 'process started' }),
  ev(1, 'text', { text: 'Reading the **spec** now' }),
  ev(2, 'tool_use', { toolUseId: 'tu-1', name: 'Read', input: { path: 'spec.md' } }),
  ev(3, 'tool_result', { toolUseId: 'tu-1', content: 'spec body', isError: false }),
  ev(4, 'permission', { permissionId: 'p-1', toolName: 'Bash', decision: 'pending' }),
  ev(5, 'permission', { permissionId: 'p-1', toolName: 'Bash', decision: 'allow' }),
  ev(6, 'error', { message: 'CLI crashed once' }),
];

describe('SessionPage', () => {
  it('shows the header, run summary and every event kind', async () => {
    setup({ events: sampleEvents });
    expect(await screen.findByRole('heading', { name: /Session · worker/ })).toBeInTheDocument();
    expect(screen.getByText('● Running')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'T-1 →' })).toHaveAttribute('href', '/tasks/T-1');
    expect(screen.getByText('cli-abc')).toBeInTheDocument();
    expect(screen.getByText('sonnet')).toBeInTheDocument();

    const summary = screen.getByRole('region', { name: 'Run summary' });
    expect(within(summary).getByText('1,200')).toBeInTheDocument();
    expect(within(summary).getByText('notional $0.42')).toBeInTheDocument();
    expect(within(summary).getByText('3 / 50')).toBeInTheDocument();

    const log = await screen.findByRole('log', { name: 'Events' });
    expect(within(log).getByText('spec', { selector: 'strong' })).toBeInTheDocument();
    expect(within(log).getByText('Read')).toBeInTheDocument();
    expect(within(log).getByText('✓ ok')).toBeInTheDocument();
    expect(within(log).getByText('spec body')).toBeInTheDocument();
    expect(within(log).getByText('✓ allowed')).toBeInTheDocument();
    expect(within(log).queryByText(/waiting for decision/)).not.toBeInTheDocument();
    expect(within(log).getByText(/process started/)).toBeInTheDocument();
    expect(within(log).getByRole('alert')).toHaveTextContent('CLI crashed once');
  });

  it('shows the tool duration from call to result and collapses the input', async () => {
    setup({ events: sampleEvents });
    const log = await screen.findByRole('log', { name: 'Events' });
    expect(within(log).getByText('1.0 s')).toBeInTheDocument();
    expect(within(log).queryByText(/"path"/)).not.toBeInTheDocument();
    await userEvent.click(within(log).getByText('Input'));
    expect(await within(log).findByText(/"path": "spec.md"/)).toBeInTheDocument();
  });

  it('nests subagent events under the parent tool call', async () => {
    setup({
      events: [
        ev(0, 'tool_use', {
          toolUseId: 'task-1',
          name: 'Task',
          input: { subagent_type: 'implementer', description: 'do it' },
        }),
        ev(1, 'text', { text: 'inner thought' }, 'task-1'),
        ev(2, 'tool_use', { toolUseId: 'tu-9', name: 'Edit', input: {} }, 'task-1'),
        ev(3, 'tool_result', { toolUseId: 'tu-9', content: 'edited', isError: false }, 'task-1'),
        ev(4, 'tool_result', { toolUseId: 'task-1', content: 'done', isError: false }),
      ],
    });
    const nested = await screen.findByRole('list', { name: 'Events of subagent implementer' });
    expect(within(nested).getByText('inner thought')).toBeInTheDocument();
    expect(within(nested).getByText('Edit')).toBeInTheDocument();
    expect(screen.getByText('subagent: implementer')).toBeInTheDocument();
    expect(screen.getAllByText('done')).toHaveLength(1);
  });

  it('filters, searches and navigates between errors', async () => {
    const user = userEvent.setup();
    setup({
      events: [
        ev(0, 'text', { text: 'hello world' }),
        ev(1, 'tool_use', { toolUseId: 'a', name: 'Bash', input: { command: 'ls' } }),
        ev(2, 'tool_result', { toolUseId: 'a', content: 'boom one', isError: true }),
        ev(3, 'system', { subtype: 'resume' }),
        ev(4, 'error', { message: 'second failure' }),
      ],
    });
    const log = await screen.findByRole('log', { name: 'Events' });

    await user.click(screen.getByRole('button', { name: 'Messages' }));
    expect(within(log).getByText('hello world')).toBeInTheDocument();
    expect(within(log).queryByText('Bash')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'System' }));
    expect(within(log).getByText(/resume/)).toBeInTheDocument();
    expect(within(log).queryByText('hello world')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'All' }));
    await user.type(screen.getByRole('searchbox', { name: 'Search events' }), 'ls');
    expect(within(log).getByText('Bash')).toBeInTheDocument();
    expect(within(log).queryByText('hello world')).not.toBeInTheDocument();
    await user.clear(screen.getByRole('searchbox', { name: 'Search events' }));

    await user.click(screen.getByRole('button', { name: 'Errors' }));
    expect(within(log).queryByText('hello world')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'All' }));
    await user.click(screen.getByRole('button', { name: 'Next error' }));
    expect(screen.getByText('1 of 2 errors')).toBeInTheDocument();
    expect(log.querySelector('[aria-current="true"]')).toHaveTextContent('boom one');
    await user.click(screen.getByRole('button', { name: 'Next error' }));
    expect(log.querySelector('[aria-current="true"]')).toHaveTextContent('second failure');
    await user.click(screen.getByRole('button', { name: 'Previous error' }));
    expect(log.querySelector('[aria-current="true"]')).toHaveTextContent('boom one');
  });

  it('disables error navigation when there are no errors', async () => {
    setup({ events: [ev(0, 'text', { text: 'fine' })] });
    await screen.findByText('fine');
    expect(screen.getByRole('button', { name: 'Next error' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Previous error' })).toBeDisabled();
  });

  it('appends live events from the stream and offers Jump to latest after scrolling up', async () => {
    setup({ events: [ev(0, 'text', { text: 'first' })] });
    const log = await screen.findByRole('log', { name: 'Events' });
    await screen.findByText('first');

    FakeEventSource.current.push({
      type: 'run_event',
      id: 'run-1',
      data: ev(1, 'text', { text: 'streamed in' }),
    });
    expect(await screen.findByText('streamed in')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).not.toBeInTheDocument();

    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 2000 });
    Object.defineProperty(log, 'clientHeight', { configurable: true, value: 400 });
    log.scrollTop = 100;
    fireEvent.scroll(log);
    const jump = await screen.findByRole('button', { name: 'Jump to latest' });

    await userEvent.click(jump);
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).not.toBeInTheDocument();
    expect(log.scrollTop).toBe(2000);
  });

  it('collapses long tool output behind Show more', async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `output line ${i}`).join('\n');
    setup({
      events: [
        ev(0, 'tool_use', { toolUseId: 'a', name: 'Bash', input: {} }),
        ev(1, 'tool_result', { toolUseId: 'a', content: lines, isError: false }),
      ],
    });
    const log = await screen.findByRole('log', { name: 'Events' });
    expect(within(log).queryByText(/output line 50/)).not.toBeInTheDocument();
    await userEvent.click(within(log).getByRole('button', { name: /Show more/ }));
    expect(within(log).getByText(/output line 99/)).toBeInTheDocument();
  });

  it('caps the rendered text of an enormous output', async () => {
    const huge = 'x'.repeat(200_000);
    setup({
      events: [
        ev(0, 'tool_use', { toolUseId: 'a', name: 'Bash', input: {} }),
        ev(1, 'tool_result', { toolUseId: 'a', content: huge, isError: false }),
      ],
    });
    const log = await screen.findByRole('log', { name: 'Events' });
    expect(await within(log).findByText(/150,000 more characters not shown/)).toBeInTheDocument();
  });

  it('renders 2 000 events quickly and pages older rows in on demand', async () => {
    const many = Array.from({ length: 2000 }, (_, i) =>
      i % 2 === 0
        ? ev(i, 'tool_use', { toolUseId: `t${i}`, name: 'Grep', input: { q: i } })
        : ev(i, 'tool_result', { toolUseId: `t${i - 1}`, content: `hit ${i}`, isError: false }),
    );
    const started = performance.now();
    setup({ events: many });
    const log = await screen.findByRole('log', { name: 'Events' });
    await within(log).findByRole('button', { name: /Show earlier events \(800 hidden\)/ });
    expect(performance.now() - started).toBeLessThan(5000);
    expect(log.querySelectorAll('li')).toHaveLength(200);
    await userEvent.click(within(log).getByRole('button', { name: /Show earlier events/ }));
    expect(log.querySelectorAll('li')).toHaveLength(400);
  }, 20_000);

  it('opens the run named in ?run and lets the user switch runs', async () => {
    const two = session({
      runs: [run({ id: 'run-0', status: 'completed', endedAt: at(90), turns: 7 }), run()],
    });
    setup({
      session: two,
      route: '/sessions/s-1?run=run-0',
      extra: { 'GET /api/runs/run-0/events': { events: [ev(0, 'text', { text: 'old run' })] } },
    });
    expect(await screen.findByText('old run')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Run' })).toHaveValue('run-0');
    expect(screen.getByText('1 min 30 s')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Run' }), 'run-1');
    await waitFor(() => expect(screen.queryByText('old run')).not.toBeInTheDocument());
  });

  describe('states', () => {
    it('explains a session without runs', async () => {
      setup({ session: session({ runs: [], status: 'idle' }) });
      expect(await screen.findByRole('heading', { name: 'No runs yet' })).toBeInTheDocument();
    });

    it('puts the failure reason on top of a failed run', async () => {
      setup({
        session: session({
          status: 'error',
          runs: [
            run({
              status: 'failed',
              error: 'CLI exited unexpectedly',
              exitCode: 1,
              endedAt: at(5),
            }),
          ],
        }),
      });
      expect(await screen.findByRole('alert')).toHaveTextContent('Run failed');
      expect(screen.getByRole('alert')).toHaveTextContent('CLI exited unexpectedly');
    });

    it('says when a run hit max turns', async () => {
      setup({ session: session({ runs: [run({ status: 'limit_reached', endedAt: at(5) })] }) });
      expect(await screen.findByText('✕ Run stopped at max turns (50)')).toBeInTheDocument();
    });

    it('warns about a stalled process', async () => {
      setup({ session: session({ stalled: true }) });
      expect(await screen.findByText(/may be stalled/)).toBeInTheDocument();
    });

    it('marks a stopped session', async () => {
      setup({
        session: session({ status: 'stopped', runs: [run({ status: 'stopped', endedAt: at(5) })] }),
      });
      expect(await screen.findByText('■ This session was stopped.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Stop run' })).toBeDisabled();
    });

    it('disables send and retry with an explanation while the budget is paused', async () => {
      setup({ paused: true });
      expect(await screen.findByText(/Paused: daily budget reached/)).toBeInTheDocument();
      await userEvent.type(screen.getByLabelText('Message to the session'), 'hi');
      expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Retry stage' })).toBeDisabled();
    });

    it('disables the controls while the engine is offline', async () => {
      setup();
      await screen.findByRole('log', { name: 'Events' });
      FakeEventSource.current.fail(true);
      expect(await screen.findByText(/Engine offline/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Stop run' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Retry stage' })).toBeDisabled();
    });
  });

  describe('controls', () => {
    const posts = (spy: ReturnType<typeof stubFetch>) =>
      spy.mock.calls.filter(([, init]) => init?.method === 'POST');

    it('sends a message and marks it queued', async () => {
      const { fetchSpy } = setup({
        extra: { 'POST /api/sessions/s-1/messages': { delivery: 'queued' } },
      });
      await userEvent.type(
        await screen.findByLabelText('Message to the session'),
        'please continue',
      );
      await userEvent.click(screen.getByRole('button', { name: 'Send message' }));
      const sent = await screen.findByRole('list', { name: 'Sent messages' });
      expect(within(sent).getByText('… queued')).toBeInTheDocument();
      const [url, init] = posts(fetchSpy)[0] ?? [];
      expect(String(url)).toBe('/api/sessions/s-1/messages');
      expect(JSON.parse(String(init?.body))).toEqual({ text: 'please continue' });
    });

    it('stops the run only after confirmation', async () => {
      const { fetchSpy } = setup({ extra: { 'POST /api/runs/run-1/stop': {} } });
      await userEvent.click(await screen.findByRole('button', { name: 'Stop run' }));
      const dialog = await screen.findByRole('dialog');
      expect(posts(fetchSpy)).toHaveLength(0);
      await userEvent.click(within(dialog).getByRole('button', { name: 'Stop run' }));
      await waitFor(() => expect(posts(fetchSpy)).toHaveLength(1));
      expect(String(posts(fetchSpy)[0]?.[0])).toBe('/api/runs/run-1/stop');
    });

    it('stops a dispatcher session, which has no task', async () => {
      const { fetchSpy } = setup({
        session: session({ role: 'dispatcher', taskId: null, runs: [run({ taskId: null })] }),
        extra: { 'POST /api/runs/run-1/stop': {} },
      });
      const stop = await screen.findByRole('button', { name: 'Stop run' });
      expect(stop).toBeEnabled();
      await userEvent.click(stop);
      await userEvent.click(
        within(await screen.findByRole('dialog')).getByRole('button', { name: 'Stop run' }),
      );
      await waitFor(() => expect(posts(fetchSpy)).toHaveLength(1));
      expect(screen.getByRole('button', { name: 'Retry stage' })).toBeDisabled();
    });

    it('retries the stage', async () => {
      const { fetchSpy } = setup({ extra: { 'POST /api/tasks/T-1/retry': {} } });
      const retry = await screen.findByRole('button', { name: 'Retry stage' });
      await waitFor(() => expect(retry).toBeEnabled());
      await userEvent.click(retry);
      await waitFor(() => expect(posts(fetchSpy)).toHaveLength(1));
      expect(String(posts(fetchSpy)[0]?.[0])).toBe('/api/tasks/T-1/retry');
    });

    it.each(['Spec Review', 'Blocked', 'PR Open', 'Done', 'Cancelled'] as const)(
      'disables Retry stage in %s, as the engine would reject it',
      async (taskStage) => {
        setup({ taskStage });
        expect(await screen.findByText(/Retry stage is not available in/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Retry stage' })).toBeDisabled();
      },
    );

    it('enables Retry stage for a Failed task', async () => {
      setup({ taskStage: 'Failed' });
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Retry stage' })).toBeEnabled(),
      );
    });
  });
});
