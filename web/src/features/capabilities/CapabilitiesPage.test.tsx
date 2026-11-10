import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { Capabilities } from '@jarvis/shared';
import { FakeEventSource } from '../../test/FakeEventSource';
import { stubFetch } from '../../test/fakeFetch';
import { renderWithProviders } from '../../test/renderWithProviders';
import { CapabilitiesPage } from './CapabilitiesPage';

const data: Capabilities = {
  skills: [
    { name: 'sdd-flow', description: 'Artifact contract', source: 'builtin', editable: false },
    { name: 'release-notes', description: 'Write notes', source: 'owner', editable: true },
    { name: 'deploy', description: 'Ships it', source: 'repo', repo: 'acme/blog', editable: false },
  ],
  agents: [
    {
      name: 'reviewer',
      description: 'Reviews a diff',
      source: 'builtin',
      model: 'sonnet',
      tools: ['Read', 'Grep'],
      editable: false,
    },
  ],
  mcpServers: [
    {
      name: 'jarvis',
      source: 'builtin',
      roles: ['dispatcher', 'worker', 'ui_check'],
      transport: 'stdio',
      command: 'node',
      args: ['main.ts'],
      envVars: ['JARVIS_RUN_TOKEN'],
    },
    {
      name: 'notion',
      source: 'connector',
      roles: ['worker', 'ui_check'],
      transport: 'http',
      url: 'https://mcp.example.com/v1',
      envVars: ['NOTION_TOKEN'],
    },
  ],
};

function renderPage(routes: Parameters<typeof stubFetch>[0] = {}) {
  const spy = stubFetch({ 'GET /api/capabilities': data, ...routes });
  renderWithProviders(<CapabilitiesPage />);
  FakeEventSource.current.open();
  return spy;
}

const bodiesOf = (spy: ReturnType<typeof stubFetch>, method: string) =>
  spy.mock.calls
    .filter(([, init]) => init?.method === method)
    .map(([url, init]) => [String(url), JSON.parse(String(init?.body ?? 'null'))]);

