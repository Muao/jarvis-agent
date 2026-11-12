import { z } from 'zod';

/** Human UI actions only; arbitrary page JavaScript is deliberately absent. */
export const UI_BROWSER_TOOLS = [
  'browser_navigate',
  'browser_navigate_back',
  'browser_snapshot',
  'browser_take_screenshot',
  'browser_click',
  'browser_type',
  'browser_fill_form',
  'browser_press_key',
  'browser_hover',
  'browser_select_option',
  'browser_drag',
  'browser_drop',
  'browser_find',
  'browser_wait_for',
  'browser_resize',
  'browser_console_messages',
  'browser_network_requests',
  'browser_network_request',
  'browser_handle_dialog',
  'browser_tabs',
  'browser_close',
  'browser_emulate_media',
  'browser_file_upload',
] as const;

const text = z.string().trim().min(1).max(2000);
const evidence = z
  .string()
  .min(1)
  .max(300)
  .refine(
    (path) => !path.startsWith('/') && !path.includes('\\') && !path.split('/').includes('..'),
    'evidence must be relative to task artifacts',
  );

export const UiCheckReportSchema = z
  .strictObject({
    checkId: z.string().min(1).max(100).optional(),
    status: z.enum(['passed', 'failed', 'unavailable']),
    summary: text,
    reason: text.optional(),
    scenarios: z
      .array(
        z.strictObject({
          criterion: text,
          expected: text,
          observed: text,
          status: z.enum(['passed', 'failed']),
          evidence: z.array(evidence).max(10),
        }),
      )
      .max(30),
  })
  .superRefine((report, ctx) => {
    const invalid =
      report.status === 'unavailable'
        ? !report.reason
        : !report.checkId || report.scenarios.length === 0;
    if (invalid)
      ctx.addIssue({
        code: 'custom',
        message: 'Executed checks need checkId/scenarios; unavailable needs reason',
      });
    if (
      report.status === 'passed' &&
      report.scenarios.some((s) => s.status !== 'passed' || s.evidence.length === 0)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Passing requires evidence for every passing scenario',
      });
    }
    if (report.status === 'failed' && !report.scenarios.some((s) => s.status === 'failed')) {
      ctx.addIssue({ code: 'custom', message: 'Failed requires a failed scenario' });
    }
  });

export type UiCheckReport = z.infer<typeof UiCheckReportSchema>;
