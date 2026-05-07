/**
 * A2UIRenderer — renders A2UI JSON payloads using shadcn/ui + recharts + react-leaflet.
 *
 * A2UI vs AG-UI separation (CLAUDE.md §2c, non-negotiable):
 *   AG-UI = HOW to transport  (SSE event stream from FastAPI to widget)
 *   A2UI  = WHAT to render    (JSON payload inside the stream: component type + data)
 *
 * Rendering intelligence lives here — in the widget — not in agents or FastAPI.
 * Agents output A2UI JSON spec only. Zero rendering logic inside system prompts.
 * Per Decision 17: agents are stateless and presentation-agnostic.
 *
 * Dark mode: isDark prop toggles the `dark` class on the root wrapper so
 * Tailwind `dark:` variants activate inside the component tree.
 */

import { useState, useRef, useEffect, createContext, useContext, useCallback, useMemo, Component } from 'react'
import type { ReactNode } from 'react'
import 'leaflet/dist/leaflet.css'

import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet'
import L from 'leaflet'
import {
  BarChart as ReBarChart, Bar,
  LineChart as ReLineChart, Line,
  AreaChart as ReAreaChart, Area,
  PieChart as RePieChart, Pie, Cell,
  RadarChart as ReRadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  RadialBarChart as ReRadialBarChart, RadialBar,
  ScatterChart as ReScatterChart, Scatter, ZAxis,
  ComposedChart as ReComposedChart,
  Treemap as ReTreemap,
  FunnelChart as ReFunnelChart, Funnel, LabelList,
  Sankey as ReSankey,
  XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, Legend, ResponsiveContainer,
} from 'recharts'
import { cn } from '@/lib/utils'
import { format } from 'date-fns'
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  flexRender,
  type SortingState,
  type ColumnDef,
} from '@tanstack/react-table'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import {
  Carousel, CarouselContent, CarouselItem, CarouselNext, CarouselPrevious,
} from '@/components/ui/carousel'
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Calendar } from '@/components/ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle,
} from '@/components/ui/empty'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'

// Fix Leaflet default icon URLs in bundled environments (icons reference missing assets otherwise)
const _DefaultIcon = L.icon({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
})
L.Marker.mergeOptions({ icon: _DefaultIcon })

// ── Public type — exported so Widget.tsx can reference it ─────────────────────

export interface A2UIPayload {
  type: 'card' | 'table' | 'list' | 'timeline' | 'map' | 'chart' | 'accordion' | 'tabs' | 'progress' | 'badge' | 'actions'
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

interface AccordionData {
  items: Array<{ question: string; answer: string }>
}

interface TabsData {
  tabs: Array<{ label: string; content: string | A2UIPayload | A2UIPayload[] }>
}

interface ProgressData {
  items: Array<{ label: string; value: number }>
}

interface BadgeGroupData {
  items: Array<{ text: string; variant?: 'default' | 'secondary' | 'outline' }>
}

interface ActionsData {
  buttons: Array<{ label: string; message: string; variant?: 'default' | 'outline' | 'secondary' }>
}

// ── Colour palette ────────────────────────────────────────────────────────────

const PALETTE = ['#6366f1', '#f59e0b', '#10b981', '#ef4444', '#3b82f6', '#8b5cf6', '#ec4899']

function col(i: number, override?: string): string {
  return override ?? PALETTE[i % PALETTE.length]
}

// ── Chart error boundary ───────────────────────────────────────────────────────

class ChartErrorBoundary extends Component<{ children: ReactNode }, { error: boolean }> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { error: false }
  }
  static getDerivedStateFromError() { return { error: true } }
  render() {
    if (this.state.error) {
      return <p className="text-xs text-muted-foreground py-2 text-center">Chart unavailable</p>
    }
    return this.props.children
  }
}

// ── Card ──────────────────────────────────────────────────────────────────────

