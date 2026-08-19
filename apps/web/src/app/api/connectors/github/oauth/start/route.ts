import { proxyOAuthStart } from '@/lib/oauth-start-proxy';

export async function GET(request: Request) {
  return proxyOAuthStart(request, 'github');
}
