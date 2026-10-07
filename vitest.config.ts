import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import agents from 'agents/vite'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    projects: [
      {
        // Browser-side units, colocated with the code under src/.
        extends: true,
        test: {
          name: 'unit',
          environment: 'jsdom',
          include: ['src/**/*.test.{ts,tsx}'],
          setupFiles: ['./test/setup.ts'],
        },
      },
      {
        // Durable Objects and Computer, in workerd.
        extends: true,
        plugins: [
          agents(),
          cloudflareTest({
            main: './test/worker/entry.ts',
            wrangler: { configPath: './test/worker/wrangler.jsonc' },
          }),
        ],
        test: {
          name: 'worker',
          include: ['test/worker/**/*.test.ts'],
          testTimeout: 30_000,
        },
      },
    ],
  },
})
