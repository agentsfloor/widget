/**
 * AgentsFloor Embeddable Chat Widget
 *
 * AG-UI SSE protocol:
 *   1. Open EventSource GET /v1/{org}/{workflow}/trace?session_id={traceId}
 *   2. POST /v1/{org}/{workflow}/{version} with X-Session-ID + X-Trace-Session headers
 *   3. Consume AG-UI events (those with SSE `event:` line): TextMessageContent, RunFinished, RunError
 *   4. Canvas trace events (no `event:` line) are silently ignored by EventSource named listeners
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { A2UIRenderer, type A2UIPayload } from './A2UIRenderer'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WidgetConfig {
  org: string
  workflow: string
  version: string
  title: string
  theme: 'light' | 'dark'
  runtimeUrl: string
  /** Optional JWT signed with widget_auth_jwt_secret. Sent as Authorization: Bearer {token}. */
  authToken?: string
}

interface Msg {
  id: string
  role: 'user' | 'assistant'
  content: string
  streaming: boolean
  error: boolean
  /** A2UI component blocks rendered below text content. Appended by A2UIContent SSE events. */
  a2uiBlocks?: A2UIPayload[]
}

// ── Session ID ────────────────────────────────────────────────────────────────
// Persists per browser tab — drives LangGraph thread continuity (X-Session-ID)

function getSessionId(): string {
  const KEY = '__agf_sid'
  try {
    let id = sessionStorage.getItem(KEY)
    if (!id) {
      id = crypto.randomUUID()
      sessionStorage.setItem(KEY, id)
    }
    return id
  } catch {
    return crypto.randomUUID()
  }
}

// ── Styles ────────────────────────────────────────────────────────────────────
// Injected as a <style> tag so the widget is self-contained regardless of host CSS

