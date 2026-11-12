import { CodexModelChoiceSchema, type CodexModelChoice } from '@jarvis/shared';
import { connectCodexAppServer } from './app-server-connection.js';
import { encodeCodexMessage } from './app-server-protocol.js';

interface ModelPage {
  id?: number;
  result?: {
    data: { model: string; displayName: string; isDefault: boolean; hidden: boolean }[];
    nextCursor: string | null;
  };
}

export async function listCodexModels(
  binary: string,
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<CodexModelChoice[]> {
  const signal = AbortSignal.timeout(8000);
  const { process, lines } = await connectCodexAppServer(binary, { ...options, signal });
  const choices = new Map<string, CodexModelChoice>();
  const request = (cursor?: string) =>
    process.stdin.write(encodeCodexMessage({ id: 2, method: 'model/list', params: { cursor } }));

  try {
    request();
    for await (const line of lines) {
      const response = JSON.parse(line) as ModelPage | null;
      if (response?.id !== 2) continue;
      if (!response.result) throw new Error('Codex rejected model/list.');
      for (const model of response.result.data) {
        if (model.hidden) continue;
        const choice = CodexModelChoiceSchema.safeParse({
          id: `codex:${model.model}`,
          label: model.displayName,
          isDefault: model.isDefault,
        });
        if (choice.success) choices.set(choice.data.id, choice.data);
      }
      if (!response.result.nextCursor) return [...choices.values()];
      request(response.result.nextCursor);
    }
    throw new Error('Codex exited before returning its model list.');
  } finally {
    process.stdin.end();
  }
}
