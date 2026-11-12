import { describe, expect, it } from 'vitest';
import { UiCheckReportSchema } from './ui-verification.js';

describe('UI verdicts', () => {
  it('never accepts success without executed scenarios and evidence', () => {
    expect(
      UiCheckReportSchema.safeParse({ status: 'passed', summary: 'ok', scenarios: [] }).success,
    ).toBe(false);
    expect(
      UiCheckReportSchema.safeParse({ status: 'unavailable', summary: 'missing', scenarios: [] })
        .success,
    ).toBe(false);
  });
  it('accepts an explicit infrastructure blocker', () => {
    expect(
      UiCheckReportSchema.safeParse({
        status: 'unavailable',
        summary: 'No browser',
        reason: 'launch failed',
        scenarios: [],
      }).success,
    ).toBe(true);
  });
});