const WIDGET_CSS = `
#agf-root * { box-sizing: border-box; margin: 0; padding: 0; }
#agf-root { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }

.agf-btn {
  position: fixed;
  bottom: 24px;
  right: 24px;
  z-index: 99999;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: #6366f1;
  color: #ffffff;
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4px 24px rgba(99,102,241,0.45);
  transition: transform 0.18s ease, box-shadow 0.18s ease;
}
.agf-btn:hover {
  transform: scale(1.08);
  box-shadow: 0 6px 28px rgba(99,102,241,0.55);
}
.agf-btn:active { transform: scale(0.97); }

.agf-panel {
  position: fixed;
  bottom: 92px;
  right: 24px;
  z-index: 99998;
  width: 380px;
  height: 540px;
  border-radius: 16px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  background: #ffffff;
  color: #18181b;
  box-shadow: 0 8px 48px rgba(0,0,0,0.16), 0 0 0 1px rgba(0,0,0,0.06);
  animation: agf-slide 0.2s ease;
}
.agf-panel.dark {
  background: #18181b;
  color: #f4f4f5;
  box-shadow: 0 8px 48px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.06);
}
@keyframes agf-slide {
  from { opacity: 0; transform: translateY(10px) scale(0.98); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}

.agf-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  background: #6366f1;
  color: #ffffff;
  flex-shrink: 0;
}
.agf-header-title {
  font-size: 14px;
  font-weight: 700;
  letter-spacing: -0.01em;
}
.agf-header-close {
  background: none;
  border: none;
  cursor: pointer;
  color: rgba(255,255,255,0.75);
  padding: 4px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  transition: color 0.15s;
  line-height: 1;
}
.agf-header-close:hover { color: #ffffff; }

.agf-messages {
  flex: 1;
  overflow-y: auto;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  scrollbar-width: thin;
  scrollbar-color: rgba(0,0,0,0.12) transparent;
}
.agf-panel.dark .agf-messages {
  scrollbar-color: rgba(255,255,255,0.12) transparent;
}

.agf-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
.agf-empty-text {
  font-size: 12px;
  color: #a1a1aa;
  text-align: center;
  line-height: 1.6;
}

.agf-msg {
  display: flex;
  flex-direction: column;
  max-width: 82%;
}
.agf-msg.user { align-self: flex-end; align-items: flex-end; }
.agf-msg.assistant { align-self: flex-start; align-items: flex-start; }

.agf-bubble {
  padding: 9px 13px;
  border-radius: 16px;
  font-size: 13px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}
.agf-msg.user .agf-bubble {
  background: #6366f1;
  color: #ffffff;
  border-bottom-right-radius: 4px;
}
.agf-msg.assistant .agf-bubble {
  background: #f4f4f5;
  color: #18181b;
  border-bottom-left-radius: 4px;
}
.agf-panel.dark .agf-msg.assistant .agf-bubble {
  background: #27272a;
  color: #f4f4f5;
}
.agf-msg.assistant.error .agf-bubble {
  background: #fef2f2;
  color: #dc2626;
  border-bottom-left-radius: 4px;
}
.agf-panel.dark .agf-msg.assistant.error .agf-bubble {
  background: #450a0a;
  color: #fca5a5;
}

.agf-cursor {
  display: inline-block;
  width: 2px;
  height: 13px;
  margin-left: 2px;
  vertical-align: text-bottom;
  background: currentColor;
  border-radius: 1px;
  opacity: 0.65;
  animation: agf-blink 0.85s ease-in-out infinite;
}
@keyframes agf-blink {
  0%, 100% { opacity: 0.65; }
  50%       { opacity: 0; }
}

.agf-footer {
  display: flex;
  gap: 8px;
  align-items: flex-end;
  padding: 10px 14px 14px;
  border-top: 1px solid rgba(0,0,0,0.07);
  background: inherit;
  flex-shrink: 0;
}
.agf-panel.dark .agf-footer { border-color: rgba(255,255,255,0.07); }

.agf-input {
  flex: 1;
  resize: none;
  border-radius: 12px;
  font-size: 13px;
  padding: 9px 13px;
  line-height: 1.45;
  max-height: 120px;
  outline: none;
  border: 1.5px solid rgba(0,0,0,0.12);
  background: #fafafa;
  color: #18181b;
  font-family: inherit;
  transition: border-color 0.15s;
  overflow-y: auto;
}
.agf-input:focus { border-color: #6366f1; }
.agf-input:disabled { opacity: 0.5; cursor: not-allowed; }
.agf-panel.dark .agf-input {
  background: #27272a;
  color: #f4f4f5;
  border-color: rgba(255,255,255,0.12);
}
.agf-panel.dark .agf-input:focus { border-color: #818cf8; }

.agf-send {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  border: none;
  cursor: pointer;
  background: #6366f1;
  color: #ffffff;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: background 0.15s, opacity 0.15s;
}
.agf-send:hover:not(:disabled) { background: #4f46e5; }
.agf-send:disabled { opacity: 0.38; cursor: not-allowed; }

/* ── A2UI component styles ──────────────────────────────────────────────── */
.agf-a2ui { max-width: 100%; margin-top: 6px; font-size: 12px; }
.agf-a2ui-title {
  font-size: 11px; font-weight: 700; padding: 0 0 4px;
  color: #6366f1; letter-spacing: 0.01em;
}
/* card */
.agf-card {
  background: #f9f9fb; border: 1px solid rgba(0,0,0,0.08);
  border-radius: 10px; padding: 10px 12px;
}
.agf-panel.dark .agf-card { background: #1c1c20; border-color: rgba(255,255,255,0.08); }
.agf-card-field {
  display: flex; gap: 8px; padding: 3px 0;
  border-bottom: 1px solid rgba(0,0,0,0.05);
}
.agf-card-field:last-child { border-bottom: none; }
.agf-panel.dark .agf-card-field { border-color: rgba(255,255,255,0.05); }
.agf-card-label { color: #71717a; min-width: 80px; font-size: 11px; font-weight: 600; flex-shrink: 0; }
.agf-card-value { color: inherit; font-size: 12px; word-break: break-word; }
/* table */
.agf-table-wrap {
  overflow-x: auto; border-radius: 10px;
  border: 1px solid rgba(0,0,0,0.08);
}
.agf-panel.dark .agf-table-wrap { border-color: rgba(255,255,255,0.08); }
.agf-table { width: 100%; border-collapse: collapse; font-size: 11px; }
.agf-table th {
  background: #f4f4f5; padding: 6px 10px; text-align: left;
  font-weight: 700; color: #52525b;
  border-bottom: 1px solid rgba(0,0,0,0.08);
}
.agf-panel.dark .agf-table th {
  background: #27272a; color: #a1a1aa; border-color: rgba(255,255,255,0.08);
}
.agf-table td { padding: 5px 10px; border-bottom: 1px solid rgba(0,0,0,0.05); color: inherit; }
.agf-panel.dark .agf-table td { border-color: rgba(255,255,255,0.05); }
.agf-table tr:last-child td { border-bottom: none; }
/* list */
.agf-list {
  background: #f9f9fb; border: 1px solid rgba(0,0,0,0.08);
  border-radius: 10px; padding: 10px 12px;
}
.agf-panel.dark .agf-list { background: #1c1c20; border-color: rgba(255,255,255,0.08); }
.agf-list-item { display: flex; gap: 8px; align-items: flex-start; padding: 3px 0; font-size: 12px; }
.agf-list-bullet { color: #6366f1; flex-shrink: 0; font-size: 11px; padding-top: 1px; min-width: 14px; }
/* timeline */
.agf-timeline {
  background: #f9f9fb; border: 1px solid rgba(0,0,0,0.08);
  border-radius: 10px; padding: 10px 12px;
}
.agf-panel.dark .agf-timeline { background: #1c1c20; border-color: rgba(255,255,255,0.08); }
.agf-tl-item { display: flex; gap: 10px; padding: 4px 0; }
.agf-tl-item:not(:last-child) { border-bottom: 1px solid rgba(0,0,0,0.05); }
.agf-panel.dark .agf-tl-item:not(:last-child) { border-color: rgba(255,255,255,0.05); }
.agf-tl-date { min-width: 68px; font-size: 10px; font-weight: 700; color: #6366f1; padding-top: 1px; flex-shrink: 0; }
.agf-tl-event { font-size: 12px; font-weight: 600; }
.agf-tl-desc { font-size: 11px; color: #71717a; margin-top: 1px; }
/* map */
.agf-map {
  background: #f9f9fb; border: 1px solid rgba(0,0,0,0.08);
  border-radius: 10px; padding: 10px 12px;
}
.agf-panel.dark .agf-map { background: #1c1c20; border-color: rgba(255,255,255,0.08); }
.agf-map-pin { display: flex; align-items: center; gap: 6px; padding: 2px 0; font-size: 11px; }
/* chart */
.agf-chart {
  background: #f9f9fb; border: 1px solid rgba(0,0,0,0.08);
  border-radius: 10px; padding: 10px 12px; overflow: hidden;
}
.agf-panel.dark .agf-chart { background: #1c1c20; border-color: rgba(255,255,255,0.08); }
.agf-chart-legend { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
.agf-chart-legend-item { display: flex; align-items: center; gap: 4px; font-size: 10px; color: #71717a; }
.agf-panel.dark .agf-chart-legend-item { color: #a1a1aa; }
.agf-chart-legend-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
`

