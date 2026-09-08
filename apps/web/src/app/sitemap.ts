import type { MetadataRoute } from 'next';

// Only the public marketing/demo page exists today — everything else under
// /workspaces, /organizations, /settings requires auth and has no business
// being indexed or cited. Extend this as public content (pricing, docs,
// blog) ships.
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: 'https://www.specmate.io',
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 1,
    },
  ];
}
