import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { MessageDto, ThreadDetailDto } from '@jarvis/shared';
import { FakeEventSource } from '../../test/FakeEventSource';
import { stubFetch, type FakeRoutes } from '../../test/fakeFetch';
import { overview, thread, usage } from '../../test/fixtures';
import { renderWithProviders } from '../../test/renderWithProviders';
import { ChatPage } from './ChatPage';

const AT = '2026-10-26T10:00:00.000Z';
const ANSWERED_AT = '2026-10-26T12:32:00.000Z';

type Body = Record<string, unknown>;

function detail(messages: MessageDto[], patch: Partial<ThreadDetailDto> = {}): ThreadDetailDto {
  return {
    ...thread({
      taskId: 'T-12',
      stage: 'Spec Review',
      prNumber: 34,
      prUrl: 'https://x.test/pr/34',
    }),
    dispatcherSessionId: 'sess-1',
    dispatcherBusy: false,
    messages,
    ...patch,
  };
}

const base = { id: 'm1', threadId: 'th-1', createdAt: AT, answer: null, answeredAt: null };
const msg = (patch: Record<string, unknown>) => ({ ...base, ...patch }) as MessageDto;

function renderChat(route: string, routes: FakeRoutes, { live = true }: { live?: boolean } = {}) {
  const spy = stubFetch({
    'GET /api/overview': overview(),
    'GET /api/threads': [thread()],
    ...routes,
  });
  const result = renderWithProviders(
    <Routes>
      <Route path="/chat/:threadId?" element={<ChatPage />} />
    </Routes>,
    { route },
  );
  if (live) FakeEventSource.current.open();
  return { spy, ...result };
}

/** JSON bodies of the POSTs sent to `path`. */
function posts(spy: ReturnType<typeof stubFetch>, path: string): Body[] {
  return spy.mock.calls
    .filter(([url, init]) => String(url) === path && init?.method === 'POST')
    .map(([, init]) => JSON.parse(String(init?.body)) as Body);
}

const openThread = (messages: MessageDto[], patch: Partial<ThreadDetailDto> = {}) =>
  renderChat('/chat/th-1', { 'GET /api/threads/th-1': detail(messages, patch) });

describe('thread list', () => {
  const threads = [
    thread({ id: 'a', title: 'Older active', lastActivityAt: '2026-10-26T08:00:00.000Z' }),
    thread({ id: 'b', title: 'Newest active', lastActivityAt: '2026-10-26T11:00:00.000Z' }),
    thread({
      id: 'c',
      title: 'Needs me',
      waitingForOwner: true,
      stage: 'Spec Review',
      taskId: 'T-1',
      lastActivityAt: '2026-10-26T07:00:00.000Z',
    }),
    thread({ id: 'd', title: 'Finished', stage: 'Done', taskId: 'T-2' }),
  ];

  const titles = () =>
    within(screen.getByRole('region', { name: 'Threads' }))
      .getAllByRole('link')
      .map((link) => link.textContent ?? '')
      .filter((text) => !text.startsWith('New thread'));

  it('sorts waiting threads first, then by recent activity, and marks waiting ones', async () => {
    renderChat('/chat', { 'GET /api/threads': threads });
    await screen.findByText('Needs me');
    const order = titles();
    expect(order[0]).toContain('Needs me');
    expect(order[0]).toContain('Waiting for you');
    expect(order[1]).toContain('Newest active');
    expect(order[2]).toContain('Finished');
    expect(order[3]).toContain('Older active');
  });

  it('filters by Waiting for me, Active and Done', async () => {
    const user = userEvent.setup();
    renderChat('/chat', { 'GET /api/threads': threads });
    await screen.findByText('Needs me');

    await user.click(screen.getByRole('button', { name: 'Waiting for me' }));
    expect(titles()).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(titles()).toHaveLength(1);
    expect(titles()[0]).toContain('Finished');

    await user.click(screen.getByRole('button', { name: 'Active' }));
    expect(titles()).toHaveLength(3);
  });

  it('shows an empty state', async () => {
    renderChat('/chat', { 'GET /api/threads': [] });
    expect(await screen.findByText(/No threads yet/)).toBeInTheDocument();
  });
});

