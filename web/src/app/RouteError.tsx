import { useRouteError } from 'react-router';
import { EmptyState } from '../components/EmptyState';

/**
 * A lazy route chunk is named by content hash, so a tab opened before a deploy asks for a file the
 * new build no longer has. The static server answers such a path with `index.html`, and the import
 * fails on the wrong MIME type — the tab is simply stale, and only a reload can fix it.
 */
function isStaleChunk(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('Failed to fetch dynamically imported module') ||
    message.includes('error loading dynamically imported module') ||
    message.includes('Importing a module script failed')
  );
}

export function RouteError() {
  const error = useRouteError();
  const stale = isStaleChunk(error);
  const reload = () => {
    window.location.reload();
  };
  return (
    <EmptyState
      title={stale ? 'This tab is out of date' : 'Something went wrong'}
      description={
        stale
          ? 'Jarvis was updated while this tab was open, so part of the page could not be loaded. Reloading picks up the new version.'
          : error instanceof Error
            ? error.message
            : 'The page could not be shown.'
      }
      action={
        <button type="button" onClick={reload}>
          Reload
        </button>
      }
    />
  );
}
