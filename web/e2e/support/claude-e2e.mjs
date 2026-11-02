#!/usr/bin/env node
// The `claude` binary of the e2e engine (ADR-0013). The engine hands a child only a few variables, so it
// cannot select a fake scenario through the environment. This wrapper reads the first stdin line, picks the
// scenario from it, and replays the line to the real fake: a dispatcher message that starts with
// "What does" is a knowledge question, everything else follows the full flow.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const FAKE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../engine/test/fake-claude/fake-claude.mjs',
);
const QUESTION = /what does/i;

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const lines = input[Symbol.asyncIterator]();
const { value: first, done } = await lines.next();
if (done) process.exit(0);

const dispatcher = process.argv.includes('--allowedTools');
const scenario = dispatcher && QUESTION.test(first) ? 'e2e-knowledge' : 'e2e';

const child = spawn(process.execPath, [FAKE, ...process.argv.slice(2)], {
  env: { ...process.env, JARVIS_FAKE_SCENARIO: scenario },
  stdio: ['pipe', 'inherit', 'inherit'],
});
child.stdin.write(`${first}\n`);
void (async () => {
  for await (const line of lines) child.stdin.write(`${line}\n`);
  child.stdin.end();
})();
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => {
  if (signal === null) process.exit(code ?? 0);
  process.kill(process.pid, signal);
});
