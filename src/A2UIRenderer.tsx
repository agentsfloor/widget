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

import 'leaflet/dist/leaflet.css'

import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet'
import L from 'leaflet'
import {
  BarChart as ReBarChart, Bar,
  LineChart as ReLineChart, Line,
  PieChart as RePieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'

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

// ── Charts (recharts) ─────────────────────────────────────────────────────────

function ChartRenderer({ payload, isDark }: { payload: A2UIPayload; isDark: boolean }) {
  const d = payload.data as ChartData
  if (!d?.series?.length || !d?.labels?.length) return null

  const chartType = d.chartType ?? 'bar'
  const axisColor = isDark ? '#71717a' : '#a1a1aa'
  const gridColor = isDark ? '#3f3f46' : '#e4e4e7'

  // Reshape data into recharts format: [{name: 'label', SeriesA: val, SeriesB: val}]
  const chartData = d.labels.map((label, li) => {
    const entry: Record<string, string | number> = { name: label }
    d.series.forEach(s => { entry[s.name] = s.values[li] ?? 0 })
    return entry
  })

  const pieData = d.labels.map((label, i) => ({
    name: label,
    value: d.series[0]?.values[i] ?? 0,
  }))

  return (
    <div className="w-full my-2">
      {payload.title && (
        <p className="text-xs font-semibold mb-1 text-foreground">{payload.title}</p>
      )}
      <div style={{ width: '100%', height: 160 }}>
        <ResponsiveContainer width="100%" height="100%">
          {chartType === 'line' ? (
            <ReLineChart data={chartData} margin={{ top: 4, right: 8, left: -16, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
              <XAxis dataKey="name" tick={{ fontSize: 9, fill: axisColor }} />
              <YAxis tick={{ fontSize: 9, fill: axisColor }} />
              <Tooltip contentStyle={{ fontSize: 10 }} />
              {d.series.length > 1 && <Legend iconSize={8} wrapperStyle={{ fontSize: 9 }} />}
              {d.series.map((s, i) => (
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
                  <Cell key={i} fill={col(i, d.series[0]?.color)} />
                ))}
              </Pie>
              <Tooltip contentStyle={{ fontSize: 10 }} />
              <Legend iconSize={8} wrapperStyle={{ fontSize: 9 }} />
            </RePieChart>
          ) : (
            /* bar (default) */
            <ReBarChart data={chartData} margin={{ top: 4, right: 8, left: -16, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
              <XAxis dataKey="name" tick={{ fontSize: 9, fill: axisColor }} />
              <YAxis tick={{ fontSize: 9, fill: axisColor }} />
              <Tooltip contentStyle={{ fontSize: 10 }} />
              {d.series.length > 1 && <Legend iconSize={8} wrapperStyle={{ fontSize: 9 }} />}
              {d.series.map((s, i) => (
                <Bar key={s.name} dataKey={s.name} fill={col(i, s.color)} radius={[2, 2, 0, 0]} />
              ))}
            </ReBarChart>
          )}
        </ResponsiveContainer>
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

// ── Main export ───────────────────────────────────────────────────────────────

export function A2UIRenderer({ payload, isDark }: { payload: A2UIPayload; isDark: boolean }) {
  return (
    // Toggle `dark` class so Tailwind dark: variants activate based on isDark prop
    <div className={cn('a2ui-root', isDark && 'dark')}>
      {(() => {
        switch (payload.type) {
          case 'card':     return <CardRenderer payload={payload} />
          case 'table':    return <TableRenderer payload={payload} />
          case 'list':     return <ListRenderer payload={payload} />
          case 'timeline': return <TimelineRenderer payload={payload} />
          case 'map':      return <MapRenderer payload={payload} />
          case 'chart':    return <ChartRenderer payload={payload} isDark={isDark} />
          default:         return <PlainRenderer payload={payload} />
        }
      })()}
    </div>
  )
}