function CardRenderer({ payload }: { payload: A2UIPayload }) {
  const d = payload.data as CardData
  if (!d?.fields?.length) return null
  return (
    <Card className="w-full my-2">
      {(payload.title || d.image) && (
        <CardHeader className="pb-2">
          {d.image && (
            <img
              src={d.image}
              alt={payload.title ?? 'card image'}
              className="w-full rounded object-cover max-h-28 mb-2"
            />
          )}
          {payload.title && <CardTitle className="text-sm">{payload.title}</CardTitle>}
        </CardHeader>
      )}
      <CardContent className="pt-0">
        <div className="divide-y divide-border">
          {d.fields.map((f, i) => (
            <div key={i} className="flex justify-between items-center py-1.5 gap-2">
              <span className="text-xs text-muted-foreground shrink-0">{f.label}</span>
              <span className="text-xs font-medium text-right">{String(f.value)}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

// ── Table ─────────────────────────────────────────────────────────────────────

function TableRenderer({ payload }: { payload: A2UIPayload }) {
  const d = payload.data as TableData
  if (!d?.headers?.length || !d?.rows?.length) return null
  return (
    <div className="w-full my-2">
      {payload.title && (
        <p className="text-xs font-semibold mb-1 text-foreground">{payload.title}</p>
      )}
      <ScrollArea className="w-full rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              {d.headers.map((h, i) => (
                <TableHead key={i} className="text-xs whitespace-nowrap">{h}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {d.rows.map((row, ri) => (
              <TableRow key={ri}>
                {row.map((cell, ci) => (
                  <TableCell key={ci} className="text-xs whitespace-nowrap py-1.5">
                    {String(cell)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ScrollArea>
    </div>
  )
}

// ── List ──────────────────────────────────────────────────────────────────────

function ListRenderer({ payload }: { payload: A2UIPayload }) {
  const d = payload.data as ListData
  if (!d?.items?.length) return null
  return (
    <div className="w-full my-2">
      {payload.title && (
        <p className="text-xs font-semibold mb-1 text-foreground">{payload.title}</p>
      )}
      <ScrollArea className="max-h-48 rounded-md border p-2">
        <ul className="space-y-1">
          {d.items.map((item, i) => (
            <li key={i} className="flex items-start gap-2 text-xs">
              <span className="shrink-0 text-muted-foreground">
                {item.icon ? item.icon : d.ordered ? `${i + 1}.` : '•'}
              </span>
              <span>{item.text}</span>
            </li>
          ))}
        </ul>
      </ScrollArea>
    </div>
  )
}

// ── Timeline ──────────────────────────────────────────────────────────────────

function TimelineRenderer({ payload }: { payload: A2UIPayload }) {
  const d = payload.data as TimelineData
  if (!d?.events?.length) return null
  return (
    <div className="w-full my-2">
      {payload.title && (
        <p className="text-xs font-semibold mb-2 text-foreground">{payload.title}</p>
      )}
      <div className="space-y-0">
        {d.events.map((ev, i) => (
          <div key={i} className="flex gap-3">
            <div className="flex flex-col items-center">
              <div className="h-2 w-2 rounded-full bg-primary mt-1 shrink-0" />
              {i < d.events.length - 1 && (
                <Separator orientation="vertical" className="flex-1 my-1" />
              )}
            </div>
            <div className="pb-3">
              <p className="text-xs font-semibold text-muted-foreground">{ev.date}</p>
              <p className="text-xs font-medium">{ev.event}</p>
              {ev.description && (
                <p className="text-xs text-muted-foreground mt-0.5">{ev.description}</p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Map (react-leaflet + OpenStreetMap, no API key required) ──────────────────

function MapRenderer({ payload }: { payload: A2UIPayload }) {
  const d = payload.data as MapData
  if (!d?.pins?.length) return null

  const lats = d.pins.map(p => p.lat)
  const lngs = d.pins.map(p => p.lng)
  const centerLat = (Math.min(...lats) + Math.max(...lats)) / 2
  const centerLng = (Math.min(...lngs) + Math.max(...lngs)) / 2
  const zoom = d.pins.length === 1 ? 12 : 5

  return (
    <div className="w-full my-2">
      {payload.title && (
        <p className="text-xs font-semibold mb-1 text-foreground">{payload.title}</p>
      )}
      <div className="rounded-md overflow-hidden border" style={{ height: 200 }}>
        <MapContainer
          center={[centerLat, centerLng]}
          zoom={zoom}
          style={{ height: '100%', width: '100%' }}
          scrollWheelZoom={false}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          {d.pins.map((pin, i) => (
            <Marker key={i} position={[pin.lat, pin.lng]}>
              {pin.label && <Popup>{pin.label}</Popup>}
            </Marker>
          ))}
        </MapContainer>
      </div>
      {d.pins.map((pin, i) => (
        <div key={i} className="flex items-center gap-1 text-xs text-muted-foreground mt-0.5">
          <span>📍</span>
          <span>{pin.label ?? `${pin.lat.toFixed(4)}, ${pin.lng.toFixed(4)}`}</span>
        </div>
      ))}
    </div>
  )
}

// ── Charts (recharts) — legacy flat format ────────────────────────────────────

function ChartRenderer({ payload, isDark }: { payload: A2UIPayload; isDark: boolean }) {
  const d = payload.data as ChartData
  if (!d?.series?.length || !d?.labels?.length) return null

  const chartType = d.chartType ?? 'bar'
  const axisColor = isDark ? '#71717a' : '#a1a1aa'
  const gridColor = isDark ? '#3f3f46' : '#e4e4e7'
  // Null-guard: coerce null/undefined labels to 'Item N' and series names to 'Series N'
  const safeLabels = d.labels.map((l, i) => (l != null ? String(l) : `Item ${i + 1}`))
  const safeSeries = d.series.map((s, i) => ({
    ...s,
    name: s.name != null && s.name !== '' ? String(s.name) : `Series ${i + 1}`,
    values: (s.values ?? []).map(v => (v == null || !Number.isFinite(Number(v)) ? 0 : Number(v))),
  }))

  const chartData = safeLabels.map((label, li) => {
    const entry: Record<string, string | number> = { name: label }
    safeSeries.forEach(s => { entry[s.name] = s.values[li] ?? 0 })
    return entry
  })

  const pieData = safeLabels.map((label, i) => ({
    name: label,
    value: safeSeries[0]?.values[i] ?? 0,
  }))

  return (
    <div className="w-full my-2">
      {payload.title && (
        <p className="text-xs font-semibold mb-1 text-foreground">{payload.title}</p>
      )}
      <div style={{ width: '100%', height: 160, minWidth: 300 }}>
        <ChartErrorBoundary>
          <ResponsiveContainer width="100%" height="100%">
            {chartType === 'line' ? (
              <ReLineChart data={chartData} margin={{ top: 4, right: 8, left: -16, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
                <XAxis dataKey="name" tick={{ fontSize: 9, fill: axisColor }} />
                <YAxis tick={{ fontSize: 9, fill: axisColor }} />
                <RechartsTooltip contentStyle={{ fontSize: 10 }} />
                {safeSeries.length > 1 && <Legend iconSize={8} wrapperStyle={{ fontSize: 9 }} />}
                {safeSeries.map((s, i) => (
                  <Line
                    key={s.name}
                    type="monotone"
                    dataKey={s.name}
                    stroke={col(i, s.color)}
                    strokeWidth={2}
                    dot={{ r: 3 }}
                  />
                ))}
              </ReLineChart>
            ) : chartType === 'pie' ? (
              <RePieChart>
                <Pie
                  data={pieData}
                  cx="50%"
                  cy="50%"
                  outerRadius={55}
                  dataKey="value"
                >
                  {pieData.map((_, i) => (
                    <Cell key={i} fill={col(i, safeSeries[0]?.color)} />
                  ))}
                </Pie>
                <RechartsTooltip contentStyle={{ fontSize: 10 }} />
                <Legend iconSize={8} wrapperStyle={{ fontSize: 9 }} />
              </RePieChart>
            ) : (
              /* bar (default) */
              <ReBarChart data={chartData} margin={{ top: 4, right: 8, left: -16, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
                <XAxis dataKey="name" tick={{ fontSize: 9, fill: axisColor }} />
                <YAxis tick={{ fontSize: 9, fill: axisColor }} />
                <RechartsTooltip contentStyle={{ fontSize: 10 }} />
                {safeSeries.length > 1 && <Legend iconSize={8} wrapperStyle={{ fontSize: 9 }} />}
                {safeSeries.map((s, i) => (
                  <Bar key={s.name} dataKey={s.name} fill={col(i, s.color)} radius={[2, 2, 0, 0]} />
                ))}
              </ReBarChart>
            )}
          </ResponsiveContainer>
        </ChartErrorBoundary>
      </div>
    </div>
  )
}

// ── Accordion ─────────────────────────────────────────────────────────────────

function AccordionRenderer({ payload }: { payload: A2UIPayload }) {
  const d = payload.data as AccordionData
  if (!d?.items?.length) return null
  return (
    <div className="w-full my-2">
      {payload.title && (
        <p className="text-xs font-semibold mb-1 text-foreground">{payload.title}</p>
      )}
      <div className="space-y-1">
        {d.items.map((item, i) => (
          <details key={i} className="rounded-md border border-border overflow-hidden">
            <summary className="cursor-pointer px-3 py-2 text-xs font-medium bg-muted hover:bg-muted/80 select-none list-none flex items-center justify-between">
              <span>{item.question}</span>
              <span className="text-muted-foreground ml-2 shrink-0">›</span>
            </summary>
            <div className="px-3 py-2 text-xs text-muted-foreground leading-relaxed bg-background">
              {item.answer}
            </div>
          </details>
        ))}
      </div>
    </div>
  )
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

function TabsRenderer({ payload, isDark, onAction }: { payload: A2UIPayload; isDark: boolean; onAction?: (message: string) => void }) {
  const [active, setActive] = useState(0)
  const d = payload.data as TabsData
  if (!d?.tabs?.length) return null

  function renderContent(content: string | A2UIPayload | A2UIPayload[]) {
    if (typeof content === 'string') {
      return <p className="text-xs leading-relaxed">{content}</p>
    }
    if (Array.isArray(content)) {
      return <>{content.map((c, i) => <A2UIRenderer key={i} payload={c} isDark={isDark} onAction={onAction} />)}</>
    }
    return <A2UIRenderer payload={content} isDark={isDark} onAction={onAction} />
  }

  return (
    <div className="w-full my-2">
      {payload.title && (
        <p className="text-xs font-semibold mb-1 text-foreground">{payload.title}</p>
      )}
      <div className="rounded-md border border-border overflow-hidden">
        <div className="flex border-b border-border bg-muted overflow-x-auto">
          {d.tabs.map((tab, i) => (
            <button
              key={i}
              onClick={() => setActive(i)}
              className={cn(
                'px-3 py-1.5 text-xs font-medium whitespace-nowrap shrink-0 border-b-2 -mb-px transition-colors',
                i === active
                  ? 'border-primary text-primary bg-background'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="p-3">
          {d.tabs[active] ? renderContent(d.tabs[active].content) : null}
        </div>
      </div>
    </div>
  )
}

// ── Progress ──────────────────────────────────────────────────────────────────

function ProgressRenderer({ payload }: { payload: A2UIPayload }) {
  const d = payload.data as ProgressData
  if (!d?.items?.length) return null
  return (
    <div className="w-full my-2">
      {payload.title && (
        <p className="text-xs font-semibold mb-1 text-foreground">{payload.title}</p>
      )}
      <div className="space-y-2">
        {d.items.map((item, i) => {
          const pct = Math.max(0, Math.min(100, item.value))
          return (
            <div key={i}>
              <div className="flex justify-between items-center mb-0.5">
                <span className="text-xs text-muted-foreground">{item.label}</span>
                <span className="text-xs font-medium">{pct}%</span>
              </div>
              <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Badge group ───────────────────────────────────────────────────────────────

function BadgeGroupRenderer({ payload }: { payload: A2UIPayload }) {
  const d = payload.data as BadgeGroupData
  if (!d?.items?.length) return null
  return (
    <div className="w-full my-2">
      {payload.title && (
        <p className="text-xs font-semibold mb-1 text-foreground">{payload.title}</p>
      )}
      <div className="flex flex-wrap gap-1.5">
        {d.items.map((item, i) => (
          <Badge key={i} variant={item.variant ?? 'secondary'} className="text-xs">
            {item.text}
          </Badge>
        ))}
      </div>
    </div>
  )
}

// ── Actions ───────────────────────────────────────────────────────────────────

function ActionsRenderer({ payload, onAction }: { payload: A2UIPayload; onAction?: (message: string) => void }) {
  const d = payload.data as ActionsData
  if (!d?.buttons?.length) return null
  return (
    <div className="w-full my-2">
      {payload.title && (
        <p className="text-xs font-medium text-muted-foreground mb-2">{payload.title}</p>
      )}
      <div className="flex flex-wrap gap-2">
        {d.buttons.map((btn, i) => (
          <button
            key={i}
            onClick={() => onAction?.(btn.message)}
            className={cn(
              'inline-flex items-center px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors cursor-pointer',
              btn.variant === 'secondary'
                ? 'bg-secondary text-secondary-foreground border-secondary hover:bg-secondary/80'
                : btn.variant === 'outline'
                  ? 'bg-transparent border-border text-foreground hover:bg-muted'
                  : 'bg-primary text-primary-foreground border-primary hover:bg-primary/90',
            )}
          >
            {btn.label}
          </button>
        ))}
      </div>
    </div>
  )
}

// ── Fallback for unrecognised type ────────────────────────────────────────────

function PlainRenderer({ payload }: { payload: A2UIPayload }) {
  return (
    <div className="w-full my-2 rounded-md border p-2 text-xs text-muted-foreground">
      {String(payload.data)}
    </div>
  )
}

// ── Prefab wire protocol (v0.2) ───────────────────────────────────────────────
// New primary A2UI format: {"version":"0.2","view":{component tree},...}
// Legacy flat format (type at top level) remains fully supported for backward compat.

// ── Prefab types ──────────────────────────────────────────────────────────────

export interface PrefabEnvelope {
  version: '0.2'
  view: PrefabComponent
  state?: Record<string, unknown>
  defs?: Record<string, unknown>
}

export interface PrefabComponent {
  type: string
  children?: PrefabComponent[]
  [key: string]: unknown
}

interface PrefabAction {
  action: 'sendMessage' | 'openLink' | 'copy' | 'setState' | 'toggleState' | 'showToast' | 'appendState' | 'popState' | 'fetch' | 'setInterval' | 'clearInterval'
  [key: string]: unknown
}

// ── Prefab context ────────────────────────────────────────────────────────────

interface PrefabCtxValue {
  state: Record<string, unknown>
  onStateChange: (k: string, v: unknown | ((prev: unknown) => unknown)) => void
  onAction: (msg: string) => void
  isDark: boolean
  showToast: (msg: string) => void
  onSetInterval: (key: string, ms: number, actions: PrefabAction[]) => void
  onClearInterval: (key: string) => void
}

const PrefabCtx = createContext<PrefabCtxValue>({
  state: {},
  onStateChange: () => {},
  onAction: () => {},
  isDark: false,
  showToast: () => {},
  onSetInterval: () => {},
  onClearInterval: () => {},
})

// ── Utilities ─────────────────────────────────────────────────────────────────

/** Replace {{ key }} and {{ key.nested }} with values from state. */
function interp(val: unknown, state: Record<string, unknown>): string {
  if (typeof val !== 'string') return String(val ?? '')
  return val.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
    const resolved = path.split('.').reduce((obj: unknown, k) => {
      if (obj && typeof obj === 'object') return (obj as Record<string, unknown>)[k]
      return undefined
    }, state as unknown)
    return resolved !== undefined ? String(resolved) : ''
  })
}

/** Resolve a raw value from state — returns actual value (array, object, etc.), not stringified. */
function resolveValue(val: unknown, state: Record<string, unknown>): unknown {
  if (typeof val !== 'string') return val
  const m = val.match(/^\{\{\s*([\w.]+)\s*\}\}$/)
  if (m) {
    return m[1].split('.').reduce((obj: unknown, k) => {
      if (obj && typeof obj === 'object') return (obj as Record<string, unknown>)[k]
      return undefined
    }, state as unknown)
  }
  return interp(val, state)
}

/**
 * Evaluate a simple condition expression against state.
 * Supports {{ key }} interpolation and == != > < >= <= comparisons.
 * No eval(), no Function() — purely string parsing.
 */
function evalCondition(expr: string, state: Record<string, unknown>): boolean {
  const resolved = interp(expr, state)
  const m = resolved.match(/^(.*?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/)
  if (m) {
    const lStr = m[1].trim()
    const op = m[2]
    const rStr = m[3].trim()
    const lNum = Number(lStr)
    const rNum = Number(rStr)
    const useNum = lStr !== '' && rStr !== '' && !isNaN(lNum) && !isNaN(rNum)
    const l: string | number = useNum ? lNum : lStr
    const r: string | number = useNum ? rNum : rStr
    switch (op) {
      case '==': return l === r
      case '!=': return l !== r
      case '>':  return l > r
      case '<':  return l < r
      case '>=': return l >= r
      case '<=': return l <= r
      default:   return false
    }
  }
  return resolved !== '' && resolved !== 'false' && resolved !== '0' && resolved !== 'null' && resolved !== 'undefined'
}

/** Execute a Prefab action. */
function execPrefabAction(
  action: PrefabAction,
  state: Record<string, unknown>,
  onStateChange: (k: string, v: unknown | ((prev: unknown) => unknown)) => void,
  onAction: (msg: string) => void,
  showToast: (msg: string) => void,
): void {
  switch (action.action) {
    case 'sendMessage':
      onAction(interp(action.message, state))
      break
    case 'openLink':
      window.open(interp(action.url, state), '_blank', 'noopener,noreferrer')
      break
    case 'copy':
      navigator.clipboard?.writeText(interp(action.text, state)).catch(() => {})
      break
    case 'setState':
      onStateChange(action.key as string, action.value)
      break
    case 'toggleState':
      onStateChange(action.key as string, (prev: unknown) => !prev)
      break
    case 'showToast':
      showToast(interp(action.message, state))
      break
    case 'appendState': {
      const key = action.key as string
      const val = resolveValue(action.value, state)
      const existing = state[key]
      onStateChange(key, Array.isArray(existing) ? [...existing, val] : [val])
      break
    }
    case 'popState': {
      const key = action.key as string
      const existing = state[key]
      if (!Array.isArray(existing) || existing.length === 0) break
      const rawIdx = action.index as number | undefined
      const idx = rawIdx !== undefined ? rawIdx : -1
      const actualIdx = idx < 0 ? existing.length + idx : idx
      if (actualIdx < 0 || actualIdx >= existing.length) break
      const newArr = [...existing]
      newArr.splice(actualIdx, 1)
      onStateChange(key, newArr)
      break
    }
    case 'fetch': {
      const url = interp(action.url, state)
      const method = ((action.method as string | undefined) ?? 'GET').toUpperCase()
      const resultKey = action.resultKey as string | undefined
      const onError = action.onError as string | undefined
      const rawHeaders = action.headers as Record<string, string> | undefined
      const headers: Record<string, string> = {}
      if (rawHeaders) {
        for (const [hk, hv] of Object.entries(rawHeaders)) {
          headers[hk] = interp(hv, state)
        }
      }
      let body: string | undefined
      if (action.body != null && method !== 'GET' && method !== 'HEAD') {
        const rawBody = action.body as Record<string, unknown>
        const resolvedBody: Record<string, unknown> = {}
        for (const [bk, bv] of Object.entries(rawBody)) {
          resolvedBody[bk] = resolveValue(bv, state)
        }
        body = JSON.stringify(resolvedBody)
        if (!headers['Content-Type']) headers['Content-Type'] = 'application/json'
      }
      window.fetch(url, {
        method,
        headers: Object.keys(headers).length ? headers : undefined,
        body,
      })
        .then(r => r.json())
        .then(data => { if (resultKey) onStateChange(resultKey, data as unknown) })
        .catch((err: unknown) => {
          if (onError) onStateChange(onError, err instanceof Error ? err.message : String(err))
          else console.warn('[A2UI fetch error]', err)
        })
      break
    }
    // setInterval / clearInterval are handled in NodeRenderer's act closure (need refs)
  }
}

const _PREFAB_GAPS = ['0px', '4px', '8px', '12px', '16px', '20px', '24px', '28px', '32px']
function _gap(n: unknown): string {
  return _PREFAB_GAPS[Math.min(Math.max(Number(n ?? 2), 0), 8)] ?? '8px'
}

const _ALERT_CLS: Record<string, string> = {
  info: 'bg-blue-50 border-blue-200 text-blue-800',
  warning: 'bg-yellow-50 border-yellow-200 text-yellow-800',
  error: 'bg-red-50 border-red-200 text-red-800',
  success: 'bg-green-50 border-green-200 text-green-800',
}

// ── Prefab helpers ────────────────────────────────────────────────────────────

function RenderChildren({ nodes }: { nodes: PrefabComponent[] }) {
  return <>{nodes.map((n, i) => <NodeRenderer key={i} node={n} />)}</>
}

// Tabs extracted because it owns useState
function PrefabTabsNode({ node, s }: { node: PrefabComponent; s: (v: unknown) => string }) {
  const [active, setActive] = useState(0)
  const items = (node.items as Array<{ label: string; content: string | PrefabComponent }>) ?? []
  if (!items.length) return null
  return (
    <div className="w-full my-1">
      {node.title != null && <p className="text-xs font-semibold mb-1">{s(node.title)}</p>}
      <div className="rounded-md border border-border overflow-hidden">
        <div className="flex border-b border-border bg-muted overflow-x-auto">
          {items.map((tab, i) => (
            <button
              key={i}
              onClick={() => setActive(i)}
              className={cn(
                'px-3 py-1.5 text-xs font-medium whitespace-nowrap shrink-0 border-b-2 -mb-px transition-colors',
                i === active
                  ? 'border-primary text-primary bg-background'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {s(tab.label)}
            </button>
          ))}
        </div>
        <div className="p-3">
          {items[active] != null ? (
            typeof items[active].content === 'string'
              ? <p className="text-xs leading-relaxed">{s(items[active].content)}</p>
              : <NodeRenderer node={items[active].content as PrefabComponent} />
          ) : null}
        </div>
      </div>
    </div>
  )
}

// ── Stateful sub-components ───────────────────────────────────────────────────

// Widget version: Radix DialogTrigger supports asChild
function PrefabDialogNode({ node, s }: { node: PrefabComponent; s: (v: unknown) => string }) {
  const [open, setOpen] = useState(false)
  const content = (node.content as PrefabComponent[] | undefined) ?? []
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button className="inline-flex items-center rounded-lg border border-transparent bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90">
          {s(node.trigger ?? 'Open')}
        </button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          {node.title != null && <DialogTitle>{s(node.title)}</DialogTitle>}
          {node.description != null && <DialogDescription>{s(node.description)}</DialogDescription>}
        </DialogHeader>
        {content.map((c, i) => <NodeRenderer key={i} node={c} />)}
      </DialogContent>
    </Dialog>
  )
}

// Widget version: no @radix-ui/react-hover-card package — use Popover as click-to-open approximation
function WidgetHoverCardNode({ node, s }: { node: PrefabComponent; s: (v: unknown) => string }) {
  const [open, setOpen] = useState(false)
  const hcTrigger = node.trigger as PrefabComponent | undefined
  const hcContent = (node.content as PrefabComponent[] | undefined) ?? []
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <span
          className="cursor-pointer underline decoration-dotted text-sm inline-flex"
          onClick={() => setOpen(!open)}
        >
          {hcTrigger
            ? <NodeRenderer node={hcTrigger} />
            : s(node.label ?? 'hover')}
        </span>
      </PopoverTrigger>
      <PopoverContent
        side={(node.side as 'top' | 'bottom' | 'left' | 'right') ?? 'bottom'}
        className="text-xs"
      >
        <RenderChildren nodes={hcContent} />
      </PopoverContent>
    </Popover>
  )
}

function PrefabDatePickerNode({ node, s }: { node: PrefabComponent; s: (v: unknown) => string }) {
  const { state, onStateChange } = useContext(PrefabCtx)
  const [open, setOpen] = useState(false)
  const raw = state[node.key as string]
  const date = raw instanceof Date ? raw : undefined
  return (
    <div className="w-full my-1">
      {node.label != null && <label className="text-xs font-medium mb-1 block">{s(node.label)}</label>}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button className="flex w-full items-center rounded-md border border-input bg-background px-2 py-1.5 text-xs text-left">
            {date ? format(date, 'PPP') : s(node.placeholder ?? 'Pick a date')}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            selected={date}
            onSelect={d => { onStateChange(node.key as string, d); setOpen(false) }}
          />
        </PopoverContent>
      </Popover>
    </div>
  )
}

function PrefabDataTableNode({ node, s }: { node: PrefabComponent; s: (v: unknown) => string }) {
  type RowData = Record<string, unknown>
  const columns = (node.columns as Array<{ key: string; header: string }>) ?? []
  const rows = (node.rows as RowData[]) ?? []
  const pageSize = Number(node.pageSize ?? 5)
  const [sorting, setSorting] = useState<SortingState>([])
  const [globalFilter, setGlobalFilter] = useState('')
  const colDefs: ColumnDef<RowData>[] = columns.map(col => ({
    accessorKey: col.key,
    header: col.header,
    cell: info => String(info.getValue() ?? ''),
  }))
  const table = useReactTable({
    data: rows,
    columns: colDefs,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize } },
  })
  return (
    <div className="w-full my-1">
      {node.title != null && <p className="text-xs font-semibold mb-1">{s(node.title)}</p>}
      {Boolean(node.searchable) && (
        <input
          value={globalFilter}
          onChange={e => setGlobalFilter(e.target.value)}
          placeholder="Search..."
          className="w-full mb-2 rounded-md border border-input px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
        />
      )}
      <div className="rounded-md border overflow-hidden">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map(hg => (
              <TableRow key={hg.id}>
                {hg.headers.map(header => (
                  <TableHead
                    key={header.id}
                    className="text-xs cursor-pointer select-none"
                    onClick={header.column.getToggleSortingHandler()}
                  >
                    {flexRender(header.column.columnDef.header, header.getContext())}
                    {header.column.getIsSorted() === 'asc' ? ' ↑' : header.column.getIsSorted() === 'desc' ? ' ↓' : ''}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.map(row => (
              <TableRow key={row.id}>
                {row.getVisibleCells().map(cell => (
                  <TableCell key={cell.id} className="text-xs py-1.5">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {table.getPageCount() > 1 && (
        <div className="flex items-center justify-between mt-2">
          <button onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()} className="text-xs px-2 py-1 rounded border disabled:opacity-50">Prev</button>
          <span className="text-xs text-muted-foreground">{table.getState().pagination.pageIndex + 1} / {table.getPageCount()}</span>
          <button onClick={() => table.nextPage()} disabled={!table.getCanNextPage()} className="text-xs px-2 py-1 rounded border disabled:opacity-50">Next</button>
        </div>
      )}
    </div>
  )
}

// ── ForEach item — nested Provider so {{ item.x }} and {{ index }} resolve per iteration ──

function ForEachItem({ item, index, childNodes }: { item: unknown; index: number; childNodes: PrefabComponent[] }) {
  const ctx = useContext(PrefabCtx)
  const localCtx: PrefabCtxValue = { ...ctx, state: { ...ctx.state, item, index } }
  return (
    <PrefabCtx.Provider value={localCtx}>
      <RenderChildren nodes={childNodes} />
    </PrefabCtx.Provider>
  )
}

// ── Node renderer ─────────────────────────────────────────────────────────────

function NodeRenderer({ node }: { node: PrefabComponent }) {
  const { state, onStateChange, onAction, isDark, showToast, onSetInterval, onClearInterval } = useContext(PrefabCtx)
  const s = (val: unknown): string => interp(val, state)
  const act = (a: unknown): void => {
    const action = a as PrefabAction
    if (action.action === 'setInterval') {
      onSetInterval(action.key as string, Number(action.interval ?? 1000), (action.actions as PrefabAction[]) ?? [])
      return
    }
    if (action.action === 'clearInterval') {
      onClearInterval(action.key as string)
      return
    }
    execPrefabAction(action, state, onStateChange, onAction, showToast)
  }

  switch (node.type) {

    // ── Layout ────────────────────────────────────────────────────────────────
    case 'Stack':
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: _gap(node.gap) }}>
          <RenderChildren nodes={(node.children as PrefabComponent[] | undefined) ?? []} />
        </div>
      )

    case 'Row':
      return (
        <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: _gap(node.gap), alignItems: (node.align as string | undefined) ?? 'flex-start' }}>
          <RenderChildren nodes={(node.children as PrefabComponent[] | undefined) ?? []} />
        </div>
      )

    case 'Grid': {
      const cols = Math.max(1, Number(node.cols ?? 2))
      return (
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: _gap(node.gap) }}>
          <RenderChildren nodes={(node.children as PrefabComponent[] | undefined) ?? []} />
        </div>
      )
    }

    case 'Box':
      return (
        <div style={{ padding: _gap(node.p) }}>
          <RenderChildren nodes={(node.children as PrefabComponent[] | undefined) ?? []} />
        </div>
      )

    case 'Container': {
      const mxw: Record<string, string> = { sm: '384px', md: '512px', lg: '768px', xl: '1024px', full: '100%' }
      return (
        <div style={{ maxWidth: mxw[(node.maxW as string) ?? 'full'] ?? '100%', margin: '0 auto', padding: _gap(node.p ?? 0) }}>
          <RenderChildren nodes={(node.children as PrefabComponent[] | undefined) ?? []} />
        </div>
      )
    }

    case 'Divider':
      return <Separator className="my-1" />

    case 'Scroll':
      return (
        <ScrollArea className="w-full rounded-md border p-2" style={{ maxHeight: `${node.maxH ?? 200}px` }}>
          <RenderChildren nodes={(node.children as PrefabComponent[] | undefined) ?? []} />
        </ScrollArea>
      )

    // ── Typography ────────────────────────────────────────────────────────────
    case 'Heading': {
      const lvl = Math.min(Math.max(Number(node.level ?? 3), 1), 6)
      const cls = ['text-base font-bold', 'text-sm font-bold', 'text-xs font-bold', 'text-xs font-semibold', 'text-xs font-medium', 'text-xs'][lvl - 1]
      return <p className={cls}>{s(node.text)}</p>
    }

    case 'Text':
      return <p className="text-xs leading-relaxed text-foreground">{s(node.text)}</p>

    case 'Muted':
      return <p className="text-xs text-muted-foreground">{s(node.text)}</p>

    case 'Lead':
      return <p className="text-sm text-muted-foreground leading-relaxed">{s(node.text)}</p>

    case 'Large':
      return <p className="text-sm font-semibold">{s(node.text)}</p>

    case 'Small':
      return <small className="text-xs font-medium leading-none">{s(node.text)}</small>

    case 'Blockquote':
      return <blockquote className="border-l-2 border-border pl-3 italic text-xs text-muted-foreground my-1">{s(node.text)}</blockquote>

    case 'InlineCode':
      return <code className="relative rounded bg-muted px-1 py-0.5 font-mono text-xs">{s(node.text)}</code>

    case 'Code':
      return (
        <pre className="rounded-md bg-muted p-2 overflow-x-auto my-1">
          <code className="text-xs font-mono">{s(node.text)}</code>
        </pre>
      )

    // ── Containers ────────────────────────────────────────────────────────────
    case 'Card':
      return (
        <Card className="w-full my-2">
          {node.title != null && (
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">{s(node.title)}</CardTitle>
            </CardHeader>
          )}
          <CardContent className="pt-0 pb-3">
            <RenderChildren nodes={(node.children as PrefabComponent[] | undefined) ?? []} />
          </CardContent>
        </Card>
      )

    case 'Tabs':
      return <PrefabTabsNode node={node} s={s} />

    case 'Accordion': {
      const accItems = (node.items as Array<{ title: string; content: string | PrefabComponent }>) ?? []
      return (
        <div className="w-full my-1 space-y-1">
          {node.title != null && <p className="text-xs font-semibold mb-1">{s(node.title)}</p>}
          {accItems.map((item, i) => (
            <details key={i} className="rounded-md border border-border overflow-hidden">
              <summary className="cursor-pointer px-3 py-2 text-xs font-medium bg-muted hover:bg-muted/80 select-none list-none flex items-center justify-between">
                <span>{s(item.title)}</span>
                <span className="text-muted-foreground ml-2 shrink-0">›</span>
              </summary>
              <div className="px-3 py-2 text-xs text-muted-foreground leading-relaxed bg-background">
                {typeof item.content === 'string'
                  ? <p>{s(item.content)}</p>
                  : <NodeRenderer node={item.content as PrefabComponent} />}
              </div>
            </details>
          ))}
        </div>
      )
    }

    case 'Alert': {
      const alertVariant = (node.variant as string) ?? 'info'
      const alertCls = _ALERT_CLS[alertVariant] ?? _ALERT_CLS.info
      return (
        <div className={cn('rounded-md border p-3 my-1 text-xs', alertCls)}>
          {node.title != null && <p className="font-semibold mb-0.5">{s(node.title)}</p>}
          {node.text != null && <p className="leading-relaxed">{s(node.text)}</p>}
          {(node.children as PrefabComponent[] | undefined)?.length ? (
            <RenderChildren nodes={node.children as PrefabComponent[]} />
          ) : null}
        </div>
      )
    }

    case 'Carousel': {
      const items = (node.items as Array<{ src: string; alt?: string; caption?: string }>) ?? []
      const childNodes = (node.children as PrefabComponent[] | undefined) ?? []
      if (!items.length && !childNodes.length) return null
      return (
        <div className="w-full my-1">
          {node.title != null && <p className="text-xs font-semibold mb-1">{s(node.title)}</p>}
          <Carousel className="w-full">
            <CarouselContent>
              {items.length ? items.map((item, i) => (
                <CarouselItem key={i}>
                  <img src={s(item.src)} alt={s(item.alt ?? '')} className="w-full rounded-md object-cover max-h-40" />
                  {item.caption != null && <p className="text-xs text-muted-foreground text-center mt-1">{s(item.caption)}</p>}
                </CarouselItem>
              )) : childNodes.map((c, i) => (
                <CarouselItem key={i}><NodeRenderer node={c} /></CarouselItem>
              ))}
            </CarouselContent>
            <CarouselPrevious />
            <CarouselNext />
          </Carousel>
        </div>
      )
    }

    // ── Display ───────────────────────────────────────────────────────────────

    case 'Avatar': {
      const szCls = (node.size as string) === 'lg' ? 'size-12' : (node.size as string) === 'sm' ? 'size-6' : 'size-8'
      return (
        <Avatar className={szCls}>
          {node.src != null && <AvatarImage src={s(node.src)} alt={s(node.alt ?? '')} />}
          <AvatarFallback className="text-xs">{s(node.fallback ?? '?')}</AvatarFallback>
        </Avatar>
      )
    }

    case 'Skeleton':
      return (
        <Skeleton
          className={cn(
            'my-1',
            (node.rounded as string) === 'full' ? 'rounded-full' : (node.rounded as string) === 'none' ? 'rounded-none' : 'rounded-md',
          )}
          style={{
            height: node.h ? `${Number(node.h) * 4}px` : '16px',
            width: node.w === 'full' || node.w == null ? '100%' : `${Number(node.w) * 4}px`,
          }}
        />
      )

    case 'Spinner': {
      const szCls = (node.size as string) === 'lg' ? 'size-6' : (node.size as string) === 'sm' ? 'size-3' : 'size-4'
      return (
        <div className="flex items-center gap-2 my-1">
          <Spinner className={szCls} />
          {node.label != null && <span className="text-xs text-muted-foreground">{s(node.label)}</span>}
        </div>
      )
    }

    case 'Empty':
      return (
        <Empty>
          <EmptyHeader>
            {node.icon != null && <EmptyMedia variant="icon"><span className="text-lg">{s(node.icon)}</span></EmptyMedia>}
            {node.title != null && <EmptyTitle>{s(node.title)}</EmptyTitle>}
            {node.description != null && <EmptyDescription>{s(node.description)}</EmptyDescription>}
          </EmptyHeader>
          {(node.children as PrefabComponent[] | undefined)?.length ? (
            <EmptyContent><RenderChildren nodes={node.children as PrefabComponent[]} /></EmptyContent>
          ) : null}
        </Empty>
      )

    case 'Field':
      return (
        <div className="flex justify-between items-center py-1.5 gap-2 border-b border-border last:border-0">
          <span className="text-xs text-muted-foreground shrink-0">{s(node.label)}</span>
          <span className="text-xs font-medium text-right">{s(node.value)}</span>
        </div>
      )

    case 'Stat': {
      const delta = node.delta as string | undefined
      const deltaPos = delta != null && !delta.startsWith('-') && !delta.startsWith('−')
      return (
        <div className="text-center p-2">
          <p className="text-xs text-muted-foreground">{s(node.label)}</p>
          <p className="text-xl font-bold">{s(node.value)}</p>
          {delta != null && (
            <p className={cn('text-xs font-medium', deltaPos ? 'text-green-600' : 'text-red-600')}>{s(delta)}</p>
          )}
        </div>
      )
    }

    case 'Badge': {
      const bv = (node.variant as string) ?? 'secondary'
      const bVariant = (['default', 'secondary', 'outline'].includes(bv) ? bv : 'outline') as 'default' | 'secondary' | 'outline'
      const bExtra = bv === 'success' ? 'bg-green-100 text-green-800' : bv === 'warning' ? 'bg-yellow-100 text-yellow-800' : bv === 'error' ? 'bg-red-100 text-red-800' : ''
      return <Badge variant={bVariant} className={cn('text-xs', bExtra)}>{s(node.text)}</Badge>
    }

    case 'Tag': {
      const tagItems = (node.items as Array<{ text: string; variant?: string }>) ?? []
      return (
        <div className="flex flex-wrap gap-1.5">
          {tagItems.map((item, i) => {
            const tv = item.variant ?? 'secondary'
            const tbv = (['default', 'secondary', 'outline'].includes(tv) ? tv : 'outline') as 'default' | 'secondary' | 'outline'
            const tec = tv === 'success' ? 'bg-green-100 text-green-800' : tv === 'warning' ? 'bg-yellow-100 text-yellow-800' : tv === 'error' ? 'bg-red-100 text-red-800' : ''
            return <Badge key={i} variant={tbv} className={cn('text-xs', tec)}>{s(item.text)}</Badge>
          })}
        </div>
      )
    }

    case 'Progress': {
      const pct = Math.max(0, Math.min(100, Number(node.value ?? 0)))
      return (
        <div className="w-full my-1">
          <div className="flex justify-between items-center mb-0.5">
            <span className="text-xs text-muted-foreground">{s(node.label ?? '')}</span>
            <span className="text-xs font-medium">{pct}%</span>
          </div>
          <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
            <div className="h-full bg-primary rounded-full" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )
    }

    // ── Tables and lists ──────────────────────────────────────────────────────
    case 'Table': {
      const tCols = (node.columns as string[] | undefined) ?? []
      const tRows = (node.rows as Array<(string | number)[]> | undefined) ?? []
      if (!tCols.length) return null
      return (
        <div className="w-full my-1">
          {node.title != null && <p className="text-xs font-semibold mb-1">{s(node.title)}</p>}
          <ScrollArea className="w-full rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  {tCols.map((h, i) => <TableHead key={i} className="text-xs whitespace-nowrap">{s(h)}</TableHead>)}
                </TableRow>
              </TableHeader>
              <TableBody>
                {tRows.map((row, ri) => (
                  <TableRow key={ri}>
                    {row.map((cell, ci) => (
                      <TableCell key={ci} className="text-xs whitespace-nowrap py-1.5">{s(cell)}</TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </ScrollArea>
        </div>
      )
    }

    case 'DataTable':
      return <PrefabDataTableNode node={node} s={s} />

    case 'List': {
      const listItems = (node.items as Array<{ text: string; icon?: string }>) ?? []
      const ordered = Boolean(node.ordered)
      return (
        <div className="w-full my-1">
          {node.title != null && <p className="text-xs font-semibold mb-1">{s(node.title)}</p>}
          <ul className="space-y-1">
            {listItems.map((item, i) => (
              <li key={i} className="flex items-start gap-2 text-xs">
                <span className="shrink-0 text-muted-foreground">
                  {item.icon ? item.icon : ordered ? `${i + 1}.` : '•'}
                </span>
                <span>{s(item.text)}</span>
              </li>
            ))}
          </ul>
        </div>
      )
    }

    // ── Media ─────────────────────────────────────────────────────────────────
    case 'Image':
      return (
        <div className="w-full my-1">
          <img src={s(node.src)} alt={s(node.alt ?? '')} className="w-full rounded-md object-cover max-h-40" />
          {node.caption != null && <p className="text-xs text-muted-foreground mt-1 text-center">{s(node.caption)}</p>}
        </div>
      )

    case 'Map': {
      const mapPins = (node.pins as Array<{ lat: number; lng: number; label?: string }>) ?? []
      if (!mapPins.length) return null
      const mlats = mapPins.map(p => p.lat)
      const mlngs = mapPins.map(p => p.lng)
      const mcLat = (Math.min(...mlats) + Math.max(...mlats)) / 2
      const mcLng = (Math.min(...mlngs) + Math.max(...mlngs)) / 2
      const mZoom = mapPins.length === 1 ? 12 : 5
      return (
        <div className="w-full my-1">
          {node.title != null && <p className="text-xs font-semibold mb-1">{s(node.title)}</p>}
          <div className="rounded-md overflow-hidden border" style={{ height: 200 }}>
            <MapContainer center={[mcLat, mcLng]} zoom={mZoom} style={{ height: '100%', width: '100%' }} scrollWheelZoom={false}>
              <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
              {mapPins.map((pin, i) => (
                <Marker key={i} position={[pin.lat, pin.lng]}>
                  {pin.label && <Popup>{pin.label}</Popup>}
                </Marker>
              ))}
            </MapContainer>
          </div>
        </div>
      )
    }

    case 'Timeline': {
      const tlEvents = (node.events as Array<{ date: string; title: string; text?: string }>) ?? []
      return (
        <div className="w-full my-1">
          {node.title != null && <p className="text-xs font-semibold mb-2">{s(node.title)}</p>}
          <div className="space-y-0">
            {tlEvents.map((ev, i) => (
              <div key={i} className="flex gap-3">
                <div className="flex flex-col items-center">
                  <div className="h-2 w-2 rounded-full bg-primary mt-1 shrink-0" />
                  {i < tlEvents.length - 1 && <Separator orientation="vertical" className="flex-1 my-1" />}
                </div>
                <div className="pb-3">
                  <p className="text-xs font-semibold text-muted-foreground">{s(ev.date)}</p>
                  <p className="text-xs font-medium">{s(ev.title)}</p>
                  {ev.text != null && <p className="text-xs text-muted-foreground mt-0.5">{s(ev.text)}</p>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )
    }

    case 'Chart': {
      const cType = (node.chartType as string) ?? 'bar'
      // Null-guard: coerce null/undefined labels to 'Item N' and series names to 'Series N'
      const cLabels = ((node.labels as string[]) ?? []).map((l, i) => (l != null ? String(l) : `Item ${i + 1}`))
      const rawSeries = (node.series as Array<{ name: string; values: number[]; color?: string }>) ?? []
      const cSeries = rawSeries.map((ser, i) => ({
        ...ser,
        name: ser.name != null && ser.name !== '' ? String(ser.name) : `Series ${i + 1}`,
        values: (ser.values ?? []).map(v => (v == null || !Number.isFinite(Number(v)) ? 0 : Number(v))),
      }))
      if (!cLabels.length && cType !== 'scatter' && cType !== 'sankey') return null
      const axisColor = isDark ? '#71717a' : '#a1a1aa'
      const gridColor = isDark ? '#3f3f46' : '#e4e4e7'
      const cData = cLabels.map((label, li) => {
        const entry: Record<string, string | number> = { name: label }
        cSeries.forEach(ser => { entry[ser.name] = ser.values[li] ?? 0 })
        return entry
      })
      const cPie = cLabels.map((label, i) => ({ name: label, value: cSeries[0]?.values[i] ?? 0 }))

      const renderInner = () => {
        switch (cType) {
          case 'line':
            return (
              <ReLineChart data={cData} margin={{ top: 4, right: 8, left: -16, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
                <XAxis dataKey="name" tick={{ fontSize: 9, fill: axisColor }} />
                <YAxis tick={{ fontSize: 9, fill: axisColor }} />
                <RechartsTooltip contentStyle={{ fontSize: 10 }} />
                {cSeries.length > 1 && <Legend iconSize={8} wrapperStyle={{ fontSize: 9 }} />}
                {cSeries.map((ser, i) => (
                  <Line key={ser.name} type="monotone" dataKey={ser.name} stroke={col(i, ser.color)} strokeWidth={2} dot={{ r: 3 }} />
                ))}
              </ReLineChart>
            )
          case 'area':
            return (
              <ReAreaChart data={cData} margin={{ top: 4, right: 8, left: -16, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
                <XAxis dataKey="name" tick={{ fontSize: 9, fill: axisColor }} />
                <YAxis tick={{ fontSize: 9, fill: axisColor }} />
                <RechartsTooltip contentStyle={{ fontSize: 10 }} />
                {cSeries.length > 1 && <Legend iconSize={8} wrapperStyle={{ fontSize: 9 }} />}
                {cSeries.map((ser, i) => (
                  <Area key={ser.name} type="monotone" dataKey={ser.name} stroke={col(i, ser.color)} fill={col(i, ser.color)} fillOpacity={0.25} strokeWidth={2} />
                ))}
              </ReAreaChart>
            )
          case 'pie':
            return (
              <RePieChart>
                <Pie data={cPie} cx="50%" cy="50%" outerRadius={55} dataKey="value">
                  {cPie.map((_, i) => <Cell key={i} fill={col(i, cSeries[0]?.color)} />)}
                </Pie>
                <RechartsTooltip contentStyle={{ fontSize: 10 }} />
                <Legend iconSize={8} wrapperStyle={{ fontSize: 9 }} />
              </RePieChart>
            )
          case 'radar':
            return (
              <ReRadarChart cx="50%" cy="50%" outerRadius="80%" data={cData}>
                <PolarGrid />
                <PolarAngleAxis dataKey="name" tick={{ fontSize: 10 }} />
                <PolarRadiusAxis tick={{ fontSize: 9 }} />
                {cSeries.map((ser, i) => (
                  <Radar key={ser.name} dataKey={ser.name} stroke={col(i, ser.color)} fill={col(i, ser.color)} fillOpacity={0.25} />
                ))}
                {cSeries.length > 1 && <Legend iconSize={8} wrapperStyle={{ fontSize: 9 }} />}
                <RechartsTooltip contentStyle={{ fontSize: 10 }} />
              </ReRadarChart>
            )
          case 'radialBar': {
            const rbData = cPie.map((d, i) => ({ ...d, fill: col(i) }))
            return (
              <ReRadialBarChart cx="50%" cy="50%" innerRadius="20%" outerRadius="80%" data={rbData}>
                <RadialBar dataKey="value" label={{ position: 'insideStart', fill: '#fff', fontSize: 10 }}>
                  {rbData.map((_, i) => <Cell key={i} fill={col(i)} />)}
                </RadialBar>
                <Legend iconSize={8} wrapperStyle={{ fontSize: 9 }} />
                <RechartsTooltip contentStyle={{ fontSize: 10 }} />
              </ReRadialBarChart>
            )
          }
          case 'scatter': {
            const pts = (node.points as Array<{ x: number; y: number; z?: number }> | undefined) ??
              cLabels.map((_, i) => ({ x: i, y: cSeries[0]?.values[i] ?? 0 }))
            return (
              <ReScatterChart margin={{ top: 4, right: 8, left: -16, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
                <XAxis dataKey="x" type="number" name="x" tick={{ fontSize: 9, fill: axisColor }} />
                <YAxis dataKey="y" type="number" name="y" tick={{ fontSize: 9, fill: axisColor }} />
                <ZAxis range={[40, 400]} />
                <RechartsTooltip cursor={{ strokeDasharray: '3 3' }} contentStyle={{ fontSize: 10 }} />
                <Scatter data={pts} fill={col(0, cSeries[0]?.color)} />
              </ReScatterChart>
            )
          }
          case 'composed':
            return (
              <ReComposedChart data={cData} margin={{ top: 4, right: 8, left: -16, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
                <XAxis dataKey="name" tick={{ fontSize: 9, fill: axisColor }} />
                <YAxis tick={{ fontSize: 9, fill: axisColor }} />
                <RechartsTooltip contentStyle={{ fontSize: 10 }} />
                {cSeries.length > 1 && <Legend iconSize={8} wrapperStyle={{ fontSize: 9 }} />}
                {cSeries.map((ser, i) =>
                  i === 0
                    ? <Bar key={ser.name} dataKey={ser.name} fill={col(i, ser.color)} radius={[2, 2, 0, 0]} />
                    : <Line key={ser.name} type="monotone" dataKey={ser.name} stroke={col(i, ser.color)} strokeWidth={2} dot={false} />
                )}
              </ReComposedChart>
            )
          case 'treemap': {
            const tmData = cLabels.map((name, i) => ({ name, size: cSeries[0]?.values[i] ?? 0, fill: col(i, cSeries[0]?.color) }))
            return (
              <ReTreemap data={tmData} dataKey="size" nameKey="name" stroke="#fff">
                {tmData.map((entry, i) => <Cell key={i} fill={entry.fill} />)}
              </ReTreemap>
            )
          }
          case 'funnel': {
            const fnData = cLabels.map((name, i) => ({ name, value: cSeries[0]?.values[i] ?? 0, fill: col(i) }))
            return (
              <ReFunnelChart>
                <Funnel dataKey="value" data={fnData}>
                  <LabelList position="right" fill="#888" stroke="none" dataKey="name" />
                  {fnData.map((entry, i) => <Cell key={i} fill={entry.fill} />)}
                </Funnel>
                <RechartsTooltip contentStyle={{ fontSize: 10 }} />
              </ReFunnelChart>
            )
          }
          case 'sankey': {
            const snNodes = (node.nodes as Array<{ name: string }>) ?? []
            const snLinks = (node.links as Array<{ source: number; target: number; value: number }>) ?? []
            if (!snNodes.length || !snLinks.length) return null
            return (
              <ReSankey
                data={{ nodes: snNodes, links: snLinks }}
                nodePadding={50}
                nodeWidth={10}
              >
                <RechartsTooltip contentStyle={{ fontSize: 10 }} />
              </ReSankey>
            )
          }
          default:
            return (
              <ReBarChart data={cData} margin={{ top: 4, right: 8, left: -16, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
                <XAxis dataKey="name" tick={{ fontSize: 9, fill: axisColor }} />
                <YAxis tick={{ fontSize: 9, fill: axisColor }} />
                <RechartsTooltip contentStyle={{ fontSize: 10 }} />
                {cSeries.length > 1 && <Legend iconSize={8} wrapperStyle={{ fontSize: 9 }} />}
                {cSeries.map((ser, i) => (
                  <Bar key={ser.name} dataKey={ser.name} fill={col(i, ser.color)} radius={[2, 2, 0, 0]} />
                ))}
              </ReBarChart>
            )
        }
      }

      return (
        <div className="w-full my-1">
          {node.title != null && <p className="text-xs font-semibold mb-1">{s(node.title)}</p>}
          <div style={{ width: '100%', height: 160, minWidth: 300 }}>
            <ChartErrorBoundary>
              <ResponsiveContainer width="100%" height="100%">
                {renderInner()}
              </ResponsiveContainer>
            </ChartErrorBoundary>
          </div>
        </div>
      )
    }

    // ── Interactive — overlays ─────────────────────────────────────────────────

    case 'Tooltip': {
      const ttChildren = (node.children as PrefabComponent[] | undefined) ?? []
      return (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger className="inline-flex cursor-help">
              {ttChildren.length
                ? <span><RenderChildren nodes={ttChildren} /></span>
                : <span className="underline decoration-dotted text-xs">{s(node.label ?? '')}</span>}
            </TooltipTrigger>
            <TooltipContent side={(node.side as 'top' | 'bottom' | 'left' | 'right') ?? 'top'}>
              <p>{s(node.content ?? '')}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )
    }

    case 'HoverCard':
      return <WidgetHoverCardNode node={node} s={s} />

    case 'Dialog':
      return <PrefabDialogNode node={node} s={s} />

    // ── Interactive — forms ───────────────────────────────────────────────────

    case 'Input': {
      const inputKey = node.key as string
      const inputVal = String(state[inputKey] ?? '')
      return (
        <div className="w-full my-1">
          {node.label != null && <label className="text-xs font-medium mb-1 block">{s(node.label)}</label>}
          <Input
            type={(node.inputType as string) ?? 'text'}
            value={inputVal}
            placeholder={s(node.placeholder ?? '')}
            onChange={e => onStateChange(inputKey, e.target.value)}
            className="h-7 text-xs"
          />
        </div>
      )
    }

    case 'Textarea': {
      const taKey = node.key as string
      const taVal = String(state[taKey] ?? '')
      return (
        <div className="w-full my-1">
          {node.label != null && <label className="text-xs font-medium mb-1 block">{s(node.label)}</label>}
          <Textarea
            value={taVal}
            placeholder={s(node.placeholder ?? '')}
            rows={Number(node.rows ?? 3)}
            onChange={e => onStateChange(taKey, e.target.value)}
            className="text-xs resize-none"
          />
        </div>
      )
    }

    case 'Select': {
      const selKey = node.key as string
      const selVal = String(state[selKey] ?? '')
      const options = (node.options as Array<{ value: string; label: string }>) ?? []
      return (
        <div className="w-full my-1">
          {node.label != null && <label className="text-xs font-medium mb-1 block">{s(node.label)}</label>}
          <Select value={selVal} onValueChange={v => onStateChange(selKey, v)}>
            <SelectTrigger className="w-full text-xs">
              <SelectValue placeholder={s(node.placeholder ?? 'Select...')} />
            </SelectTrigger>
            <SelectContent>
              {options.map((opt, i) => (
                <SelectItem key={i} value={opt.value}>{s(opt.label)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )
    }

    case 'Checkbox': {
      const cbKey = node.key as string
      const cbChecked = Boolean(state[cbKey])
      return (
        <label className="flex items-center gap-2 cursor-pointer my-1">
          <input
            type="checkbox"
            checked={cbChecked}
            onChange={e => {
              onStateChange(cbKey, e.target.checked)
              const action = node.action as PrefabAction | undefined
              if (action) act(action)
            }}
            className="rounded border-input"
          />
          {node.label != null && <span className="text-xs">{s(node.label)}</span>}
        </label>
      )
    }

    case 'RadioGroup': {
      const rgKey = node.key as string
      const rgVal = String(state[rgKey] ?? '')
      const options = (node.options as Array<{ value: string; label: string }>) ?? []
      return (
        <div className="w-full my-1">
          {node.label != null && <p className="text-xs font-medium mb-1">{s(node.label)}</p>}
          <div className="flex flex-col gap-1">
            {options.map((opt, i) => (
              <label key={i} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name={rgKey}
                  value={opt.value}
                  checked={rgVal === opt.value}
                  onChange={() => {
                    onStateChange(rgKey, opt.value)
                    const action = node.action as PrefabAction | undefined
                    if (action) act(action)
                  }}
                />
                <span className="text-xs">{s(opt.label)}</span>
              </label>
            ))}
          </div>
        </div>
      )
    }

    case 'Slider': {
      const slKey = node.key as string
      const slVal = Number(state[slKey] ?? node.defaultValue ?? 50)
      const slMin = Number(node.min ?? 0)
      const slMax = Number(node.max ?? 100)
      const slStep = Number(node.step ?? 1)
      return (
        <div className="w-full my-1">
          <div className="flex justify-between items-center mb-1">
            {node.label != null && <label className="text-xs font-medium">{s(node.label)}</label>}
            <span className="text-xs text-muted-foreground">{slVal}</span>
          </div>
          <input
            type="range"
            min={slMin}
            max={slMax}
            step={slStep}
            value={slVal}
            onChange={e => onStateChange(slKey, Number(e.target.value))}
            className="w-full accent-primary"
          />
        </div>
      )
    }

    case 'Switch': {
      const swKey = node.key as string
      const swChecked = Boolean(state[swKey])
      return (
        <label className="flex items-center gap-2 cursor-pointer my-1">
          <div
            className={cn(
              'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border-2 border-transparent transition-colors cursor-pointer',
              swChecked ? 'bg-primary' : 'bg-input',
            )}
            onClick={() => {
              const next = !swChecked
              onStateChange(swKey, next)
              const action = node.action as PrefabAction | undefined
              if (action) act(action)
            }}
            role="switch"
            aria-checked={swChecked}
            tabIndex={0}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') {
                onStateChange(swKey, !swChecked)
              }
            }}
          >
            <span className={cn('pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg transition-transform', swChecked ? 'translate-x-4' : 'translate-x-0')} />
          </div>
          {node.label != null && <span className="text-xs">{s(node.label)}</span>}
        </label>
      )
    }

    case 'DatePicker':
      return <PrefabDatePickerNode node={node} s={s} />

    // ── Interactive — buttons ─────────────────────────────────────────────────

    case 'Button': {
      const btnAction = node.action as PrefabAction | undefined
      const btnV = (node.variant as 'default' | 'outline' | 'secondary' | 'ghost' | 'destructive') ?? 'default'
      return (
        <Button
          variant={btnV}
          size="sm"
          onClick={() => btnAction && act(btnAction)}
          disabled={!btnAction}
        >
          {s(node.label)}
        </Button>
      )
    }

    case 'Actions': {
      const actBtns = (node.buttons as Array<{ label: string; action: PrefabAction; variant?: string }>) ?? []
      return (
        <div className="flex flex-wrap gap-2 my-1">
          {node.title != null && <p className="text-xs text-muted-foreground w-full mb-1">{s(node.title)}</p>}
          {actBtns.map((btn, i) => (
            <Button
              key={i}
              variant={(btn.variant ?? 'default') as 'default' | 'outline' | 'secondary' | 'ghost' | 'destructive'}
              size="sm"
              onClick={() => act(btn.action)}
            >
              {s(btn.label)}
            </Button>
          ))}
        </div>
      )
    }

    // ── Control flow ──────────────────────────────────────────────────────────

    case 'Condition': {
      const cases = (node.cases as Array<{ when: string; children: PrefabComponent[] }>) ?? []
      const elseBranch = node.else as { children: PrefabComponent[] } | undefined
      for (const c of cases) {
        if (evalCondition(c.when ?? '', state)) {
          return <RenderChildren nodes={c.children ?? []} />
        }
      }
      if (elseBranch?.children?.length) {
        return <RenderChildren nodes={elseBranch.children} />
      }
      return null
    }

    case 'ForEach': {
      const rawItems = resolveValue(node.items, state)
      if (!Array.isArray(rawItems) || rawItems.length === 0) return null
      const childTemplates = (node.children as PrefabComponent[] | undefined) ?? []
      return (
        <>
          {rawItems.map((item, idx) => (
            <ForEachItem key={idx} item={item} index={idx} childNodes={childTemplates} />
          ))}
        </>
      )
    }

    default:
      return <div className="text-xs text-muted-foreground italic">[{node.type}]</div>
  }
}

// ── Prefab renderer ───────────────────────────────────────────────────────────

function PrefabRenderer({ envelope, isDark, onAction }: {
  envelope: PrefabEnvelope
  isDark: boolean
  onAction: (msg: string) => void
}) {
  const [state, setStateMap] = useState<Record<string, unknown>>(envelope.state ?? {})
  const [toastMsg, setToastMsg] = useState<string | null>(null)
  // stateRef keeps interval ticks from reading stale state via closure
  const stateRef = useRef<Record<string, unknown>>(envelope.state ?? {})
  // intervalIds stored in ref — no re-render when intervals are set/cleared
  const intervalIds = useRef<Record<string, ReturnType<typeof setInterval>>>({})

  useEffect(() => {
    if (!toastMsg) return
    const id = setTimeout(() => setToastMsg(null), 3000)
    return () => clearTimeout(id)
  }, [toastMsg])

  // Clear all intervals on unmount
  useEffect(() => {
    return () => { Object.values(intervalIds.current).forEach(id => clearInterval(id)) }
  }, [])

  const onStateChange = useCallback((k: string, v: unknown | ((prev: unknown) => unknown)) =>
    setStateMap(prev => {
      const resolved = typeof v === 'function' ? (v as (p: unknown) => unknown)(prev[k]) : v
      const next = { ...prev, [k]: resolved }
      stateRef.current = next
      return next
    }), [])

  const onSetIntervalCb = useCallback((key: string, ms: number, actions: PrefabAction[]) => {
    if (intervalIds.current[key] !== undefined) clearInterval(intervalIds.current[key])
    intervalIds.current[key] = setInterval(() => {
      actions.forEach(a => execPrefabAction(a, stateRef.current, onStateChange, onAction, setToastMsg))
    }, ms)
  }, [onStateChange, onAction])

  const onClearIntervalCb = useCallback((key: string) => {
    if (intervalIds.current[key] !== undefined) {
      clearInterval(intervalIds.current[key])
      delete intervalIds.current[key]
    }
  }, [])

  const ctxValue = useMemo<PrefabCtxValue>(() => ({
    state,
    onStateChange,
    onAction,
    isDark,
    showToast: setToastMsg,
    onSetInterval: onSetIntervalCb,
    onClearInterval: onClearIntervalCb,
  }), [state, onStateChange, onAction, isDark, onSetIntervalCb, onClearIntervalCb])
  return (
    <>
      <PrefabCtx.Provider value={ctxValue}>
        <div className={cn('a2ui-root', isDark && 'dark')}>
          <NodeRenderer node={envelope.view} />
        </div>
      </PrefabCtx.Provider>
      {toastMsg && (
        <div
          role="status"
          style={{ position: 'fixed', bottom: 16, right: 16, zIndex: 9999 }}
          className="rounded-lg bg-zinc-900 text-white px-4 py-2.5 text-xs shadow-lg max-w-xs"
        >
          {toastMsg}
        </div>
      )}
    </>
  )
}

function isPrefabEnvelope(payload: A2UIPayload | PrefabEnvelope): payload is PrefabEnvelope {
  return typeof (payload as PrefabEnvelope).version === 'string' && 'view' in payload
}

// ── Main export ───────────────────────────────────────────────────────────────

export function A2UIRenderer({ payload, isDark, onAction }: {
  payload: A2UIPayload | PrefabEnvelope
  isDark: boolean
  onAction?: (message: string) => void
}) {
  if (isPrefabEnvelope(payload)) {
    return <PrefabRenderer envelope={payload} isDark={isDark} onAction={onAction ?? (() => {})} />
  }
  const p = payload as A2UIPayload
  return (
    <div className={cn('a2ui-root', isDark && 'dark')}>
      {(() => {
        switch (p.type) {
          case 'card':      return <CardRenderer payload={p} />
          case 'table':     return <TableRenderer payload={p} />
          case 'list':      return <ListRenderer payload={p} />
          case 'timeline':  return <TimelineRenderer payload={p} />
          case 'map':       return <MapRenderer payload={p} />
          case 'chart':     return <ChartRenderer payload={p} isDark={isDark} />
          case 'accordion': return <AccordionRenderer payload={p} />
          case 'tabs':      return <TabsRenderer payload={p} isDark={isDark} onAction={onAction} />
          case 'progress':  return <ProgressRenderer payload={p} />
          case 'badge':     return <BadgeGroupRenderer payload={p} />
          case 'actions':   return <ActionsRenderer payload={p} onAction={onAction} />
          default:          return <PlainRenderer payload={p} />
        }
      })()}
    </div>
  )
}
