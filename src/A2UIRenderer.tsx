/**
 * A2UIRenderer — renders A2UI JSON payloads as inline components in the chat widget.
 *
 * A2UI vs AG-UI separation (CLAUDE.md §2c, non-negotiable):
 *   AG-UI = HOW to transport  (SSE event stream from FastAPI to widget)
 *   A2UI  = WHAT to render    (JSON payload inside the stream: component type + data)
 *
 * Rendering intelligence lives here — in the widget — not in agents or FastAPI.
 * Agents output A2UI JSON spec only. Zero rendering logic inside system prompts.
 * Per Decision 17: agents are stateless and presentation-agnostic.
 *
 * Zero external dependencies. All rendering via pure SVG + HTML + inline CSS
 * (dark mode handled by .agf-panel.dark cascade defined in Widget.tsx WIDGET_CSS).
 */

// ── Public type — exported so Widget.tsx can reference it ─────────────────────

export interface A2UIPayload {
  type: 'card' | 'table' | 'list' | 'timeline' | 'map' | 'chart'
  data: unknown
  title?: string
  theme?: 'default' | 'compact' | 'detailed'
}

// ── Component-specific data shapes ────────────────────────────────────────────

interface CardData {
  fields: Array<{ label: string; value: string | number }>
  image?: string
}

interface TableData {
  headers: string[]
  rows: Array<(string | number)[]>
}

interface ListData {
  ordered?: boolean
  items: Array<{ text: string; icon?: string }>
}

interface TimelineData {
  events: Array<{ date: string; event: string; description?: string }>
}

interface MapData {
  pins: Array<{ lat: number; lng: number; label?: string }>
}

interface ChartData {
  chartType: 'bar' | 'line' | 'pie'
  labels: string[]
  series: Array<{ name: string; values: number[]; color?: string }>
}

// ── Colour palette ────────────────────────────────────────────────────────────

const PALETTE = ['#6366f1', '#f59e0b', '#10b981', '#ef4444', '#3b82f6', '#8b5cf6', '#ec4899']

function col(i: number, override?: string): string {
  return override ?? PALETTE[i % PALETTE.length]
}

// ── Card ──────────────────────────────────────────────────────────────────────

function CardRenderer({ payload }: { payload: A2UIPayload }) {
  const d = payload.data as CardData
  if (!d?.fields?.length) return null
  return (
    <div className="agf-a2ui agf-card">
      {payload.title && <div className="agf-a2ui-title">{payload.title}</div>}
      {d.image && (
        <img
          src={d.image}
          alt={payload.title ?? 'card image'}
          style={{ width: '100%', borderRadius: 6, marginBottom: 8, objectFit: 'cover', maxHeight: 120 }}
        />
      )}
      {d.fields.map((f, i) => (
        <div key={i} className="agf-card-field">
          <span className="agf-card-label">{f.label}</span>
          <span className="agf-card-value">{String(f.value)}</span>
        </div>
      ))}
    </div>
  )
}

// ── Table ─────────────────────────────────────────────────────────────────────

