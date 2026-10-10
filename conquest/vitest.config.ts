import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Component tests opt into jsdom with a `@vitest-environment jsdom` docblock.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
  },
})
