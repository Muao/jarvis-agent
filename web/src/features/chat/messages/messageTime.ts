/**
 * "14:32" for today, "9 Nov, 14:32" for an earlier day, in the viewer's zone; `full` adds
 * seconds and the year for the tooltip.
 */
export function formatMessageTime(
  iso: string,
  now: Date = new Date(),
): { short: string; full: string } {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return { short: iso, full: iso };
  const clock = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const sameDay = date.toDateString() === now.toDateString();
  const day = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const full = date.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  return { short: sameDay ? clock : `${day}, ${clock}`, full };
}
