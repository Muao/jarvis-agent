import { useEffect, useState } from 'react';

const UNITS: { unit: Intl.RelativeTimeFormatUnit; seconds: number }[] = [
  { unit: 'day', seconds: 86_400 },
  { unit: 'hour', seconds: 3_600 },
  { unit: 'minute', seconds: 60 },
];

const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** "just now", "5 minutes ago", "in 2 hours". Pure so it can be tested with a fixed `now`. */
export function formatRelative(at: Date, now: Date): string {
  const seconds = Math.round((at.getTime() - now.getTime()) / 1000);
  if (Math.abs(seconds) < 45) return 'just now';
  for (const { unit, seconds: size } of UNITS) {
    if (Math.abs(seconds) >= size) return formatter.format(Math.round(seconds / size), unit);
  }
  return formatter.format(Math.round(seconds / 60), 'minute');
}

interface RelativeTimeProps {
  /** ISO 8601 string from the API; the offset in the string decides the instant, never the local zone. */
  at: string;
  /** Test seam; defaults to a clock that ticks every 30 s. */
  now?: Date;
}

export function RelativeTime({ at, now }: RelativeTimeProps) {
  const [tick, setTick] = useState(() => new Date());
  useEffect(() => {
    if (now) return;
    const timer = setInterval(() => setTick(new Date()), 30_000);
    return () => clearInterval(timer);
  }, [now]);

  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return <span>{at}</span>;
  return (
    <time dateTime={date.toISOString()} title={date.toLocaleString()}>
      {formatRelative(date, now ?? tick)}
    </time>
  );
}
