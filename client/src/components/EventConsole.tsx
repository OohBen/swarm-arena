import { useEffect, useRef } from 'react';
import { clockTime, EVENT_TONE } from '../lib/format';

export function EventConsole({ events }: any) {
  const ref = useRef<HTMLDivElement>(null);
  const sorted = [...events].sort((a: any, b: any) => Number(a.id - b.id));
  const recent = sorted.slice(-120);

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [events.length]);

  return (
    <div className="panel console">
      <div className="panel-h">
        <span className="micro">Mission Log · SpacetimeDB</span>
        <span className="micro">{events.length} events</span>
      </div>
      <div className="panel-b log" ref={ref}>
        {recent.length === 0 && <div className="empty-hint">Awaiting swarm activity…</div>}
        {recent.map((e: any) => {
          const tone = EVENT_TONE[e.kind] ?? 'sys';
          return (
            <div className="log-row" key={String(e.id)}>
              <span className="t">{clockTime(e.createdAt)}</span>
              <span className={`k ${tone}`}>{e.kind}</span>
              <span className="m">{e.message}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