describe('new thread', () => {
  it('creates a thread from the first message and opens it', async () => {
    const user = userEvent.setup();
    const created = detail([], {
      id: 'th-9',
      title: 'Build the course page',
      taskId: null,
      stage: null,
    });
    const { spy } = renderChat('/chat', {
      'POST /api/threads': created,
      'GET /api/threads/th-9': created,
    });

    await user.type(
      await screen.findByRole('textbox', { name: 'Message' }),
      'Build the course page{Enter}',
    );

    expect(
      await screen.findByRole('heading', { name: 'Build the course page' }),
    ).toBeInTheDocument();
    expect(posts(spy, '/api/threads')).toEqual([{ text: 'Build the course page' }]);
  });

  it('fills the composer from an example prompt', async () => {
    const user = userEvent.setup();
    renderChat('/chat', {});
    await user.click(await screen.findByRole('button', { name: /Що в Notion сказано про/ }));
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue(
      'Що в Notion сказано про…',
    );
  });
});

describe('composer', () => {
  it('sends on Enter and inserts a newline on Shift+Enter', async () => {
    const user = userEvent.setup();
    const { spy } = openThread([]);
    const box = await screen.findByRole('textbox', { name: 'Message' });

    await user.type(box, 'line one{Shift>}{Enter}{/Shift}line two');
    expect(box).toHaveValue('line one\nline two');
    expect(posts(spy, '/api/threads/th-1/messages')).toHaveLength(0);

    await user.type(box, '{Enter}');
    expect(posts(spy, '/api/threads/th-1/messages')).toEqual([{ text: 'line one\nline two' }]);
    expect(box).toHaveValue('');
  });

  it('is disabled with an explanation while the engine is offline', async () => {
    renderChat('/chat/th-1', { 'GET /api/threads/th-1': detail([]) }, { live: false });
    expect(await screen.findByRole('textbox', { name: 'Message' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.getByText("Engine offline — messages can't be sent")).toBeInTheDocument();
  });

  it('explains the budget pause but stays active', async () => {
    renderChat('/chat/th-1', {
      'GET /api/threads/th-1': detail([]),
      'GET /api/overview': overview({ usage: usage({ paused: true }) }),
    });
    expect(await screen.findByText(/Daily budget reached/)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeEnabled();
  });

  it('shows the thinking indicator while the dispatcher is busy', async () => {
    openThread([], { dispatcherBusy: true });
    expect(await screen.findByText('Jarvis is thinking…')).toBeInTheDocument();
  });

  it('marks a queued message and offers Retry on a failed one', async () => {
    const user = userEvent.setup();
    const { spy } = openThread([
      msg({
        id: 'q',
        kind: 'owner',
        body: { text: 'queued text', delivery: 'queued', source: 'owner' },
      }),
      msg({
        id: 'f',
        kind: 'owner',
        body: { text: 'failed text', delivery: 'failed', source: 'owner' },
      }),
    ]);
    expect(await screen.findByText('queued')).toBeInTheDocument();
    expect(screen.getByText('failed to send')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(posts(spy, '/api/threads/th-1/messages')).toEqual([{ text: 'failed text' }]);
  });

  it('shows a send that never reached the engine as failed, with Retry', async () => {
    const user = userEvent.setup();
    renderChat('/chat/th-1', {
      'GET /api/threads/th-1': detail([]),
      'POST /api/threads/th-1/messages': { status: 500, body: { code: 'boom', message: 'No' } },
    });
    await user.type(await screen.findByRole('textbox', { name: 'Message' }), 'hello{Enter}');
    expect(await screen.findByText('failed to send')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});

describe('thread header and menu', () => {
  it('links to the task and the PR and shows the stage', async () => {
    openThread([]);
    expect(await screen.findByRole('link', { name: 'T-12 →' })).toHaveAttribute(
      'href',
      '/tasks/T-12',
    );
    expect(screen.getByRole('link', { name: 'PR #34 ↗' })).toHaveAttribute(
      'href',
      'https://x.test/pr/34',
    );
    expect(screen.getAllByText('Spec Review').length).toBeGreaterThan(0);
  });

  it('cancels the task only after confirmation', async () => {
    const user = userEvent.setup();
    const { spy } = renderChat('/chat/th-1', {
      'GET /api/threads/th-1': detail([]),
      'POST /api/tasks/T-12/cancel': {},
    });
    await user.click(await screen.findByRole('button', { name: 'Thread actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Cancel task' }));
    expect(spy.mock.calls.some(([url]) => String(url).endsWith('/cancel'))).toBe(false);

    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel task' }),
    );
    await screen.findByRole('button', { name: 'Thread actions' });
    expect(spy.mock.calls.some(([url]) => String(url) === '/api/tasks/T-12/cancel')).toBe(true);
  });

  it('Status in a task thread shows the status card and sends nothing to the worker', async () => {
    const user = userEvent.setup();
    const { spy } = renderChat('/chat/th-1', {
      'GET /api/threads/th-1': detail([
        msg({
          kind: 'status',
          body: {
            taskId: 'T-12',
            stage: 'Implementing',
            workerSessionId: null,
            startedAt: null,
            steps: [{ label: 'context', state: 'active' }],
            checks: { used: 0, max: 3 },
            ciFixes: { used: 0, max: 3 },
            reviews: { used: 0, max: 3 },
          },
        }),
      ]),
    });
    await user.click(await screen.findByRole('button', { name: 'Thread actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Status' }));

    expect(screen.getByRole('article', { name: 'Status of T-12' })).toHaveFocus();
    expect(posts(spy, '/api/threads/th-1/messages')).toEqual([]);
  });

  it('Status in a thread without a task asks the dispatcher', async () => {
    const user = userEvent.setup();
    const { spy } = renderChat('/chat/th-1', {
      'GET /api/threads/th-1': detail([], { taskId: null, stage: null }),
      'POST /api/threads/th-1/messages': {},
    });
    await user.click(await screen.findByRole('button', { name: 'Thread actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Status' }));

    expect(posts(spy, '/api/threads/th-1/messages')).toHaveLength(1);
  });

  it('opens the dispatcher session from the menu', async () => {
    const user = userEvent.setup();
    openThread([]);
    await user.click(await screen.findByRole('button', { name: 'Thread actions' }));
    expect(screen.getByRole('menuitem', { name: 'Open dispatcher session' })).toHaveAttribute(
      'href',
      '/sessions/sess-1',
    );
  });
});

describe('message kinds', () => {
  it('renders a Jarvis message as Markdown', async () => {
    openThread([msg({ kind: 'jarvis', body: { text: 'Done with **bold** text' } })]);
    expect((await screen.findByText('bold')).tagName).toBe('STRONG');
  });

  it('renders raw HTML in a message as text, not elements', async () => {
    const { container } = openThread([
      msg({ id: 'j', kind: 'jarvis', body: { text: '<img src=x onerror=alert(1)> <b>hi</b>' } }),
      msg({ id: 's', kind: 'system', body: { text: '<script>alert(1)</script>' } }),
    ]);
    await screen.findByText(/<img src=x/);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(screen.getByText('<script>alert(1)</script>')).toBeInTheDocument();
  });

  it('renders ci and review owner messages as system lines, not owner bubbles', async () => {
    openThread([
      msg({
        id: 'c',
        kind: 'owner',
        body: { text: 'check lint failed', delivery: 'delivered', source: 'ci' },
      }),
      msg({
        id: 'r',
        kind: 'owner',
        body: { text: 'please rename', delivery: 'delivered', source: 'review' },
      }),
    ]);
    expect(await screen.findByText('CI: check lint failed')).toBeInTheDocument();
    expect(screen.getByText('Review: please rename')).toBeInTheDocument();
    expect(screen.queryByText('queued')).not.toBeInTheDocument();
  });

  it('renders a status card with steps and counters', async () => {
    openThread([
      msg({
        kind: 'status',
        body: {
          taskId: 'T-12',
          stage: 'Implementing',
          workerSessionId: 'ses-9',
          startedAt: new Date(Date.now() - 5 * 60_000 - 5_000).toISOString(),
          steps: [
            { label: 'context', state: 'done' },
            { label: 'implementing 3/5', state: 'active' },
          ],
          checks: { used: 2, max: 3 },
          ciFixes: { used: 0, max: 3 },
          reviews: { used: 1, max: 3 },
        },
      }),
    ]);
    const card = await screen.findByRole('article', { name: 'Status of T-12' });
    expect(within(card).getByText('checks 2/3')).toBeInTheDocument();
    expect(within(card).getByText(/implementing 3\/5/)).toBeInTheDocument();
    expect(within(card).getByText(/elapsed 5m/)).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'Open task →' })).toHaveAttribute(
      'href',
      '/tasks/T-12',
    );
    expect(within(card).getByRole('link', { name: 'Open console →' })).toHaveAttribute(
      'href',
      '/sessions/ses-9',
    );
  });

  it('omits the console link until the worker has a session', async () => {
    openThread([
      msg({
        kind: 'status',
        body: {
          taskId: 'T-12',
          stage: 'Context',
          workerSessionId: null,
          startedAt: null,
          steps: [{ label: 'context', state: 'active' }],
          checks: { used: 0, max: 3 },
          ciFixes: { used: 0, max: 3 },
          reviews: { used: 0, max: 3 },
        },
      }),
    ]);
    const card = await screen.findByRole('article', { name: 'Status of T-12' });
    expect(within(card).queryByRole('link', { name: 'Open console →' })).toBeNull();
    expect(within(card).queryByText(/elapsed/)).toBeNull();
  });

  it('renders a result card with PR and result links', async () => {
    openThread([
      msg({
        kind: 'result',
        body: { taskId: 'T-12', summary: 'PR is ready', prUrl: 'https://x.test/pr/34' },
      }),
    ]);
    expect(await screen.findByRole('link', { name: 'Open PR ↗' })).toHaveAttribute(
      'href',
      'https://x.test/pr/34',
    );
    expect(screen.getByRole('link', { name: 'Open result.md' })).toHaveAttribute(
      'href',
      '/tasks/T-12?artifact=result.md',
    );
  });
});

describe('answerable cards', () => {
  const decision = (patch: Record<string, unknown> = {}) =>
    msg({
      id: 'd1',
      kind: 'decision',
      body: { taskId: 'T-12', summary: 'Spec and plan ready', artifacts: ['spec.md', 'plan.md'] },
      ...patch,
    });

  it('approves a decision', async () => {
    const user = userEvent.setup();
    const { spy } = renderChat('/chat/th-1', {
      'GET /api/threads/th-1': detail([decision()]),
      'POST /api/messages/d1/answer': {},
    });
    const artifacts = within(await screen.findByRole('list', { name: 'Artifacts' }));
    expect(artifacts.getByRole('button', { name: '▸ spec.md' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(artifacts.getAllByRole('link', { name: 'open full →' })[0]).toHaveAttribute(
      'href',
      '/tasks/T-12?artifact=spec.md',
    );
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(posts(spy, '/api/messages/d1/answer')).toEqual([{ decision: 'approve' }]);
  });

  it('requests changes with a comment', async () => {
    const user = userEvent.setup();
    const { spy } = renderChat('/chat/th-1', {
      'GET /api/threads/th-1': detail([decision()]),
      'POST /api/messages/d1/answer': {},
    });
    await user.click(await screen.findByRole('button', { name: 'Request changes' }));
    const send = screen.getByRole('button', { name: 'Send changes' });
    expect(send).toBeDisabled();
    await user.type(screen.getByRole('textbox', { name: 'What should change' }), 'Split the plan');
    await user.click(send);
    expect(posts(spy, '/api/messages/d1/answer')).toEqual([
      { decision: 'request_changes', comment: 'Split the plan' },
    ]);
  });

  it('sends a double click only once', async () => {
    const user = userEvent.setup();
    const { spy } = renderChat('/chat/th-1', {
      'GET /api/threads/th-1': detail([decision()]),
      'POST /api/messages/d1/answer': {},
    });
    await user.dblClick(await screen.findByRole('button', { name: 'Approve' }));
    expect(posts(spy, '/api/messages/d1/answer')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
  });

  it('shows an answered decision as inactive with what and when', async () => {
    openThread([decision({ answer: { decision: 'approve' }, answeredAt: ANSWERED_AT })]);
    expect(await screen.findByText(/^Approved · \d\d:\d\d$/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Request changes' })).toBeDisabled();
  });

  it('marks unanswered cards of a cancelled task inactive', async () => {
    renderChat('/chat/th-1', {
      'GET /api/threads/th-1': detail([decision()], { stage: 'Cancelled' }),
    });
    expect(await screen.findByText('Task cancelled')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
  });

  it('answers a question with an option button', async () => {
    const user = userEvent.setup();
    const { spy } = renderChat('/chat/th-1', {
      'GET /api/threads/th-1': detail([
        msg({
          id: 'q1',
          kind: 'question',
          body: { taskId: 'T-12', question: 'Which framework?', options: ['React', 'Vue'] },
        }),
      ]),
      'POST /api/messages/q1/answer': {},
    });
    await user.click(await screen.findByRole('button', { name: 'Vue' }));
    expect(posts(spy, '/api/messages/q1/answer')).toEqual([{ text: 'Vue' }]);
    expect(screen.getByRole('button', { name: 'React' })).toBeDisabled();
  });

  it('answers a question with free text', async () => {
    const user = userEvent.setup();
    const { spy } = renderChat('/chat/th-1', {
      'GET /api/threads/th-1': detail([
        msg({
          id: 'q1',
          kind: 'question',
          body: { taskId: 'T-12', question: 'Which framework?', options: [] },
        }),
      ]),
      'POST /api/messages/q1/answer': {},
    });
    await user.type(await screen.findByRole('textbox', { name: 'Your answer' }), 'Svelte');
    await user.click(screen.getByRole('button', { name: 'Answer' }));
    expect(posts(spy, '/api/messages/q1/answer')).toEqual([{ text: 'Svelte' }]);
  });

  describe('permission card', () => {
    const permission = (patch: Record<string, unknown> = {}) =>
      msg({
        id: 'p1',
        kind: 'permission',
        body: {
          permissionId: 'perm-1',
          requester: 'worker T-12',
          toolName: 'Bash',
          description: 'Run the build',
          input: { command: 'pnpm build' },
        },
        ...patch,
      });

    it('allows', async () => {
      const user = userEvent.setup();
      const { spy } = renderChat('/chat/th-1', {
        'GET /api/threads/th-1': detail([permission()]),
        'POST /api/permissions/perm-1': {},
      });
      expect(await screen.findByText('Permission request · worker T-12')).toBeInTheDocument();
      expect(screen.getByText(/pnpm build/)).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Allow' }));
      expect(posts(spy, '/api/permissions/perm-1')).toEqual([{ decision: 'allow' }]);
      expect(screen.getByRole('button', { name: 'Deny' })).toBeDisabled();
    });

    it('denies', async () => {
      const user = userEvent.setup();
      const { spy } = renderChat('/chat/th-1', {
        'GET /api/threads/th-1': detail([permission()]),
        'POST /api/permissions/perm-1': {},
      });
      await user.click(await screen.findByRole('button', { name: 'Deny' }));
      expect(posts(spy, '/api/permissions/perm-1')).toEqual([{ decision: 'deny' }]);
    });

    it('shows the earlier decision once answered', async () => {
      openThread([permission({ answer: { decision: 'deny' }, answeredAt: ANSWERED_AT })]);
      expect(await screen.findByText(/^Denied · \d\d:\d\d$/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Allow' })).toBeDisabled();
    });
  });
});
