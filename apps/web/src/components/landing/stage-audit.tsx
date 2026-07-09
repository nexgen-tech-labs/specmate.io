import { AUDIT_ROWS } from './demo-data';
import { Eyebrow, Mono } from './demo-ui';

const SUMMARY_STATS: [string, string][] = [
  ['7', 'items published, fully traced'],
  ['1', 'duplicate blocked before Jira'],
  ['1', 'gap caught pre-sprint'],
  ['~6h', 'BA time saved this project'],
];

export function StageAudit() {
  return (
    <section className="landing-rise">
      <Eyebrow>AUDIT TRAIL · WHO APPROVED WHAT, WHEN, FROM WHICH SOURCE</Eyebrow>
      <div className="overflow-hidden rounded-lg border border-line bg-panel">
        {AUDIT_ROWS.map((r, i) => (
          <div
            key={r.t + r.who}
            className="landing-rise grid grid-cols-[110px_160px_1fr] gap-3 border-b border-line px-5 py-4 last:border-b-0"
            style={{ animationDelay: `${i * 0.12}s` }}
          >
            <Mono className="text-sub">{r.t}</Mono>
            <Mono
              className={`font-semibold ${
                r.who === 'system'
                  ? 'text-sub'
                  : r.who.includes('ai')
                    ? 'text-cobalt'
                    : 'text-green'
              }`}
            >
              {r.who}
            </Mono>
            <span className="text-base">{r.what}</span>
          </div>
        ))}
      </div>
      <div className="mt-5 grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4">
        {SUMMARY_STATS.map(([n, l]) => (
          <div key={l} className="rounded-lg border border-line bg-panel p-5">
            <div className="font-mono text-4xl font-bold tracking-tight text-cobalt">{n}</div>
            <div className="mt-1.5 text-sm text-sub">{l}</div>
          </div>
        ))}
      </div>
      <div className="mt-5 rounded-lg border border-dashed border-line p-4">
        <Mono className="text-sub">
          MAINTAIN · when Client-Requirements-v4.docx lands, SpecMate diffs it, re-drafts only
          changed items, and routes just those back through review — the backlog never silently
          drifts from the spec.
        </Mono>
      </div>
    </section>
  );
}
