import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import agents from 'agents/vite'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    agents(),
    cloudflareTest({
      main: './src/server-test-entry.ts',
      wrangler: { configPath: './wrangler.test.jsonc' },
    }),
  ],
  test: {
    include: ['src/server/**/*.worker.test.ts'],
    testTimeout: 30_000,
  },
})
