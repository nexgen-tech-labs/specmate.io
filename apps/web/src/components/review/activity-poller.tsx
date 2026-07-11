'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// Refreshes the server-rendered feed on an interval so reviewers see each other's
// actions within a few seconds (Issue 4.8) — polling, not websockets, keeps this
// infra-free; the feed itself stays server-rendered from the audit log.
export function ActivityPoller({ intervalMs }: { intervalMs: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(timer);
  }, [router, intervalMs]);
  return null;
}
