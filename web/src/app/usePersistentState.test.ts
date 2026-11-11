import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { usePersistentState } from './usePersistentState';

const asBoolean = (raw: unknown) => (typeof raw === 'boolean' ? raw : undefined);

describe('usePersistentState', () => {
  it('uses the fallback when nothing is stored', () => {
    const { result } = renderHook(() => usePersistentState('k', false, asBoolean));
    expect(result.current[0]).toBe(false);
  });

  it('restores a valid stored value and stores changes', () => {
    window.localStorage.setItem('k', 'true');
    const { result } = renderHook(() => usePersistentState('k', false, asBoolean));
    expect(result.current[0]).toBe(true);
    act(() => result.current[1](false));
    expect(result.current[0]).toBe(false);
    expect(window.localStorage.getItem('k')).toBe('false');
  });

  it('falls back on a value that does not parse or does not validate', () => {
    window.localStorage.setItem('a', '{oops');
    window.localStorage.setItem('b', '"yes"');
    expect(renderHook(() => usePersistentState('a', false, asBoolean)).result.current[0]).toBe(
      false,
    );
    expect(renderHook(() => usePersistentState('b', false, asBoolean)).result.current[0]).toBe(
      false,
    );
  });

  it('keeps working when storage throws', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { result } = renderHook(() => usePersistentState('k', true, asBoolean));
    expect(result.current[0]).toBe(true);
    act(() => result.current[1](false));
    expect(result.current[0]).toBe(false);
    get.mockRestore();
    set.mockRestore();
  });
});
