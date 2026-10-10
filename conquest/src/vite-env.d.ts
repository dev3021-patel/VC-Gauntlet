/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BACKEND_URL?: string
}

// VITE_BACKEND_PROXY is read only by vite.config.ts (dev-server proxy target).
