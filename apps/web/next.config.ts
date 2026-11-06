import type { NextConfig } from 'next';

/**
 * The UI calls only the gateway (Component Prompt 14 §4). In production the edge serves the app
 * and the API on the same tenant host; locally `/v1/*` is rewritten to the gateway.
 */
const gateway = process.env.ATLAS_GATEWAY_URL ?? 'http://localhost:8080';

const config: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ['@atlas/api-clients', '@atlas/proctor-sdk'],
  async rewrites() {
    return [{ source: '/v1/:path*', destination: `${gateway}/v1/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(self), microphone=(self), geolocation=()' },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
        ],
      },
    ];
  },
};

export default config;
