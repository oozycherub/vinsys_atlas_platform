import path from 'node:path';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Tests import shared packages from source so they never depend on a prior build.
// Exact-match regexes: a plain '@atlas/platform' key would also rewrite '@atlas/platform/testing'.
const alias = [
  {
    find: /^@atlas\/platform$/,
    replacement: path.resolve(__dirname, 'packages/platform/src/index.ts'),
  },
  {
    find: /^@atlas\/platform\/testing$/,
    replacement: path.resolve(__dirname, 'packages/platform/src/testing/index.ts'),
  },
  {
    find: /^@atlas\/contracts$/,
    replacement: path.resolve(__dirname, 'packages/contracts/src/index.ts'),
  },
  {
    find: /^@atlas\/scoring$/,
    replacement: path.resolve(__dirname, 'packages/scoring/src/index.ts'),
  },
];

// SWC emits decorator metadata, which NestJS dependency injection requires (ADR-0003).
const plugins = [swc.vite({ module: { type: 'es6' } })];

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'services/*/src/**/*.ts'],
      exclude: ['**/main.ts', '**/testing/**'],
      thresholds: { 'services/*/src/domain/**': { lines: 90 } },
    },
    projects: [
      {
        plugins,
        resolve: { alias },
        test: {
          name: 'unit',
          include: ['packages/*/test/unit/**/*.test.ts', 'services/*/test/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        plugins,
        resolve: { alias },
        test: {
          name: 'integration',
          include: [
            'packages/*/test/integration/**/*.test.ts',
            'services/*/test/integration/**/*.test.ts',
          ],
          environment: 'node',
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
