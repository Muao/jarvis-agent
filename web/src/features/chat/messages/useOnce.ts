import { useRef } from 'react';
import type { UseMutationResult } from '@tanstack/react-query';

/**
 * One answer per card: the first call goes out, later ones are ignored until it fails.
 * `sent` stays true after success so the card remains inactive while the refreshed message arrives.
 */
export function useOnce<V>(mutation: UseMutationResult<void, Error, V>) {
  const used = useRef(false);
  const submit = (variables: V) => {
    if (used.current) return;
    used.current = true;
    mutation.mutate(variables, {
      onError: () => {
        used.current = false;
      },
    });
  };
  return {
    submit,
    sent: mutation.isPending || mutation.isSuccess,
    error: mutation.error,
  };
}
