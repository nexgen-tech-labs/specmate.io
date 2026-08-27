import type { SourceSummaryItem } from '@/lib/dashboard';

const KIND_GLYPH: Record<string, string> = {
  DOCX: '▤',
  PDF: '▤',
  XLSX: '▦',
  CSV: '▦',
  TXT: '◉',
  TRANSCRIPT: '◉',
  CONFLUENCE: '◆',
  SLACK: '◆',
  JIRA_REF: '◆',
  ADO_REF: '▲',
  GITHUB_REF: '●',
};

const STATUS_COLOR: Record<string, string> = {
  QUEUED: 'text-sub',
  PARSING: 'text-cobalt',
  PARSED: 'text-green',
  FAILED: 'text-red',
};

interface SourcesCardProps {
  recent: SourceSummaryItem[];
  onAddSource: () => void;
  onRemoveSource: (source: SourceSummaryItem) => void;
  removingId?: string | null;
}

export function SourcesCard({
  recent,
  onAddSource,
  onRemoveSource,
  removingId = null,
}: SourcesCardProps) {
  return (
    <section className="rounded-xl border border-line bg-panel p-6">
      <div className="mb-4.5 flex items-center justify-between">
        <div className="font-mono text-xs tracking-[0.06em] text-sub">
          [ SOURCES · CONNECT OR UPLOAD ]
        </div>
        <button
          type="button"
          onClick={onAddSource}
          className="border-none bg-transparent text-sm font-semibold text-cobalt"
        >
          + Add
        </button>
      </div>

      {recent.length > 0 ? (
        <div className="grid grid-cols-2 gap-3">
          {recent.map((source) => (
            <div
              key={source.id}
              className="group relative rounded-[10px] border border-line bg-panel p-4"
            >
              <button
                type="button"
                onClick={() => onRemoveSource(source)}
                disabled={removingId === source.id}
                aria-label={`Remove ${source.name}`}
                title="Remove source"
                className="absolute top-2 right-2 hidden h-5 w-5 items-center justify-center rounded-full border-none bg-paper text-xs leading-none text-sub group-hover:flex hover:text-red disabled:opacity-50"
              >
                {removingId === source.id ? '…' : '✕'}
              </button>
              <div className="mb-3 flex items-center justify-between pr-5">
                <span className="text-sm text-ink">{KIND_GLYPH[source.kind] ?? '▤'}</span>
                <span
                  className={`font-mono text-[11px] tracking-[0.06em] ${STATUS_COLOR[source.status] ?? 'text-sub'}`}
                >
                  {source.status === 'PARSED' ? '✓ DRAFTED' : source.status}
                </span>
              </div>
              <div className="mb-1 text-sm font-bold break-words tracking-tight text-ink">
                {source.name}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <button
          type="button"
          onClick={onAddSource}
          className="w-full rounded-[10px] border-2 border-dashed border-[#d8d5ca] bg-paper px-6 py-11 text-left"
        >
          <div className="mb-1.5 text-sm font-bold text-ink">Drop a source here</div>
          <div className="text-[13px] leading-relaxed text-sub">
            Requirements doc, backlog export, meeting transcript — or pull an existing board from a
            connected tool.
          </div>
        </button>
      )}
    </section>
  );
}
