import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Required for the Docker image deployed to Azure Container Apps
  output: 'standalone',
  // Pin the monorepo root explicitly — otherwise Turbopack can misdetect it
  // if a stray lockfile exists higher up the filesystem tree.
  turbopack: {
    root: path.join(__dirname, '../..'),
  },
};

export default nextConfig;