function TableRenderer({ payload }: { payload: A2UIPayload }) {
  const d = payload.data as TableData
  if (!d?.headers?.length || !d?.rows?.length) return null
  return (
    <div className="agf-a2ui">
      {payload.title && <div className="agf-a2ui-title">{payload.title}</div>}
      <div className="agf-table-wrap">
        <table className="agf-table">
          <thead>
            <tr>{d.headers.map((h, i) => <th key={i}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {d.rows.map((row, ri) => (
              <tr key={ri}>
                {row.map((cell, ci) => <td key={ci}>{String(cell)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── List ──────────────────────────────────────────────────────────────────────

function ListRenderer({ payload }: { payload: A2UIPayload }) {
  const d = payload.data as ListData
  if (!d?.items?.length) return null
  return (
    <div className="agf-a2ui agf-list">
      {payload.title && <div className="agf-a2ui-title">{payload.title}</div>}
      {d.items.map((item, i) => (
        <div key={i} className="agf-list-item">
          <span className="agf-list-bullet">
            {item.icon ? item.icon : d.ordered ? `${i + 1}.` : '•'}
          </span>
          <span>{item.text}</span>
        </div>
      ))}
    </div>
  )
}

// ── Timeline ──────────────────────────────────────────────────────────────────

function TimelineRenderer({ payload }: { payload: A2UIPayload }) {
  const d = payload.data as TimelineData
  if (!d?.events?.length) return null
  return (
    <div className="agf-a2ui agf-timeline">
      {payload.title && <div className="agf-a2ui-title">{payload.title}</div>}
      {d.events.map((ev, i) => (
        <div key={i} className="agf-tl-item">
          <div className="agf-tl-date">{ev.date}</div>
          <div className="agf-tl-content">
            <div className="agf-tl-event">{ev.event}</div>
            {ev.description && <div className="agf-tl-desc">{ev.description}</div>}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Map (static SVG pin plot — no external map library) ───────────────────────

function MapRenderer({ payload, isDark }: { payload: A2UIPayload; isDark: boolean }) {
  const d = payload.data as MapData
  if (!d?.pins?.length) return null

  const W = 272, H = 110, PAD = 14
  const lats = d.pins.map(p => p.lat)
  const lngs = d.pins.map(p => p.lng)
  const minLat = Math.min(...lats), maxLat = Math.max(...lats)
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs)
  const latRange = maxLat - minLat || 1
  const lngRange = maxLng - minLng || 1

  function pinX(lng: number) { return PAD + ((lng - minLng) / lngRange) * (W - PAD * 2) }
  // SVG y grows downward; latitude grows upward → invert
  function pinY(lat: number) { return H - PAD - ((lat - minLat) / latRange) * (H - PAD * 2) }

  const bgColor  = isDark ? '#1e1e2e' : '#e8f0fe'
  const gridColor = isDark ? '#3730a3' : '#c7d2fe'
  const textColor = isDark ? '#818cf8' : '#3730a3'

  return (
    <div className="agf-a2ui agf-map">
      {payload.title && <div className="agf-a2ui-title">{payload.title}</div>}
      <svg
        width={W} height={H}
        style={{ display: 'block', width: '100%', height: 'auto', background: bgColor, borderRadius: 6 }}
        aria-label="Map"
      >
        {/* Border */}
        <rect x={PAD} y={PAD} width={W - PAD * 2} height={H - PAD * 2}
          fill="none" stroke={gridColor} strokeWidth="0.5" />
        {/* Pins */}
        {d.pins.map((pin, i) => {
          const x = pinX(pin.lng)
          const y = pinY(pin.lat)
          return (
            <g key={i}>
              <circle cx={x} cy={y} r={5} fill="#6366f1" />
              <circle cx={x} cy={y} r={2.5} fill="#ffffff" />
              {pin.label && (
                <text x={x + 8} y={y + 4} fontSize="8" fill={textColor} fontFamily="system-ui">
                  {pin.label}
                </text>
              )}
            </g>
          )
        })}
      </svg>
      {/* Pin list below map */}
      {d.pins.map((pin, i) => (
        <div key={i} className="agf-map-pin">
          <span className="agf-map-pin-icon">📍</span>
          <span>{pin.label ?? `${pin.lat.toFixed(4)}, ${pin.lng.toFixed(4)}`}</span>
        </div>
      ))}
    </div>
  )
}

// ── Charts — pure SVG, zero external deps ────────────────────────────────────

const CHART_W = 272, CHART_H = 130
const PAD_T = 10, PAD_R = 8, PAD_B = 28, PAD_L = 28
const CW = CHART_W - PAD_L - PAD_R   // 236
const CH = CHART_H - PAD_T - PAD_B   // 92

function yTicks(maxVal: number, count = 4) {
  return Array.from({ length: count + 1 }, (_, i) => (maxVal / count) * i)
}

function fmtVal(v: number) {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`
  return String(Math.round(v))
}

function BarChart({ d, isDark }: { d: ChartData; isDark: boolean }) {
  const numGroups = d.labels.length
  const numSeries = d.series.length
  if (!numGroups || !numSeries) return null

  const allVals = d.series.flatMap(s => s.values)
  const maxVal = Math.max(...allVals, 1)
  const ticks = yTicks(maxVal)
  const groupW = CW / numGroups
  const barMargin = groupW * 0.15
  const barW = Math.max(3, (groupW - barMargin * 2) / numSeries)

  const axisColor = isDark ? '#3f3f46' : '#d4d4d8'
  const textColor = isDark ? '#a1a1aa' : '#71717a'

  return (
    <svg width={CHART_W} height={CHART_H} style={{ display: 'block', width: '100%', height: 'auto' }} aria-label="Bar chart">
      {/* Y-axis grid + labels */}
      {ticks.map((v, i) => {
        const y = PAD_T + CH - (v / maxVal) * CH
        return (
          <g key={i}>
            <line x1={PAD_L} y1={y} x2={PAD_L + CW} y2={y}
              stroke={axisColor} strokeWidth="0.5" strokeDasharray={i === 0 ? '' : '2 2'} />
            <text x={PAD_L - 4} y={y + 3} fontSize="7" fill={textColor}
              textAnchor="end" fontFamily="system-ui">{fmtVal(v)}</text>
          </g>
        )
      })}
      {/* Bars */}
      {d.series.map((s, si) =>
        d.labels.map((_, gi) => {
          const val = s.values[gi] ?? 0
          const barH = (val / maxVal) * CH
          const x = PAD_L + gi * groupW + barMargin + si * barW
          const y = PAD_T + CH - barH
          return (
            <rect key={`${si}-${gi}`} x={x} y={y} width={barW - 1} height={Math.max(0, barH)}
              fill={col(si, s.color)} rx="2" />
          )
        })
      )}
      {/* X-axis labels */}
      {d.labels.map((label, i) => {
        const x = PAD_L + i * groupW + groupW / 2
        const display = label.length > 9 ? label.slice(0, 8) + '…' : label
        return (
          <text key={i} x={x} y={CHART_H - 6} fontSize="7" fill={textColor}
            textAnchor="middle" fontFamily="system-ui">{display}</text>
        )
      })}
    </svg>
  )
}

function LineChart({ d, isDark }: { d: ChartData; isDark: boolean }) {
  const numGroups = d.labels.length
  const numSeries = d.series.length
  if (numGroups < 2 || !numSeries) return null

  const allVals = d.series.flatMap(s => s.values)
  const maxVal = Math.max(...allVals, 1)
  const ticks = yTicks(maxVal)

  const axisColor = isDark ? '#3f3f46' : '#d4d4d8'
  const textColor = isDark ? '#a1a1aa' : '#71717a'

  function px(gi: number) { return PAD_L + (gi / (numGroups - 1)) * CW }
  function py(v: number)  { return PAD_T + CH - (v / maxVal) * CH }

  return (
    <svg width={CHART_W} height={CHART_H} style={{ display: 'block', width: '100%', height: 'auto' }} aria-label="Line chart">
      {ticks.map((v, i) => {
        const y = py(v)
        return (
          <g key={i}>
            <line x1={PAD_L} y1={y} x2={PAD_L + CW} y2={y}
              stroke={axisColor} strokeWidth="0.5" strokeDasharray={i === 0 ? '' : '2 2'} />
            <text x={PAD_L - 4} y={y + 3} fontSize="7" fill={textColor}
              textAnchor="end" fontFamily="system-ui">{fmtVal(v)}</text>
          </g>
        )
      })}
      {d.series.map((s, si) => {
        const c = col(si, s.color)
        const pts = s.values.map((v, gi) => `${px(gi)},${py(v)}`).join(' ')
        return (
          <g key={si}>
            <polyline points={pts} fill="none" stroke={c} strokeWidth="2"
              strokeLinejoin="round" strokeLinecap="round" />
            {s.values.map((v, gi) => (
              <circle key={gi} cx={px(gi)} cy={py(v)} r={3} fill={c} />
            ))}
          </g>
        )
      })}
      {d.labels.map((label, i) => {
        const display = label.length > 9 ? label.slice(0, 8) + '…' : label
        return (
          <text key={i} x={px(i)} y={CHART_H - 6} fontSize="7" fill={textColor}
            textAnchor="middle" fontFamily="system-ui">{display}</text>
        )
      })}
    </svg>
  )
}

function PieChart({ d }: { d: ChartData }) {
  const vals = d.series[0]?.values ?? []
  if (!vals.length) return null

  const total = vals.reduce((a, b) => a + b, 0) || 1
  const CX = 65, CY = 65, R = 52, SZ = 130

  let cumAngle = -Math.PI / 2
  const slices = vals.map((v, i) => {
    const angle = (v / total) * 2 * Math.PI
    const start = cumAngle
    const end = cumAngle + angle
    cumAngle = end
    const large = angle > Math.PI ? 1 : 0
    const x1 = CX + R * Math.cos(start), y1 = CY + R * Math.sin(start)
    const x2 = CX + R * Math.cos(end),   y2 = CY + R * Math.sin(end)
    const path = `M${CX},${CY} L${x1.toFixed(2)},${y1.toFixed(2)} A${R},${R} 0 ${large} 1 ${x2.toFixed(2)},${y2.toFixed(2)} Z`
    const pct = Math.round((v / total) * 100)
    return { path, color: col(i, d.series[0]?.color), label: d.labels[i] ?? `Slice ${i + 1}`, pct }
  })

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <svg width={SZ} height={SZ} style={{ flexShrink: 0 }} aria-label="Pie chart">
        {slices.map((s, i) => (
          <path key={i} d={s.path} fill={s.color} stroke="#ffffff" strokeWidth="1.5" />
        ))}
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {slices.map((s, i) => (
          <div key={i} className="agf-chart-legend-item">
            <div className="agf-chart-legend-dot" style={{ background: s.color }} />
            <span>{s.label} ({s.pct}%)</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function ChartRenderer({ payload, isDark }: { payload: A2UIPayload; isDark: boolean }) {
  const d = payload.data as ChartData
  if (!d?.series?.length || !d?.labels?.length) return null

  const chartType = d.chartType ?? 'bar'
  const showLegend = d.series.length > 1 && chartType !== 'pie'

  return (
    <div className="agf-a2ui agf-chart">
      {payload.title && <div className="agf-a2ui-title">{payload.title}</div>}
      {chartType === 'bar'  && <BarChart  d={d} isDark={isDark} />}
      {chartType === 'line' && <LineChart d={d} isDark={isDark} />}
      {chartType === 'pie'  && <PieChart  d={d} />}
      {/* Fallback for unknown chartType */}
      {chartType !== 'bar' && chartType !== 'line' && chartType !== 'pie' && (
        <BarChart d={d} isDark={isDark} />
      )}
      {showLegend && (
        <div className="agf-chart-legend">
          {d.series.map((s, i) => (
            <div key={i} className="agf-chart-legend-item">
              <div className="agf-chart-legend-dot" style={{ background: col(i, s.color) }} />
              <span>{s.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Fallback for unrecognised type ────────────────────────────────────────────

function PlainRenderer({ payload }: { payload: A2UIPayload }) {
  return (
    <div className="agf-a2ui agf-card" style={{ color: '#71717a', fontSize: 11 }}>
      {String(payload.data)}
    </div>
  )
}

// ── Main export ───────────────────────────────────────────────────────────────

export function A2UIRenderer({ payload, isDark }: { payload: A2UIPayload; isDark: boolean }) {
  switch (payload.type) {
    case 'card':      return <CardRenderer payload={payload} />
    case 'table':     return <TableRenderer payload={payload} />
    case 'list':      return <ListRenderer payload={payload} />
    case 'timeline':  return <TimelineRenderer payload={payload} />
    case 'map':       return <MapRenderer payload={payload} isDark={isDark} />
    case 'chart':     return <ChartRenderer payload={payload} isDark={isDark} />
    default:          return <PlainRenderer payload={payload} />
  }
}
