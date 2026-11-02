#!/usr/bin/env node
// Stand-in for the `claude` binary in tests (ADR-0013). Plain Node, no dependencies.
// Plays the scenario named by JARVIS_FAKE_SCENARIO (a JSON file next to this script).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};

const here = dirname(fileURLToPath(import.meta.url));
const scenarioName = process.env.JARVIS_FAKE_SCENARIO ?? 'ok';
// Only the dispatcher is started with --allowedTools (see buildRunArgs).
const role = argv.includes('--allowedTools') ? 'dispatcher' : 'worker';

/**
 * `<name>.<role>.<stage>.json`, then `<name>.<role>.json`, then `<name>.json`. The stage is the
 * `stage:` line of a worker's "Run context" block, lowercased with dashes ("Spec Review" -> spec-review).
 */
function loadScenario(firstMessage) {
  const stage = /^stage: (.+)$/m.exec(firstMessage)?.[1]?.toLowerCase().replaceAll(' ', '-');
  const candidates = [
    ...(stage ? [`${scenarioName}.${role}.${stage}.json`] : []),
    `${scenarioName}.${role}.json`,
    `${scenarioName}.json`,
  ];
  const file = candidates.map((name) => join(here, name)).find((path) => existsSync(path));
  if (!file) throw new Error(`No fake-claude scenario among: ${candidates.join(', ')}`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

const sessionId = flag('--resume') ?? 'fake-session-1';

const out = (value) =>
  process.stdout.write(`${JSON.stringify({ ...value, session_id: sessionId })}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();

/** Text of the next user line on stdin, or undefined once stdin has ended. */
async function nextUserText() {
  const { value, done } = await lines.next();
  if (done) return undefined;
  const message = JSON.parse(value).message;
  return message.content.map((block) => block.text ?? '').join('');
}

/** Calls the Jarvis engine like the MCP server would; credentials come from --mcp-config. */
async function callJarvis(tool, input) {
  const { env } = JSON.parse(readFileSync(flag('--mcp-config'), 'utf8')).mcpServers.jarvis;
  const response = await fetch(`${env.JARVIS_API_URL}/api/agent/tools/${tool}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.JARVIS_RUN_TOKEN}`,
    },
    body: JSON.stringify(input ?? {}),
  });
  return { text: await response.text(), isError: !response.ok };
}

const assistant = (block) =>
  out({
    type: 'assistant',
    message: { role: 'assistant', content: [block] },
    parent_tool_use_id: null,
  });
const toolResult = (id, content, isError = false) =>
  out({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }],
    },
    parent_tool_use_id: null,
  });

let toolCounter = 0;
const steps = {
  init: () => out({ type: 'system', subtype: 'init', model: 'fake', tools: [] }),
  text: (s) => assistant({ type: 'text', text: s.text }),
  thinking: (s) => assistant({ type: 'thinking', thinking: s.text ?? '' }),
  tool_use: (s) => {
    assistant({ type: 'tool_use', id: s.id, name: s.name, input: s.input ?? {} });
    toolResult(s.id, s.output ?? '', s.isError === true);
  },
  jarvis_tool: async (s) => {
    const id = `toolu_fake_${++toolCounter}`;
    assistant({ type: 'tool_use', id, name: `mcp__jarvis__${s.tool}`, input: s.input ?? {} });
    const { text, isError } = await callJarvis(s.tool, s.input);
    toolResult(id, [{ type: 'text', text }], isError);
  },
  /** Waits for the next stdin message and repeats it. */
  echo_stdin: async () => {
    const text = await nextUserText();
    if (text !== undefined) assistant({ type: 'text', text: `echo: ${text}` });
  },
  /** Writes `files` ({ "spec.md": "..." }) into the `artifactsDir` named in the run context, like the real worker. */
  write_artifacts: (s) => {
    const dir = /^artifactsDir: (.+)$/m.exec(first)?.[1];
    if (!dir) throw new Error('write_artifacts needs an "artifactsDir:" line in the first message');
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(s.files)) writeFileSync(join(dir, name), content);
  },
  sleep: (s) => sleep(s.ms),
  stderr: (s) => process.stderr.write(`${s.text}\n`),
  raw: (s) => process.stdout.write(`${s.line}\n`),
  result: (s) =>
    out({
      type: 'result',
      subtype: s.subtype ?? 'success',
      is_error: s.isError ?? (s.subtype !== undefined && s.subtype !== 'success'),
      num_turns: s.turns ?? 1,
      duration_ms: 10,
      total_cost_usd: s.costUsd ?? 0.01,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 1,
      },
      result: s.text ?? 'done',
    }),
};

// Like the real CLI, wait for the first message before doing anything.
const first = await nextUserText();
if (first === undefined) process.exit(0);
const scenario = loadScenario(first);

let crashed = false;
for (const step of scenario.steps) {
  if (step.type === 'exit') {
    process.exitCode = step.code ?? 1;
    crashed = true;
    break;
  }
  const run = steps[step.type];
  if (!run) throw new Error(`Unknown fake-claude step "${step.type}"`);
  await run(step);
}

// Streaming-input mode: the process lives until its stdin ends.
if (crashed) process.stdin.destroy();
else for await (const _ of lines) void _;
