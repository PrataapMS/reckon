import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/**/test/**/*.test.ts', 'apps/api/test/**/*.test.ts', 'apps/jobs/test/**/*.test.ts'],
          exclude: ['**/*.contract.test.ts', '**/*.integration.test.ts', 'packages/db/test/**', '**/node_modules/**'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['packages/**/test/**/*.integration.test.ts', 'apps/**/test/**/*.integration.test.ts', 'packages/db/test/**/*.test.ts'],
          environment: 'node',
          testTimeout: 20_000,
        },
      },
      {
        test: {
          name: 'contracts',
          include: ['packages/**/test/**/*.contract.test.ts'],
          environment: 'node',
          testTimeout: 20_000,
        },
      },
    ],
  },
});
