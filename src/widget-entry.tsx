/**
 * IIFE entry point — auto-mounts Widget onto the host page.
 *
 * Production (IIFE build):
 *   Reads config from data-* attributes on the <script> tag at load time.
 *   document.currentScript is available synchronously during IIFE execution.
 *
 * Dev (Vite ESM):
 *   document.currentScript is null for type="module" scripts.
 *   Falls back to VITE_DEV_* env vars so the dev server works without data attributes.
 *
 * Embed usage (production):
 *   <script
 *     src="https://cdn.agentsfloor.com/widget/latest/widget.js"
 *     data-org="your-org-id"
 *     data-workflow="your-workflow-id"
 *     data-version="latest"
 *     data-runtime-url="https://your-runtime.run.app"
 *     data-title="AI Assistant"
 *     data-theme="light"
 *   ></script>
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Widget, type WidgetConfig } from './Widget'

// Read synchronously at IIFE evaluation time — must be before any async.
const scriptEl = document.currentScript as HTMLScriptElement | null

function attr(name: string, fallback = ''): string {
  return scriptEl?.getAttribute(`data-${name}`) ?? fallback
}

const isDev = import.meta.env.DEV

const config: WidgetConfig = isDev
  ? {
      org:        import.meta.env.VITE_DEV_ORG        ?? 'dev-org',
      workflow:   import.meta.env.VITE_DEV_WORKFLOW    ?? 'dev-workflow',
      version:    import.meta.env.VITE_DEV_VERSION     ?? 'latest',
      title:      import.meta.env.VITE_DEV_TITLE       ?? 'AI Assistant',
      theme:      (import.meta.env.VITE_DEV_THEME      ?? 'light') as 'light' | 'dark',
      runtimeUrl: (import.meta.env.VITE_DEV_RUNTIME_URL ?? 'http://localhost:8000').replace(/\/$/, ''),
    }
  : {
      org:        attr('org'),
      workflow:   attr('workflow'),
      version:    attr('version', 'latest'),
      title:      attr('title', 'AI Assistant'),
      theme:      attr('theme', 'light') as 'light' | 'dark',
      runtimeUrl: attr('runtime-url').replace(/\/$/, ''),
    }

if (!config.org || !config.workflow || !config.runtimeUrl) {
  console.warn(
    '[AgentsFloor Widget] Missing required data attributes.\n' +
    'Required: data-org, data-workflow, data-runtime-url\n' +
    'Optional: data-version (default: latest), data-title, data-theme (light|dark)'
  )
} else {
  // Avoid double-mounting if script is accidentally included twice
  let container = document.getElementById('agentsfloor-widget-root')
  if (!container) {
    container = document.createElement('div')
    container.id = 'agentsfloor-widget-root'
    document.body.appendChild(container)
  }

  createRoot(container).render(
    <StrictMode>
      <Widget config={config} />
    </StrictMode>
  )
}
