import type { MetadataRoute } from 'next';

// Explicitly allows AI search/crawl bots (ChatGPT, Perplexity, Claude, Gemini,
// Copilot) alongside general crawlers — blocking one of these means that
// platform can never cite SpecMate. CCBot (Common Crawl, training-only, no
// search citation) is excluded since allowing it has no citation benefit.
// App-scoped routes (workspaces, settings, api, auth) are disallowed since
// they're behind auth and irrelevant to public/AI search anyway.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/workspaces/', '/organizations/', '/settings/', '/api/', '/invite/'],
      },
      { userAgent: 'CCBot', disallow: '/' },
    ],
    sitemap: 'https://www.specmate.io/sitemap.xml',
  };
}
