/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEV_ORG: string
  readonly VITE_DEV_WORKFLOW: string
  readonly VITE_DEV_VERSION: string
  readonly VITE_DEV_TITLE: string
  readonly VITE_DEV_THEME: string
  readonly VITE_DEV_RUNTIME_URL: string
  readonly VITE_DEV_AUTH_TOKEN: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