describe('CapabilitiesPage', () => {
  it('lists skills, subagents and MCP servers with source badges', async () => {
    renderPage();

    const skills = await screen.findByRole('region', { name: 'Skills' });
    expect(
      within(within(skills).getByRole('listitem', { name: 'sdd-flow' })).getByText('Built-in'),
    ).toBeInTheDocument();
    expect(
      within(within(skills).getByRole('listitem', { name: 'release-notes' })).getByText('Yours'),
    ).toBeInTheDocument();
    expect(
      within(within(skills).getByRole('listitem', { name: 'deploy' })).getByText('Repo acme/blog'),
    ).toBeInTheDocument();

    const agent = within(screen.getByRole('region', { name: 'Subagents' })).getByRole('listitem', {
      name: 'reviewer',
    });
    expect(within(agent).getByText(/Model: sonnet · Tools: Read, Grep/)).toBeInTheDocument();

    const mcp = screen.getByRole('region', { name: 'MCP servers' });
    const jarvis = within(mcp).getByRole('listitem', { name: 'jarvis' });
    expect(
      within(jarvis).getByText(/Roles: dispatcher, worker, ui_check · Transport: stdio/),
    ).toBeInTheDocument();
    expect(within(jarvis).getByText(/JARVIS_RUN_TOKEN/)).toBeInTheDocument();
    expect(
      within(within(mcp).getByRole('listitem', { name: 'notion' })).getByText(
        'https://mcp.example.com/v1',
      ),
    ).toBeInTheDocument();
    expect(within(mcp).getByText('Connector')).toBeInTheDocument();
  });

  it('offers Edit and Delete only on the owner’s own items', async () => {
    renderPage();
    await screen.findByRole('region', { name: 'Skills' });

    const rows = screen.getAllByRole('listitem');
    for (const row of rows) {
      const owned = row.getAttribute('aria-label') === 'release-notes';
      expect(within(row).queryByRole('button', { name: /^Edit/ }) !== null).toBe(owned);
      expect(within(row).queryByRole('button', { name: /^Delete/ }) !== null).toBe(owned);
    }
  });

  it('creates a skill and sends only description and body', async () => {
    const created = { name: 'my-skill', description: 'Does x', body: 'Steps', markdown: '' };
    const spy = renderPage({ 'PUT /api/capabilities/owner/skills/my-skill': created });
    await screen.findByRole('region', { name: 'Skills' });

    await userEvent.click(screen.getByRole('button', { name: 'New skill' }));
    const form = screen.getByRole('form', { name: 'New skill' });
    expect(within(form).queryByLabelText('Model')).not.toBeInTheDocument();
    await userEvent.type(within(form).getByLabelText('Name'), 'my-skill');
    await userEvent.type(within(form).getByLabelText('Description'), 'Does x');
    await userEvent.type(within(form).getByLabelText('Instructions (markdown)'), 'Steps');
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(bodiesOf(spy, 'PUT')).toHaveLength(1));
    expect(bodiesOf(spy, 'PUT')[0]).toEqual([
      '/api/capabilities/owner/skills/my-skill',
      { description: 'Does x', body: 'Steps' },
    ]);
    await waitFor(() => expect(screen.queryByRole('form')).not.toBeInTheDocument());
  });

  it('creates a subagent with model and tools', async () => {
    const spy = renderPage({
      'PUT /api/capabilities/owner/agents/helper': {
        name: 'helper',
        description: 'Helps',
        body: '',
        markdown: '',
      },
    });
    await screen.findByRole('region', { name: 'Skills' });

    await userEvent.click(screen.getByRole('button', { name: 'New subagent' }));
    const form = screen.getByRole('form', { name: 'New subagent' });
    await userEvent.type(within(form).getByLabelText('Name'), 'helper');
    await userEvent.type(within(form).getByLabelText('Description'), 'Helps');
    await userEvent.selectOptions(within(form).getByLabelText('Model'), 'opus');
    await userEvent.type(within(form).getByLabelText('Tools'), 'Read, Grep');
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(bodiesOf(spy, 'PUT')).toHaveLength(1));
    expect(bodiesOf(spy, 'PUT')[0]?.[1]).toEqual({
      description: 'Helps',
      body: '',
      tools: ['Read', 'Grep'],
      model: 'opus',
    });
  });

  it('shows the API’s validation errors inline, next to the field', async () => {
    renderPage({
      'PUT /api/capabilities/owner/skills/x': {
        status: 400,
        body: {
          code: 'validation_failed',
          message: 'Request validation failed',
          details: [{ path: 'description', message: 'must be a single line' }],
        },
      },
    });
    await screen.findByRole('region', { name: 'Skills' });

    await userEvent.click(screen.getByRole('button', { name: 'New skill' }));
    const form = screen.getByRole('form', { name: 'New skill' });
    await userEvent.type(within(form).getByLabelText('Name'), 'x');
    await userEvent.type(within(form).getByLabelText('Description'), 'd');
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));

    expect(await within(form).findByText('must be a single line')).toBeInTheDocument();
    expect(within(form).getByLabelText('Description')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('form')).toBeInTheDocument();
  });

  it('shows the built-in name refusal under the name', async () => {
    renderPage({
      'PUT /api/capabilities/owner/skills/sdd-flow': {
        status: 400,
        body: {
          code: 'invalid_input',
          message: '"sdd-flow" is a built-in skill; pick another name.',
        },
      },
    });
    await screen.findByRole('region', { name: 'Skills' });

    await userEvent.click(screen.getByRole('button', { name: 'New skill' }));
    const form = screen.getByRole('form', { name: 'New skill' });
    await userEvent.type(within(form).getByLabelText('Name'), 'sdd-flow');
    await userEvent.type(within(form).getByLabelText('Description'), 'd');
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));

    expect(await within(form).findByText(/is a built-in skill/)).toBeInTheDocument();
    expect(within(form).getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true');
  });

  it('edits an owner item: loads the file, keeps the name fixed, saves', async () => {
    const spy = renderPage({
      'GET /api/capabilities/owner/skills/release-notes': {
        name: 'release-notes',
        description: 'Write notes',
        body: 'Old steps\n',
        markdown: '',
      },
      'PUT /api/capabilities/owner/skills/release-notes': {
        name: 'release-notes',
        description: 'Write notes',
        body: 'New',
        markdown: '',
      },
    });
    const row = await screen.findByRole('listitem', { name: 'release-notes' });

    await userEvent.click(within(row).getByRole('button', { name: /^Edit/ }));
    const form = await screen.findByRole('form', { name: 'Edit skill' });
    expect(within(form).getByLabelText('Name')).toHaveValue('release-notes');
    expect(within(form).getByLabelText('Name')).toHaveAttribute('readonly');
    const body = within(form).getByLabelText('Instructions (markdown)');
    expect(body).toHaveValue('Old steps\n');
    await userEvent.clear(body);
    await userEvent.type(body, 'New');
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(bodiesOf(spy, 'PUT')).toHaveLength(1));
    expect(bodiesOf(spy, 'PUT')[0]).toEqual([
      '/api/capabilities/owner/skills/release-notes',
      { description: 'Write notes', body: 'New' },
    ]);
  });

  it('deletes only after the confirmation', async () => {
    const spy = renderPage({ 'DELETE /api/capabilities/owner/skills/release-notes': { ok: true } });
    const row = await screen.findByRole('listitem', { name: 'release-notes' });

    await userEvent.click(within(row).getByRole('button', { name: /^Delete/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Delete skill release-notes\?/)).toBeInTheDocument();
    expect(bodiesOf(spy, 'DELETE')).toHaveLength(0);

    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(bodiesOf(spy, 'DELETE')).toHaveLength(1));
    expect(bodiesOf(spy, 'DELETE')[0]?.[0]).toBe('/api/capabilities/owner/skills/release-notes');
  });

  it('cancelling the confirmation deletes nothing', async () => {
    const spy = renderPage();
    const row = await screen.findByRole('listitem', { name: 'release-notes' });

    await userEvent.click(within(row).getByRole('button', { name: /^Delete/ }));
    await userEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }),
    );

    expect(bodiesOf(spy, 'DELETE')).toHaveLength(0);
  });

  it('shows an error block with a retry when the list cannot be loaded', async () => {
    stubFetch({
      'GET /api/capabilities': { status: 500, body: { code: 'internal', message: 'boom' } },
    });
    renderWithProviders(<CapabilitiesPage />);

    expect(await screen.findByText('Could not load capabilities')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
