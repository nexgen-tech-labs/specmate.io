import type { IntegrationSummary } from '@/lib/dashboard';

const TOOL_META: Record<string, { label: string; glyph: string }> = {
  jira: { label: 'Jira Cloud', glyph: '◆' },
  ado: { label: 'Azure DevOps', glyph: '▲' },
  github: { label: 'GitHub', glyph: '●' },
};

interface IntegrationsCardProps {
  integrations: IntegrationSummary[];
  onManage: (toolKey: string) => void;
}

export function IntegrationsCard({ integrations, onManage }: IntegrationsCardProps) {
  return (
    <section className="rounded-xl border border-line bg-panel p-5.5">
      <div className="mb-4 flex items-center justify-between">
        <div className="font-mono text-xs tracking-[0.06em] text-sub">[ INTEGRATIONS ]</div>
        <span className="font-mono text-[11px] text-[#8a919c]">ORG AUTH</span>
      </div>
      <ul className="flex flex-col gap-2.5">
        {integrations.map((integration) => {
          const meta = TOOL_META[integration.toolKey] ?? { label: integration.toolKey, glyph: '◆' };
          return (
            <li
              key={integration.toolKey}
              className={`flex items-center justify-between gap-3 rounded-[9px] border px-3.5 py-3 ${
                integration.connected ? 'border-[#d5dcfb] bg-[#f7f9ff]' : 'border-line bg-paper'
              }`}
            >
              <div className="flex min-w-0 items-center gap-2.5">
                <span
                  className={`text-sm ${integration.connected ? 'text-cobalt' : 'text-[#8a919c]'}`}
                >
                  {meta.glyph}
                </span>
                <div className="min-w-0">
                  <div className="text-sm font-bold tracking-tight text-ink">{meta.label}</div>
                  <div
                    className={`mt-0.5 overflow-hidden font-mono text-[11px] text-ellipsis whitespace-nowrap ${
                      integration.connected ? 'text-green' : 'text-[#8a919c]'
                    }`}
                  >
                    {integration.connected
                      ? (integration.scopeLabel ?? 'Connected')
                      : 'Not connected'}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => onManage(integration.toolKey)}
                className={`border-none bg-transparent font-mono text-[11px] font-semibold whitespace-nowrap ${
                  integration.connected ? 'text-sub' : 'text-cobalt'
                }`}
              >
                {integration.connected ? 'MANAGE' : 'CONNECT'}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
