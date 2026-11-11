import { useEffect, useState } from 'react';

/** Reads a stored value; `null` when storage is missing, blocked or holds nothing. */
function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage full or blocked (private mode): the value simply does not survive a reload.
  }
}

/**
 * UI state that survives a reload, kept in this browser's `localStorage` as JSON.
 * `parse` turns the stored JSON into a valid value or `undefined`; anything else falls back.
 */
export function usePersistentState<T>(
  key: string,
  fallback: T,
  parse: (raw: unknown) => T | undefined,
): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const raw = readStored(key);
    if (raw === null) return fallback;
    try {
      return parse(JSON.parse(raw)) ?? fallback;
    } catch {
      return fallback;
    }
  });

  useEffect(() => {
    writeStored(key, JSON.stringify(value));
  }, [key, value]);

  return [value, setValue];
}
