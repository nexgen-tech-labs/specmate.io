'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

// Every nested workspace page (teams, settings, exports, audit, activity...)
// links "back" one level at most, and none of them — nor the root AppHeader —
// ever link to the workspace dashboard itself, leaving no way back to it
// short of the browser's back button. This renders one persistent link on
// every workspace-scoped page except the dashboard itself (where it would be
// redundant with the page's own heading).
export function WorkspaceBreadcrumb({ workspaceId }: { workspaceId: string }) {
  const pathname = usePathname();
  if (pathname === `/workspaces/${workspaceId}`) return null;

  return (
    <div className="border-b border-line bg-paper px-6 py-2.5">
      <div className="mx-auto max-w-[1120px]">
        <Link
          href={`/workspaces/${workspaceId}`}
          className="text-sm text-cobalt underline-offset-2 hover:underline"
        >
          ← Back to dashboard
        </Link>
      </div>
    </div>
  );
}
