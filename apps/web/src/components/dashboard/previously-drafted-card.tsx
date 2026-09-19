import Link from 'next/link';
import type { PreviouslyDraftedProject } from '@/lib/dashboard';

interface PreviouslyDraftedCardProps {
  workspaceId: string;
  projects: PreviouslyDraftedProject[];
}

export function PreviouslyDraftedCard({ workspaceId, projects }: PreviouslyDraftedCardProps) {
  return (
    <section
      className={`rounded-xl border p-6 ${projects.length > 0 ? 'border-line bg-panel' : 'border-[#eeece4] bg-[#fdfdfa]'}`}
    >
      <div className="mb-4 font-mono text-xs tracking-[0.06em] text-sub">
        [ PREVIOUSLY DRAFTED ISSUES ]
      </div>
      {projects.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {projects.map((project, i) => (
            <li
              key={project.projectId}
              className={`flex items-center justify-between gap-4 ${
                i < projects.length - 1 ? 'border-b border-[#f0eee6] pb-3' : ''
              }`}
            >
              <div>
                <div className="text-sm font-semibold text-ink">{project.projectName}</div>
                <div className="mt-0.5 font-mono text-xs text-[#8a919c]">
                  {project.count} item{project.count === 1 ? '' : 's'} from earlier generation runs
                </div>
              </div>
              <Link
                href={`/workspaces/${workspaceId}/projects/${project.projectId}/review`}
                className="font-mono text-xs whitespace-nowrap text-cobalt underline-offset-2 hover:underline"
              >
                Review →
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm leading-relaxed text-[#8a919c]">
          Items from a superseded generation run will appear here once a project has more than one
          run.
        </p>
      )}
    </section>
  );
}
