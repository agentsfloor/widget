/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEV_ORG: string
  readonly VITE_DEV_WORKFLOW: string
  readonly VITE_DEV_VERSION: string
  readonly VITE_DEV_TITLE: string
  readonly VITE_DEV_THEME: string
  readonly VITE_DEV_RUNTIME_URL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
