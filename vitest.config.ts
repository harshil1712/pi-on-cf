import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import agents from 'agents/vite'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    projects: [
      {
        // Browser units under test/unit, mirroring src/.
        extends: true,
        test: {
          name: 'unit',
          environment: 'jsdom',
          include: ['test/unit/**/*.test.{ts,tsx}'],
          setupFiles: ['./test/unit/setup.ts'],
        },
      },
      {
        // Worker code: Durable Objects, Computer, and server modules, in workerd.
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