// ── Inline SVG icons (zero external deps) ────────────────────────────────────

function IconMsg() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  )
}

function IconX() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

function IconSend() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  )
}

// ── A2UI type detection ───────────────────────────────────────────────────────
// Mirrors Python _A2UI_COMPONENT_TYPES in agent-runtime/core/workflow.py.
// Add new component types here and in the Python constant — nowhere else.

const A2UI_TYPES = new Set(['card', 'table', 'list', 'timeline', 'map', 'chart', 'accordion', 'tabs', 'progress', 'badge', 'actions'])

function isA2UIJson(content: string): boolean {
  if (!content) return false
  try {
    const parsed: unknown = JSON.parse(content)
    if (typeof parsed !== 'object' || parsed === null) return false
    // Array: all elements must be valid A2UI components
    if (Array.isArray(parsed)) {
      return parsed.length > 0 && parsed.every(
        item => typeof item === 'object' && item !== null && !Array.isArray(item) &&
          A2UI_TYPES.has((item as Record<string, unknown>).type as string)
      )
    }
    // Single object
    return A2UI_TYPES.has((parsed as Record<string, unknown>).type as string)
  } catch {
    return false
  }
}

// ── Widget ────────────────────────────────────────────────────────────────────

export function Widget({ config }: { config: WidgetConfig }) {
  const [open, setOpen] = useState(false)
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const sid = useRef(getSessionId())
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const isDark = config.theme === 'dark'

  // Auto-scroll to latest message
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [msgs])

  // Focus input when panel opens
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => inputRef.current?.focus(), 120)
      return () => clearTimeout(t)
    }
  }, [open])

  // sendPrompt — core SSE + POST logic. Called by send() (user types) and onAction (button click).
  const sendPrompt = useCallback(async (text: string) => {
    if (!text || busy) return
    setBusy(true)

    function _patch(id: string, patch: Partial<Omit<Msg, 'id' | 'role'>>) {
      setMsgs(prev => prev.map(m => m.id === id ? { ...m, ...patch } : m))
    }
    function _appendBlock(id: string, block: A2UIPayload) {
      setMsgs(prev => prev.map(m =>
        m.id === id ? { ...m, a2uiBlocks: [...(m.a2uiBlocks ?? []), block] } : m
      ))
    }

    // Add user bubble + empty streaming assistant placeholder immediately
    const asgId = crypto.randomUUID()
    setMsgs(prev => [
      ...prev,
      { id: crypto.randomUUID(), role: 'user', content: text, streaming: false, error: false },
      { id: asgId, role: 'assistant', content: '', streaming: true, error: false },
    ])

    const traceId = crypto.randomUUID()
    const sseUrl = `${config.runtimeUrl}/v1/${config.org}/${config.workflow}/trace?session_id=${traceId}`
    const postUrl = `${config.runtimeUrl}/v1/${config.org}/${config.workflow}/${config.version}`

    let textBuffer = ''
    let closed = false
    const ctrl = new AbortController()

    function finish() {
      if (!closed) {
        closed = true
        ctrl.abort()
        setBusy(false)
      }
    }

    try {
      // ── Step 1: open SSE stream (GET) — creates TRACE_QUEUES entry server-side ──
      // Using fetch+ReadableStream instead of EventSource so we can explicitly parse
      // both `event:` and `data:` lines from each \n\n-separated SSE block.
      const sseRes = await fetch(sseUrl, { signal: ctrl.signal })
      if (!sseRes.ok || !sseRes.body) throw new Error(`SSE connection failed: ${sseRes.status}`)

      // ── Step 2: parse SSE stream in background ────────────────────────────────
      const reader = sseRes.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''

      const sseLoop = (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buf += decoder.decode(value, { stream: true })
            // Split on double-newline — SSE block separator
            const blocks = buf.split('\n\n')
            buf = blocks.pop() ?? ''  // keep incomplete trailing block
            for (const block of blocks) {
              if (!block.trim()) continue
              // Parse event: and data: lines from this SSE block
              let eventType = ''
              let data = ''
              for (const line of block.split('\n')) {
                if (line.startsWith('event: ')) eventType = line.slice(7).trim()
                else if (line.startsWith('data: ')) data = line.slice(6).trim()
              }
              if (!eventType || !data) continue
              // Dispatch by AG-UI event type
              if (eventType === 'TextMessageContent') {
                try { textBuffer += (JSON.parse(data).delta as string | undefined) ?? '' } catch { /* skip malformed */ }
                _patch(asgId, { content: textBuffer })
              } else if (eventType === 'TextMessageStart') {
                // streaming: true already set — no-op
              } else if (eventType === 'TextMessageEnd') {
                _patch(asgId, { streaming: false })
              } else if (eventType === 'A2UIContent') {
                try {
                  _appendBlock(asgId, JSON.parse(data) as A2UIPayload)
                  _patch(asgId, { content: '' })
                } catch { /* skip malformed A2UI */ }
              } else if (eventType === 'RunFinished') {
                _patch(asgId, { streaming: false })
                finish()
                return
              } else if (eventType === 'RunError') {
                let msg = 'An error occurred.'
                try { msg = (JSON.parse(data).message as string | undefined) ?? msg } catch { /* */ }
                _patch(asgId, { content: msg, streaming: false, error: true })
                finish()
                return
              }
            }
          }
        } catch { /* AbortError on finish() or network drop — handled below */ }
        // Stream ended without RunFinished — clean up
        if (!closed) { _patch(asgId, { streaming: false }); finish() }
      })()

      // ── Step 3: POST to trigger workflow execution ─────────────────────────────
      const postHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Session-ID': sid.current,
        'X-Trace-Session': traceId,
      }
      if (config.authToken) {
        postHeaders['Authorization'] = `Bearer ${config.authToken}`
      }

      const res = await fetch(postUrl, {
        method: 'POST',
        headers: postHeaders,
        body: JSON.stringify({
          projectId: config.org,
          intentKey: 'chat',
          query: text,
          customParams: {},
          deployment_type: 'chat_widget_agui',
        }),
      })

      if (!res.ok) {
        const detail = await res.text().catch(() => `HTTP ${res.status}`)
        throw new Error(detail)
      }

      // ── Step 4: wait for SSE loop with safety timeout ─────────────────────────
      // SSE events drive all state changes; safety timeout cleans up if server
      // never sends RunFinished (e.g. hung workflow or dropped connection).
      const safetyTimer = setTimeout(() => {
        if (!closed) { _patch(asgId, { streaming: false }); finish() }
      }, 120_000)

      await sseLoop
      clearTimeout(safetyTimer)

    } catch (err) {
      if (!closed) {
        _patch(asgId, {
          content: err instanceof Error ? err.message : 'Failed to reach the agent.',
          streaming: false,
          error: true,
        })
        finish()
      }
    }
  }, [busy, config])

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text) return
    setInput('')
    void sendPrompt(text)
  }, [input, sendPrompt])

  function handleKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div id="agf-root">
      <style>{WIDGET_CSS}</style>

      {/* Floating toggle button */}
      <button
        className="agf-btn"
        onClick={() => setOpen(o => !o)}
        aria-label={open ? 'Close chat' : 'Open chat'}
      >
        {open ? <IconX /> : <IconMsg />}
      </button>

      {/* Chat panel */}
      {open && (
        <div className={`agf-panel${isDark ? ' dark' : ''}`} role="dialog" aria-label={config.title}>

          {/* Header */}
          <div className="agf-header">
            <span className="agf-header-title">{config.title}</span>
            <button className="agf-header-close" onClick={() => setOpen(false)} aria-label="Close">
              <IconX />
            </button>
          </div>

          {/* Messages */}
          <div className="agf-messages" role="log" aria-live="polite">
            {msgs.length === 0 && (
              <div className="agf-empty">
                <p className="agf-empty-text">Hi! How can I help you today?</p>
              </div>
            )}

            {msgs.map(m => (
              <div key={m.id} className={`agf-msg ${m.role}${m.error ? ' error' : ''}`}>
                {/* Text bubble — shown when streaming, or when content exists and is not pure A2UI JSON */}
                {(m.streaming || (m.content && !isA2UIJson(m.content) && !(m.a2uiBlocks?.length))) && (
                  <div className="agf-bubble">
                    {m.content}
                    {m.streaming && m.role === 'assistant' && (
                      <span className="agf-cursor" aria-hidden="true" />
                    )}
                  </div>
                )}
                {/* A2UI structured components — rendered in sequence below text */}
                {m.a2uiBlocks?.map((block, i) => (
                  <A2UIRenderer key={i} payload={block} isDark={isDark} onAction={sendPrompt} />
                ))}
              </div>
            ))}
            <div ref={bottomRef} />
          </div>

          {/* Input footer */}
          <div className="agf-footer">
            <textarea
              ref={inputRef}
              className="agf-input"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKey}
              placeholder="Type a message… (Enter to send)"
              rows={1}
              disabled={busy}
              aria-label="Message input"
            />
            <button
              className="agf-send"
              onClick={() => void send()}
              disabled={busy || !input.trim()}
              aria-label="Send message"
            >
              <IconSend />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
