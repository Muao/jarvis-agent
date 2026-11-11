/** Thread list column width in CSS px: 14rem–32rem, 19rem by default (at a 16 px root size). */
export const THREAD_LIST_WIDTH = { min: 224, max: 512, default: 304 } as const;

export const THREAD_LIST_WIDTH_KEY = 'jarvis.chat.threadListWidth';

export function clampThreadListWidth(width: number): number {
  return Math.round(Math.min(THREAD_LIST_WIDTH.max, Math.max(THREAD_LIST_WIDTH.min, width)));
}

/** A stored width, clamped; anything that is not a finite number is rejected. */
export function parseThreadListWidth(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) ? clampThreadListWidth(raw) : undefined;
}
