/** A run-scoped browser adapter. Only the application may open it against a leased environment. */
export interface UiBrowser {
  call(input: {
    runId: string;
    outputDir: string;
    tool: string;
    arguments: Record<string, unknown>;
  }): Promise<{
    readonly content: readonly unknown[];
    readonly evidence?: readonly string[];
    readonly isError?: boolean;
  }>;
  close(runId: string): Promise<void>;
}
