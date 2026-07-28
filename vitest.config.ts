import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['src/server/**/*.worker.test.ts'],
    setupFiles: ['./src/test/setup.ts'],
  },
})
