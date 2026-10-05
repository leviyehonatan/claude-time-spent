import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BgTask, Phase, PhaseSeg, Req, RunningCall, StepStat, SubSpan, ToolSpan, Totals, TurnRecord, ViewMode } from '../types'

const turns = atom({ plugin: 'time-spent', key: 'turns' } as const, [])
const mode = atom({ plugin: 'time-spent', key: 'mode' } as const, 'timeline' as ViewMode)
const EMPTY_TOTALS: Totals = { turns: 0, turnMs: 0, claude: {}, kinds: {} }
const totals = atom({ plugin: 'time-spent', key: 'totals' } as const, EMPTY_TOTALS)
const steps = atom({ plugin: 'time-spent', key: 'steps' } as const, [])
const lanesOpen = atom({ plugin: 'time-spent', key: 'lanes' } as const, true)
const running = atom({ plugin: 'time-spent', key: 'running' } as const, {})
const step = atom({ plugin: 'time-spent', key: 'step' } as const, null)
const tick = atom({ plugin: 'time-spent', key: 'now' } as const, 0)
const subRunning = atom({ plugin: 'time-spent', key: 'subRunning' } as const, {})
const liveKey = atom({ plugin: 'time-spent', key: 'liveKey' } as const, null)
const doneFamily = { plugin: 'time-spent', key: 'done' } as const
const doneOrder = atom({ plugin: 'time-spent', key: 'doneOrder' } as const, [])

const MODES: ViewMode[] = ['timeline', 'bars', 'compact', 'off']
const isMode = (v: unknown): v is ViewMode => MODES.includes(v as ViewMode)

// ---- Categories and colors ----

type Kind = { label: string; color: string; match: (tool: string) => boolean }

const KINDS: Kind[] = [
  { label: 'Commands', color: '#F5A524', match: t => t === 'Bash' || t === 'PowerShell' || t === 'BashOutput' },
  { label: 'Agents', color: '#A78BFA', match: t => t === 'Agent' || t === 'Task' || t === 'SendMessage' },
  { label: 'Edits', color: '#34D399', match: t => t === 'Edit' || t === 'Write' || t === 'NotebookEdit' },
  { label: 'Read/Search', color: '#60A5FA', match: t => t === 'Read' || t === 'Grep' || t === 'Glob' || t === 'LSP' },
  { label: 'Web', color: '#22D3EE', match: t => t.startsWith('Web') },
  { label: 'Browser', color: '#FB7185', match: t => t.includes('Browser') || t.includes('chrome') },
  { label: 'MCP', color: '#F472B6', match: t => t.startsWith('mcp__') },
  { label: 'Other', color: '#94A3B8', match: () => true },
]

const kindOf = (tool: string) => KINDS.find(k => k.match(tool)) as Kind

const PHASES: { phase: Phase; label: string; color: string }[] = [
  { phase: 'thinking', label: 'Thinking', color: '#D97757' },
  { phase: 'writing', label: 'Writing', color: '#EDB49A' },
  { phase: 'composing', label: 'Tool input', color: '#A8553A' },
  { phase: 'waiting', label: 'Waiting', color: 'url(#hatch)' },
]
const CLAUDE = '#D97757'
const BG = '#2DD4BF'
const phaseOf = (p: Phase) => PHASES.find(x => x.phase === p) as (typeof PHASES)[number]

// ---- Time arithmetic ----

const fmt = (ms: number) => {
  const s = ms / 1000
  if (s < 0.1) return '<0.1s'
  if (s < 10) return `${s.toFixed(1)}s`
  if (s < 60) return `${Math.round(s)}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${Math.round(s % 60)}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

type Span = { start: number; end: number }

const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`)

// ---- Money: list prices in dollars per million tokens ----

type Price = { in: number; out: number; read: number; write: number }

const OPUS: Price = { in: 4, out: 20, read: 0.2, write: 5 }

// First match wins, so a newer model sits above the family default. `write` is the 5-minute cache write.
const PRICES: [RegExp, Price][] = [
  [/fable|mythos/, { in: 10, out: 50, read: 0.25, write: 12.5 }],
  [/opus-5-5/, OPUS],
  [/opus-(5|4-[5-9])/, { in: 5, out: 25, read: 0.5, write: 6.25 }],
  [/opus/, { in: 15, out: 75, read: 1.5, write: 18.75 }],
  [/sonnet-5/, { in: 2, out: 10, read: 0.2, write: 2.5 }],
  [/sonnet/, { in: 3, out: 15, read: 0.3, write: 3.75 }],
  [/haiku-3/, { in: 0.8, out: 4, read: 0.08, write: 1 }],
  [/haiku/, { in: 1, out: 5, read: 0.1, write: 1.25 }],
]

// An unknown model is priced as the current Opus.
const priceOf = (model: string) => PRICES.find(([re]) => re.test(model))?.[1] ?? OPUS

type Usage = { model?: string; input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }

const usdOf = (u: Usage) => {
  const p = priceOf(u.model ?? '')
  return ((u.input_tokens ?? 0) * p.in + (u.output_tokens ?? 0) * p.out + (u.cache_read_input_tokens ?? 0) * p.read + (u.cache_creation_input_tokens ?? 0) * p.write) / 1e6
}

// What a request that missed the cache paid over the same request read from cache.
const missUsdOf = (u: Usage) => {
  const p = priceOf(u.model ?? '')
  return ((u.input_tokens ?? 0) * (p.in - p.read) + (u.cache_creation_input_tokens ?? 0) * (p.write - p.read)) / 1e6
}

const money = (usd: number) => (usd < 0.005 ? '<$0.01' : usd < 100 ? `$${usd.toFixed(2)}` : `$${Math.round(usd)}`)

const sumUsd = (xs: readonly { usd?: number }[]) => xs.reduce((a, x) => a + (x.usd ?? 0), 0)

type Cost = {
  /** The ledger's figure once the turn ended, else the sum of the estimates. */
  total: number
  isExact: boolean
  isSub: boolean
  claude: number
  agents: number
  /** Ledger cost no recorded request accounts for (side calls, compaction, price drift). */
  other: number
  reqs: (Req & { usd: number })[]
}

// The estimates are scaled (within ±25%) to add up to the ledger, which /cost reads; past that the rest shows as "other".
const costOf = (turn: TurnRecord, sub: readonly SubSpan[]): Cost => {
  const claude = sumUsd(turn.reqs ?? [])
  const agents = sumUsd(sub)
  const est = claude + agents
  const isExact = turn.usd !== undefined
  const k = isExact && est > 0 ? Math.min(1.25, Math.max(0.8, (turn.usd as number) / est)) : 1
  const other = isExact ? (turn.usd as number) - est * k : 0
  return {
    total: isExact ? (turn.usd as number) : est,
    isExact,
    isSub: turn.isSub === true,
    claude: claude * k,
    agents: agents * k,
    other: Math.abs(other) >= 0.01 ? other : 0,
    reqs: (turn.reqs ?? []).map(r => ({ ...r, usd: r.usd * k })),
  }
}

const costLine = (c: Cost) =>
  [
    `${money(c.total)}${c.isExact ? '' : ' so far'}`,
    `Claude ${money(c.claude)}${c.reqs.length > 0 ? ` (${c.reqs.length} request${c.reqs.length === 1 ? '' : 's'})` : ''}`,
    ...(c.agents > 0 ? [`agents ${money(c.agents)}`] : []),
    ...(c.other !== 0 ? [`other ${money(c.other)}`] : []),
  ].join(' · ') + (c.isSub ? ' · API list price' : '')

// The requests that cost the most, with the tool results each was the first to read.
const priciest = (c: Cost, n = 3) =>
  [...c.reqs]
    .sort((a, b) => b.usd - a.usd)
    .slice(0, n)
    .map(r => `${money(r.usd)}${r.after ? ` after ${r.after}` : ''} (${tokens(r.input + r.cacheWrite)} fresh, ${tokens(r.output)} out)`)

const unionOf = (spans: readonly Span[]) => {
  const out: [number, number][] = []
  for (const b of [...spans].sort((x, y) => x.start - y.start)) {
    const last = out[out.length - 1]
    if (last !== undefined && b.start <= last[1]) last[1] = Math.max(last[1], b.end)
    else out.push([b.start, b.end])
  }
  return out
}

// Wall-clock time covered by the spans: parallel ones are counted once.
const covered = (spans: readonly Span[]) => unionOf(spans).reduce((a, [s, e]) => a + (e - s), 0)

// Intervals during which two or more spans run at once.
const parallelIntervals = (spans: readonly Span[]) => {
  const edges = spans.flatMap(b => [
    { at: b.start, d: 1 },
    { at: b.end, d: -1 },
  ])
  edges.sort((a, b) => a.at - b.at || a.d - b.d)
  const out: [number, number][] = []
  let live = 0
  let since = 0
  for (const x of edges) {
    if (live >= 2 && x.at > since) out.push([since, x.at])
    live += x.d
    since = x.at
  }
  return out
}

const shortName = (tool: string) => (tool.startsWith('mcp__') ? (tool.split('__').slice(-1)[0] ?? tool) : tool)

type Group = { kind: Kind; ms: number; calls: number; tools: Record<string, number> }

const breakdown = (spans: readonly ToolSpan[]) => {
  const groups: Group[] = []
  for (const kind of KINDS) {
    const mine = spans.filter(s => kindOf(s.tool) === kind)
    if (mine.length === 0) continue
    const tools: Record<string, number> = {}
    for (const s of mine) tools[shortName(s.tool)] = (tools[shortName(s.tool)] ?? 0) + 1
    groups.push({ kind, ms: covered(mine), calls: mine.length, tools })
  }
  return groups.sort((a, b) => b.ms - a.ms)
}

const toolList = (g: Group) =>
  Object.entries(g.tools)
    .map(([t, n]) => (n > 1 ? `${t}×${n}` : t))
    .join(' ')

// ---- One turn, as everything the drawings need ----

type Bar = ToolSpan & { isRunning: boolean }

type View = {
  turn: TurnRecord
  isLive: boolean
  from: number
  to: number
  total: number
  bars: Bar[]
  groups: Group[]
  order: Group[]
  model: PhaseSeg[]
  phaseMs: { phase: Phase; ms: number }[]
  claudeMs: number
  toolMs: number
  drawnMs: number
  untrackedMs: number
  parallel: [number, number][]
  parallelMs: number
  sub: SubSpan[]
  /** Background tasks, each drawn up to its end or, while it runs, up to now (or the turn's end). */
  bg: (BgTask & { end: number; isRunning: boolean })[]
  /** The drawn axis: the turn, stretched to the last background task's end. */
  axisTo: number
  axisTotal: number
  cost: Cost
}

const viewOf = (
  turn: TurnRecord,
  live: readonly RunningCall[],
  liveStep: { phase: Phase; since: number } | null,
  now: number,
  subLive: readonly { agentId: string; tool: string; start: number }[] = [],
): View => {
  const isLive = turn.endedAt === undefined
  const bars: Bar[] = [
    ...turn.spans.map(b => ({ ...b, isRunning: false })),
    ...live.map(c => ({ tool: c.tool, start: c.start, end: now, detail: c.detail, isRunning: true })),
  ]
  const model: PhaseSeg[] = [
    ...(turn.model ?? []),
    ...(isLive && liveStep !== null ? [{ phase: liveStep.phase, start: liveStep.since, end: now }] : []),
  ]
  const from = turn.startedAt
  const to = Math.max(turn.endedAt ?? now, ...bars.map(b => b.end), ...model.map(m => m.end))
  const total = Math.max(1, to - from)
  const groups = breakdown(bars)
  const firstStart = (g: Group) => Math.min(...bars.filter(s => kindOf(s.tool) === g.kind).map(s => s.start))
  const order = [...groups].sort((a, b) => firstStart(a) - firstStart(b))
  const phaseMs = PHASES.map(p => ({ phase: p.phase, ms: covered(model.filter(m => m.phase === p.phase)) })).filter(p => p.ms > 0)
  const toolMs = covered(bars)
  const claudeMs = covered(model)
  const drawnMs = covered([...bars, ...model])
  const parallel = parallelIntervals(bars)
  const bg = (turn.bg ?? []).map(b => ({ ...b, end: b.end ?? Math.max(b.start, isLive ? now : to), isRunning: b.end === undefined }))
  const axisTo = Math.max(to, ...bg.map(b => b.end))

  return {
    turn,
    isLive,
    from,
    to,
    total,
    bars,
    groups,
    order,
    model,
    phaseMs,
    claudeMs,
    toolMs,
    drawnMs,
    untrackedMs: Math.max(0, total - drawnMs),
    parallel,
    parallelMs: parallel.reduce((a, [s, e]) => a + (e - s), 0),
    sub: [...(turn.sub ?? []), ...(isLive ? subLive.map(x => ({ ...x, end: now })) : [])],
    bg,
    axisTo,
    axisTotal: Math.max(1, axisTo - from),
    cost: costOf(turn, turn.sub ?? []),
  }
}

// ---- What was happening at each moment: the strip ----

type Moment = { start: number; end: number; colors: string[]; label: string }

// Between every two boundaries: the tool types running (they win), else Claude's phase, else nothing.
const momentsOf = (v: View): Moment[] => {
  const cuts = [...new Set([v.from, v.to, ...v.bars.flatMap(b => [b.start, b.end]), ...v.model.flatMap(m => [m.start, m.end])])]
    .filter(t => t >= v.from && t <= v.to)
    .sort((a, b) => a - b)
  const out: Moment[] = []
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a = cuts[i]
    const b = cuts[i + 1]
    if (b - a <= 0) continue
    const mid = (a + b) / 2
    const kinds = KINDS.filter(k => v.bars.some(x => kindOf(x.tool) === k && x.start <= mid && x.end > mid))
    const phase = v.model.find(m => m.start <= mid && m.end > mid)
    const colors = kinds.length > 0 ? kinds.map(k => k.color) : phase !== undefined ? [phaseOf(phase.phase).color] : []
    const label = kinds.length > 0 ? kinds.map(k => k.label).join(' + ') : phase !== undefined ? phaseOf(phase.phase).label : 'untracked'
    const last = out[out.length - 1]
    if (last !== undefined && last.label === label) last.end = b
    else out.push({ start: a, end: b, colors, label })
  }
  return out
}

// ---- The card: one SVG on desktop, mobile and VS Code ----

const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const niceStep = (total: number) =>
  [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600].map(x => x * 1000).find(x => total / x <= 6) ?? 3_600_000

const tickLabel = (ms: number) => {
  if (ms < 60_000) return `${ms / 1000}s`
  const m = Math.floor(ms / 60_000)
  const sec = Math.round((ms % 60_000) / 1000)
  return sec === 0 ? `${m}m` : `${m}m${sec}s`
}

// Greedy tracks: spans of one lane that overlap stack on separate tracks.
const tracksOf = <T extends Span>(spans: readonly T[]) => {
  const ends: number[] = []
  const at = new Map<T, number>()
  for (const b of [...spans].sort((x, y) => x.start - y.start)) {
    let i = ends.findIndex(e => e <= b.start)
    if (i < 0) i = ends.push(0) - 1
    ends[i] = b.end
    at.set(b, i)
  }
  return { count: Math.max(1, ends.length), at }
}

const FONT = '-apple-system, BlinkMacSystemFont, Inter, "Segoe UI", system-ui, sans-serif'
const MONO = 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace'

const STYLE = `<style>
text{font-family:${FONT}}
.n{font-family:${MONO};font-variant-numeric:tabular-nums}
.t{fill:#ececec}.m{fill:#a3a3a3}.f{fill:#6f6f6f}.g{stroke:#ffffff;stroke-opacity:.09}
.lane{fill:#ffffff;fill-opacity:.035}
.hit:hover{filter:brightness(1.2)}
</style>`

const HATCH = `<pattern id="hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" fill="#ffffff" fill-opacity=".03"/><line x1="0" y1="0" x2="0" y2="5" stroke="#8a8a8a" stroke-opacity=".55" stroke-width="1.6"/></pattern>`

const W = 680
const P = 20

const svgCard = (v: View, view: ViewMode, expanded: boolean) => {
  const defs: string[] = [HATCH]
  const out: string[] = []
  const pct = (ms: number) => `${Math.round((ms / v.total) * 100)}%`
  let y = P

  // Header: a finished turn shows its total once; a live one leaves the time to the row above it.
  if (!v.isLive) {
    out.push(`<text x="${P}" y="${y + 22}" class="t n" font-size="24" font-weight="650">${esc(fmt(v.total))}</text>`)
    out.push(`<text x="${P + fmt(v.total).length * 14.6 + 10}" y="${y + 22}" class="m" font-size="12.5">this turn<tspan class="t n" dx="10" font-weight="600">${esc(money(v.cost.total))}</tspan></text>`)
    y += 34
  }

  // The share ribbon: Claude's phases, then each tool type, then what nothing accounts for.
  const ribbon = [
    ...v.phaseMs.map(p => ({ label: phaseOf(p.phase).label, color: phaseOf(p.phase).color, ms: p.ms })),
    ...v.groups.map(g => ({ label: g.kind.label, color: g.kind.color, ms: g.ms })),
    ...(v.untrackedMs > 50 ? [{ label: 'Untracked', color: 'transparent', ms: v.untrackedMs }] : []),
  ]
  const sum = Math.max(1, ribbon.reduce((a, r) => a + r.ms, 0))
  const RW = W - 2 * P
  if (expanded) {
    // The lanes below draw the turn in order; the strip would repeat them.
  } else if (view === 'timeline') {
    // The strip: the turn in order, each moment in the color of what ran then.
    const RH = 14
    const XR = (t: number) => P + ((t - v.from) / v.axisTotal) * RW
    defs.push(`<clipPath id="rib"><rect x="${P}" y="${y}" width="${RW}" height="${RH}" rx="5"/></clipPath>`)
    out.push(`<rect x="${P}" y="${y}" width="${RW}" height="${RH}" rx="5" class="lane"/><g clip-path="url(#rib)">`)
    for (const m of momentsOf(v)) {
      const x = XR(m.start)
      const w = Math.max(1, XR(m.end) - x)
      const tip = `${m.label} · ${fmt(m.end - m.start)} · at ${fmt(m.start - v.from)}`
      if (m.colors.length === 0) continue
      const sh = RH / m.colors.length
      m.colors.forEach((c, i) =>
        out.push(`<rect class="hit" x="${x.toFixed(1)}" y="${(y + i * sh).toFixed(1)}" width="${w.toFixed(1)}" height="${sh.toFixed(1)}" fill="${c}"><title>${esc(tip)}</title></rect>`),
      )
    }
    out.push(`</g>`)
    const stepMs = niceStep(v.axisTotal)
    for (let t = 0; t <= v.axisTotal + 1; t += stepMs) {
      const x = XR(v.from + t)
      out.push(`<line x1="${x.toFixed(1)}" y1="${y + RH + 2}" x2="${x.toFixed(1)}" y2="${y + RH + 5}" class="g" stroke-opacity=".5"/>`)
      out.push(`<text x="${x.toFixed(1)}" y="${y + RH + 15}" text-anchor="${t === 0 ? 'start' : 'middle'}" class="f n" font-size="9.5">${tickLabel(t)}</text>`)
    }
    y += RH + 28
  } else {
    defs.push(`<clipPath id="rib"><rect x="${P}" y="${y}" width="${RW}" height="10" rx="5"/></clipPath>`)
    out.push(`<rect x="${P}" y="${y}" width="${RW}" height="10" rx="5" class="lane"/><g clip-path="url(#rib)">`)
    let rx = P
    for (const r of ribbon) {
      const w = (r.ms / sum) * RW
      if (r.color !== 'transparent')
        out.push(`<rect class="hit" x="${rx.toFixed(1)}" y="${y}" width="${Math.max(0, w - 1.5).toFixed(1)}" height="10" fill="${r.color}"><title>${esc(`${r.label} · ${fmt(r.ms)} · ${pct(r.ms)}`)}</title></rect>`)
      rx += w
    }
    out.push(`</g>`)
    y += 22
  }

  if (!expanded) {
    y += 2
  } else if (view === 'bars') {
    const lx = P + 112
    const lw = W - P - 64 - lx
    for (const r of ribbon.filter(r => r.color !== 'transparent')) {
      out.push(`<text x="${P}" y="${y + 9}" class="t" font-size="12.5">${esc(r.label)}</text>`)
      out.push(`<rect x="${lx}" y="${y}" width="${lw}" height="10" rx="5" class="lane"/>`)
      out.push(`<rect class="hit" x="${lx}" y="${y}" width="${Math.max(4, (r.ms / v.total) * lw).toFixed(1)}" height="10" rx="5" fill="${r.color}"><title>${esc(`${r.label} · ${fmt(r.ms)}`)}</title></rect>`)
      out.push(`<text x="${W - P}" y="${y + 9}" text-anchor="end" class="m n" font-size="11">${pct(r.ms)}</text>`)
      y += 20
    }
    y += 4
  } else {
    // The timeline: Claude's lane first, then each tool type in the order it first ran.
    const labelW = 104
    const durW = 52
    const x0 = P + labelW
    const x1 = W - P - durW
    const cw = x1 - x0
    const X = (t: number) => x0 + ((Math.min(Math.max(t, v.from), v.axisTo) - v.from) / v.axisTotal) * cw

    type Lane = { label: string; color: string; ms: number; count?: number; isRunning?: boolean; h: number; draw: (top: number) => void; inner?: boolean }
    const lanes: Lane[] = []
    lanes.push({
      label: 'Claude',
      color: CLAUDE,
      ms: v.claudeMs,
      h: 24,
      draw: top => {
        for (const m of v.model) {
          const p = phaseOf(m.phase)
          out.push(`<rect class="hit" x="${X(m.start).toFixed(1)}" y="${top + 5}" width="${Math.max(1.5, X(m.end) - X(m.start)).toFixed(1)}" height="14" fill="${p.color}"><title>${esc(`${p.label} · ${fmt(m.end - m.start)}`)}</title></rect>`)
        }
      },
    })
    let gi = 0
    for (const g of v.order) {
      const bars = v.bars.filter(b => kindOf(b.tool) === g.kind)
      const tr = tracksOf(bars)
      const bh = tr.count === 1 ? 14 : Math.max(5, Math.floor(18 / tr.count))
      const h = tr.count === 1 ? 24 : 8 + tr.count * (bh + 2)
      lanes.push({
        label: g.kind.label,
        color: g.kind.color,
        ms: g.ms,
        count: g.calls,
        isRunning: bars.some(b => b.isRunning),
        h,
        draw: top => {
          const stackH = tr.count * bh + (tr.count - 1) * 2
          for (const b of bars) {
            const k = tr.at.get(b) ?? 0
            const by = top + (h - stackH) / 2 + k * (bh + 2)
            const bx = X(b.start)
            const bw = Math.max(3, X(b.end) - bx)
            let fill = g.kind.color
            if (b.isRunning) {
              fill = `url(#run${gi})`
              defs.push(`<linearGradient id="run${gi}" x1="0" x2="1"><stop offset="0" stop-color="${g.kind.color}"/><stop offset=".7" stop-color="${g.kind.color}"/><stop offset="1" stop-color="${g.kind.color}" stop-opacity=".2"/></linearGradient>`)
            }
            const tip = `${shortName(b.tool)} · ${fmt(b.end - b.start)}${b.isRunning ? ' · running' : ''}${b.detail ? ` · ${b.detail}` : ''}`
            out.push(`<rect class="hit" x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh}" rx="${Math.min(3.5, bh / 2)}" fill="${fill}"><title>${esc(tip)}</title></rect>`)
            gi += 1
          }
        },
      })
      // Inside the agents: their own model requests and tool calls, on a thin lane beneath.
      if (g.kind.label === 'Agents' && v.sub.length > 0) {
        const agents = [...new Set(v.sub.map(s => s.agentId))]
        const subMs = covered(v.sub)
        lanes.push({
          label: 'inside',
          color: 'none',
          ms: subMs,
          inner: true,
          h: 8 + agents.length * 8,
          draw: top => {
            agents.forEach((id, i) => {
              for (const s of v.sub.filter(x => x.agentId === id)) {
                const color = s.tool === '@model' ? CLAUDE : kindOf(s.tool).color
                const name = s.tool === '@model' ? 'model' : shortName(s.tool)
                out.push(`<rect class="hit" x="${X(s.start).toFixed(1)}" y="${top + 4 + i * 8}" width="${Math.max(1.5, X(s.end) - X(s.start)).toFixed(1)}" height="6" rx="1.5" fill="${color}" fill-opacity="${s.tool === '@model' ? 0.75 : 1}"><title>${esc(`subagent ${i + 1} · ${name} · ${fmt(s.end - s.start)}`)}</title></rect>`)
              }
            })
          },
        })
      }
    }

    if (v.bg.length > 0) {
      const tr = tracksOf(v.bg)
      const bh = tr.count === 1 ? 14 : Math.max(5, Math.floor(18 / tr.count))
      const h = tr.count === 1 ? 24 : 8 + tr.count * (bh + 2)
      lanes.push({
        label: 'Background',
        color: BG,
        ms: covered(v.bg),
        count: v.bg.length,
        isRunning: v.bg.some(b => b.isRunning),
        h,
        draw: top => {
          const stackH = tr.count * bh + (tr.count - 1) * 2
          v.bg.forEach((b, i) => {
            const k = tr.at.get(b) ?? 0
            const by = top + (h - stackH) / 2 + k * (bh + 2)
            const bx = X(b.start)
            const bw = Math.max(3, X(b.end) - bx)
            const color = kindOf(b.tool).color
            let fill = color
            if (b.isRunning) {
              fill = `url(#bg${i})`
              defs.push(`<linearGradient id="bg${i}" x1="0" x2="1"><stop offset="0" stop-color="${color}"/><stop offset=".6" stop-color="${color}"/><stop offset="1" stop-color="${color}" stop-opacity=".15"/></linearGradient>`)
            }
            const tip = `${shortName(b.tool)} in background · ${fmt(b.end - b.start)}${b.isRunning ? ' so far · running' : ` · ${b.status ?? 'done'}`}${b.detail ? ` · ${b.detail}` : ''}`
            out.push(`<rect class="hit" x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh}" rx="${Math.min(3.5, bh / 2)}" fill="${fill}" stroke="${BG}" stroke-opacity=".7" stroke-width="1"><title>${esc(tip)}</title></rect>`)
          })
        },
      })
    }

    // Axis on top, grid through every lane.
    const lanesH = lanes.reduce((a, l) => a + l.h + 4, 0)
    const top = y + 12
    const stepMs = niceStep(v.axisTotal)
    for (let t = 0; t <= v.axisTotal + 1; t += stepMs) {
      const x = X(v.from + t)
      out.push(`<line x1="${x.toFixed(1)}" y1="${top}" x2="${x.toFixed(1)}" y2="${top + lanesH}" class="g" stroke-dasharray="2 3"/>`)
      out.push(`<text x="${x.toFixed(1)}" y="${y + 6}" text-anchor="middle" class="f n" font-size="9.5">${tickLabel(t)}</text>`)
    }
    for (const [a, b] of v.parallel)
      out.push(`<rect x="${X(a).toFixed(1)}" y="${top}" width="${Math.max(1, X(b) - X(a)).toFixed(1)}" height="${lanesH}" fill="#F5A524" fill-opacity=".08"><title>${esc(`${fmt(b - a)} with calls in parallel`)}</title></rect>`)

    let ly = top
    for (const l of lanes) {
      const mid = ly + l.h / 2
      if (l.inner) {
        out.push(`<text x="${P + 14}" y="${mid + 3.5}" class="f" font-size="10.5">↳ inside</text>`)
        out.push(`<text x="${W - P}" y="${mid + 3.5}" text-anchor="end" class="f n" font-size="10.5">${esc(fmt(l.ms))}</text>`)
      } else {
        out.push(`<rect x="${x0 - 4}" y="${ly}" width="${cw + 8}" height="${l.h}" rx="6" class="lane"/>`)
        out.push(`<circle cx="${P + 4}" cy="${mid}" r="4" fill="${l.color}"/>`)
        out.push(`<text x="${P + 14}" y="${mid + 4}" class="t" font-size="12.5" font-weight="500">${esc(l.label)}${l.count !== undefined ? `<tspan class="f n" font-size="10.5" dx="5">${l.count}</tspan>` : ''}${l.isRunning ? `<tspan fill="#F43F5E" font-size="9" dx="4">●</tspan>` : ''}</text>`)
        out.push(`<text x="${W - P}" y="${mid + 4}" text-anchor="end" class="t n" font-size="11.5" font-weight="600">${esc(fmt(l.ms))}</text>`)
      }
      l.draw(ly)
      ly += l.h + 4
    }
    if (v.isLive) {
      const nx = X(v.to)
      out.push(`<line x1="${nx.toFixed(1)}" y1="${top - 3}" x2="${nx.toFixed(1)}" y2="${ly - 4}" stroke="#F43F5E" stroke-width="1.5"/><circle cx="${nx.toFixed(1)}" cy="${top - 3}" r="2.8" fill="#F43F5E"/>`)
    }
    y = ly + 4
  }

  // The legend, under the timeline: every slice with its time, as chips.
  let cx = P
  let cy = y + 10
  for (const r of ribbon) {
    const label = `${r.label} `
    const time = fmt(r.ms)
    const w = 14 + label.length * 6.6 + time.length * 7 + 14
    if (cx + w > W - P) {
      cx = P
      cy += 18
    }
    const dot =
      r.color === 'transparent'
        ? `<circle cx="${cx + 4}" cy="${cy - 4}" r="3.5" fill="none" stroke="#8a8a8a" stroke-dasharray="1.5 1.5"/>`
        : `<circle cx="${cx + 4}" cy="${cy - 4}" r="4" fill="${r.color}"/>`
    out.push(`${dot}<text x="${cx + 13}" y="${cy}" class="m" font-size="11.5">${esc(r.label)}<tspan class="t n" dx="5" font-weight="600">${esc(time)}</tspan></text>`)
    cx += w
  }
  y = cy + 14


  // Footer: what was recorded against what the chart accounts for.
  out.push(`<line x1="${P}" y1="${y + 2}" x2="${W - P}" y2="${y + 2}" class="g"/>`)
  const foot = [
    `recorded ${fmt(v.total)}`,
    `charted ${fmt(v.drawnMs)} (${pct(v.drawnMs)})`,
    `untracked ${fmt(v.untrackedMs)}`,
    ...(v.parallelMs > 0 ? [`${fmt(v.parallelMs)} parallel`] : []),
    `${v.bars.length} tool call${v.bars.length === 1 ? '' : 's'}`,
  ].join('   ·   ')
  out.push(`<text x="${P}" y="${y + 18}" class="f n" font-size="10.5">${esc(foot)}</text>`)
  y += 24
  out.push(`<text x="${P}" y="${y + 12}" class="m n" font-size="10.5">${esc(costLine(v.cost))}</text>`)
  y += 18

  const H = y + P - 6
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${STYLE}<defs>${defs.join('')}</defs><rect width="${W}" height="${H}" fill="#151515"/><rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="14" fill="#1c1c1c" stroke="#2c2c2c"/>${out.join('')}</svg>`
  const alt = `${fmt(v.total)}, ${money(v.cost.total)}: Claude ${fmt(v.claudeMs)}, ${v.groups.map(g => `${g.kind.label} ${fmt(g.ms)}`).join(', ')}; untracked ${fmt(v.untrackedMs)}`

  return { source, alt, width: W, height: H }
}

// ---- Text drawing, for the terminal and the compact view ----

type Els = { Box: any; Text: any; Button: any; Svg?: any; Markdown?: any }

const switcherOf = (
  els: Els,
  view: ViewMode,
  setView: (v: ViewMode) => () => Promise<unknown>,
  lanes?: { open: boolean; toggle: () => Promise<unknown> },
  openContext?: () => Promise<unknown>,
) => {
  const { Box, Text, Button } = els
  const canFold = lanes !== undefined && view !== 'off' && view !== 'compact'
  return (
    <Box flexDirection="row" gap={2} alignItems="center">
      {canFold ? (
        <Button key="lanes" label={`${lanes.open ? '▾' : '▸'}  ◷ Time spent`} plain dimColor={!lanes.open} onPress={lanes.toggle} />
      ) : (
        <Text>
          <Text color={CLAUDE}>◷</Text>
          <Text dimColor> Time spent</Text>
        </Text>
      )}
      <Box flexDirection="row" gap={1}>
        {MODES.map(m => (
          <Button
            key={`view:${m}`}
            label={m === 'off' ? 'hide' : m}
            plain={m === view ? undefined : true}
            dimColor={m !== view}
            variant={m === view ? 'primary' : 'secondary'}
            onPress={setView(m)}
          />
        ))}
      </Box>
      {openContext !== undefined && <Button key="context" label="context ↗" plain dimColor onPress={openContext} />}
    </Box>
  )
}

const textCard = (els: Els, v: View, view: ViewMode, columns: number) => {
  const { Box, Text } = els
  const rows = [
    { label: 'Claude', color: CLAUDE, ms: v.claudeMs, note: v.phaseMs.map(p => `${phaseOf(p.phase).label.toLowerCase()} ${fmt(p.ms)}`).join(', ') },
    ...v.groups.map(g => ({ label: g.kind.label, color: g.kind.color, ms: g.ms, note: toolList(g) })),
  ]
  if (view === 'compact') {
    return (
      <Text>
        {!v.isLive && <Text bold>{fmt(v.total)}  </Text>}
        <Text bold>{money(v.cost.total)}  </Text>
        {rows.map(r => (
          <Text>
            <Text color={r.color}>● </Text>
            {r.label} <Text bold>{fmt(r.ms)}</Text>
            <Text dimColor>   </Text>
          </Text>
        ))}
        {v.untrackedMs > 50 && <Text dimColor>untracked {fmt(v.untrackedMs)}</Text>}
      </Text>
    )
  }
  const labelW = 13
  const cells = Math.max(16, Math.min(60, columns - labelW - 26))
  const cellMs = v.total / cells
  const laneOf = (spans: readonly Span[]) =>
    Array.from({ length: cells }, (_, i) => {
      const a = v.from + i * cellMs
      return spans.some(s => s.start < a + cellMs && s.end > a)
    })
  const draw = (cellsOn: boolean[], color: string) => cellsOn.map(on => (on ? <Text color={color}>█</Text> : <Text dimColor>·</Text>))

  return (
    <Box flexDirection="column">
      {!v.isLive && <Text bold>{fmt(v.total)} this turn</Text>}
      {rows.map(r => (
        <Text>
          <Text color={r.color}>{('● ' + r.label).padEnd(labelW)}</Text>
          {view === 'timeline'
            ? draw(laneOf(r.label === 'Claude' ? v.model : v.bars.filter(b => kindOf(b.tool).color === r.color)), r.color)
            : <Text color={r.color}>{'█'.repeat(Math.max(1, Math.round((r.ms / v.total) * cells)))}</Text>}
          <Text bold> {fmt(r.ms).padStart(6)}</Text>
          <Text dimColor> {r.note}</Text>
        </Text>
      ))}
      <Text dimColor>
        recorded {fmt(v.total)} · charted {fmt(v.drawnMs)} · untracked {fmt(v.untrackedMs)}
      </Text>
      <Text dimColor>{costLine(v.cost)}</Text>
    </Box>
  )
}

const cardOf = (
  els: Els,
  v: View,
  view: ViewMode,
  columns: number,
  setView: (m: ViewMode) => () => Promise<unknown>,
  lanes: { open: boolean; toggle: () => Promise<unknown> },
  doing = '',
  openContext?: () => Promise<unknown>,
) => {
  const { Box } = els
  const body =
    view === 'timeline' || (v.isLive && view === 'bars')
      ? nativeCard(els, v, lanes.open, doing)
      : els.Svg !== undefined && view === 'bars'
      ? (() => {
          const c = svgCard(v, view, lanes.open)
          const Svg = els.Svg
          return <Svg source={c.source} alt={c.alt} width={c.width} height={c.height} isInteractive={false} />
        })()
      : textCard(els, v, view, columns)

  return (
    <Box flexDirection="column" gap={1}>
      {switcherOf(els, view, setView, lanes, openContext)}
      {body}
    </Box>
  )
}

// ---- The live card: native boxes, so a redraw each second never flashes ----

type Seg = { w: number; color: string | null; key: string }

// A track as alternating gaps and bars, widths in whole percent of the track summing to 100:
// boundaries are rounded, and a bar shorter than a percent still takes one.
const segsOf = (spans: readonly (Span & { color: string })[], from: number, total: number, key: string): Seg[] => {
  const out: Seg[] = []
  const pos = (t: number) => Math.min(100, Math.max(0, Math.round(((t - from) / total) * 100)))
  let at = 0
  spans
    .slice()
    .sort((a, b) => a.start - b.start)
    .forEach((s, i) => {
      if (at >= 100) return
      const a = Math.max(at, pos(s.start))
      const b = Math.min(100, Math.max(a + 1, pos(s.end)))
      if (a > at) out.push({ w: a - at, color: null, key: `${key}g${i}` })
      out.push({ w: b - a, color: s.color, key: `${key}b${i}` })
      at = b
    })
  if (at < 100) out.push({ w: 100 - at, color: null, key: `${key}end` })
  return out.filter(g => g.w > 0)
}

// The timeline card, live or finished, in one shape: when a turn ends the same boxes update in place.
const nativeCard = (els: Els, v: View, expanded: boolean, doing: string) => {
  const { Box, Text } = els
  const track = (segs: Seg[]) => (
    <Box flexDirection="row" width="100%">
      {segs.map(g =>
        g.color === null ? (
          <Box key={g.key} width={`${g.w}%`} />
        ) : (
          <Box key={g.key} width={`${g.w}%`} backgroundColor={g.color}>
            <Text> </Text>
          </Box>
        ),
      )}
    </Box>
  )
  const lane = (label: string, color: string, ms: number, tracks: Seg[][], mark?: string, usd?: number) => (
    <Box key={`lane:${label}`} flexDirection="row" width="100%" alignItems="center">
      <Box width="18%">
        <Text>
          <Text color={color}>● </Text>
          {label}
          {mark !== undefined && <Text color="#F43F5E"> {mark}</Text>}
          {usd !== undefined && usd > 0 && <Text dimColor> {money(usd)}</Text>}
        </Text>
      </Box>
      <Box width="70%" flexDirection="column" backgroundColor="#232323">
        {tracks.map(t => track(t))}
      </Box>
      <Box width="12%" justifyContent="flex-end">
        <Text bold>{fmt(ms)}</Text>
      </Box>
    </Box>
  )
  const waiting = '#3a3a3a'
  const claude = v.model.map(m => ({ ...m, color: m.phase === 'waiting' ? waiting : phaseOf(m.phase).color }))
  const lanes = [lane('Claude', CLAUDE, v.claudeMs, [segsOf(claude, v.from, v.axisTotal, 'c')], undefined, v.cost.claude)]
  for (const g of v.order) {
    const bars = v.bars.filter(b => kindOf(b.tool) === g.kind)
    const tr = tracksOf(bars)
    const tracks = Array.from({ length: tr.count }, (_, i) =>
      segsOf(bars.filter(b => tr.at.get(b) === i).map(b => ({ ...b, color: g.kind.color })), v.from, v.axisTotal, `${g.kind.label}${i}`),
    )
    lanes.push(lane(g.kind.label, g.kind.color, g.ms, tracks, bars.some(b => b.isRunning) ? '●' : undefined, g.kind.label === 'Agents' ? v.cost.agents : undefined))
    if (g.kind.label === 'Agents' && v.sub.length > 0) {
      const agents = [...new Set(v.sub.map(x => x.agentId))]
      const subTracks = agents.map((id, i) =>
        segsOf(
          v.sub.filter(x => x.agentId === id).map(x => ({ ...x, color: x.tool === '@model' ? '#B86A50' : kindOf(x.tool).color })),
          v.from,
          v.axisTotal,
          `sub${i}`,
        ),
      )
      lanes.push(lane(`↳ inside (${agents.length})`, '#6f6f6f', covered(v.sub), subTracks))
    }
  }
  if (v.bg.length > 0) {
    const tr = tracksOf(v.bg)
    const tracks = Array.from({ length: tr.count }, (_, i) =>
      segsOf(v.bg.filter(b => tr.at.get(b) === i).map(b => ({ ...b, color: kindOf(b.tool).color })), v.from, v.axisTotal, `bg${i}`),
    )
    lanes.push(lane(`Background ${v.bg.length}`, BG, covered(v.bg), tracks, v.bg.some(b => b.isRunning) ? '●' : undefined))
  }
  const running = v.bars.filter(b => b.isRunning).length
  const legend = [
    ...v.phaseMs.map(p => ({ label: phaseOf(p.phase).label, color: p.phase === 'waiting' ? waiting : phaseOf(p.phase).color, ms: p.ms })),
    ...v.groups.map(g => ({ label: g.kind.label, color: g.kind.color, ms: g.ms })),
    ...(!v.isLive && v.untrackedMs > 50 ? [{ label: 'Untracked', color: '#555555', ms: v.untrackedMs }] : []),
  ]
  const facts = [
    `${v.bars.length} call${v.bars.length === 1 ? '' : 's'}`,
    ...(running > 0 ? [`${running} running`] : []),
    ...(v.parallelMs > 0 ? [`${fmt(v.parallelMs)} parallel`] : []),
  ].join(' · ')

  return (
    <Box key="card" flexDirection="column" gap={1} padding={1} borderStyle="round" borderColor="#2c2c2c" backgroundColor="#1c1c1c">
      <Box key="head" flexDirection="row" justifyContent="space-between">
        <Text>
          <Text color={v.isLive ? '#F43F5E' : CLAUDE}>{v.isLive ? '● ' : '◷ '}</Text>
          <Text bold>{v.isLive ? doing : fmt(v.total)}</Text>
          {!v.isLive && <Text dimColor> this turn</Text>}
          {v.cost.total > 0 && <Text dimColor>  ·  </Text>}
          {v.cost.total > 0 && <Text bold>{money(v.cost.total)}</Text>}
          {v.cost.total > 0 && v.isLive && <Text dimColor> so far</Text>}
        </Text>
        <Text dimColor>{facts}</Text>
      </Box>
      <Box key="body" flexDirection="column" gap={1}>
        {expanded
          ? lanes
          : track(segsOf(momentsOf(v).filter(m => m.colors.length > 0).map(m => ({ start: m.start, end: m.end, color: m.colors[0] })), v.from, v.axisTotal, 'strip'))}
      </Box>
      <Box key="legend" flexDirection="row" flexWrap="wrap" columnGap={3}>
        {legend.map(l => (
          <Text key={`lg:${l.label}`}>
            <Text color={l.color}>● </Text>
            <Text dimColor>{l.label} </Text>
            <Text bold>{fmt(l.ms)}</Text>
          </Text>
        ))}
      </Box>
      <Box key="foot">
        <Text dimColor>
          {v.isLive
            ? ' '
            : `recorded ${fmt(v.total)} · charted ${fmt(v.drawnMs)} (${Math.round((v.drawnMs / v.total) * 100)}%) · untracked ${fmt(v.untrackedMs)}`}
        </Text>
      </Box>
      {!v.isLive && v.cost.total > 0 && (
        <Box key="cost" flexDirection="column">
          <Text dimColor>{costLine(v.cost)}</Text>
          {expanded && v.cost.reqs.length > 1 && <Text dimColor>priciest: {priciest(v.cost).join(' · ')}</Text>}
        </Box>
      )}
      {!v.isLive && v.turn.nudge !== undefined && (
        <Box key="nudge">
          <Text>
            <Text color="#60A5FA">ⓘ </Text>
            <Text dimColor>{v.turn.nudge}</Text>
          </Text>
        </Box>
      )}
    </Box>
  )
}

// ---- Context: how the first-token wait relates to the context a request carries ----

const CONTEXT_PANE = 'time-spent-context'

const median = (xs: readonly number[]) => {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2
}


const BUCKETS: { label: string; max: number }[] = [
  { label: '<50k', max: 50_000 },
  { label: '50–100k', max: 100_000 },
  { label: '100–200k', max: 200_000 },
  { label: '200–500k', max: 500_000 },
  { label: '500k+', max: Number.POSITIVE_INFINITY },
]

// The advice, only when cached requests now wait at least twice as long as early in the session.
const nudgeOf = (list: readonly StepStat[]) => {
  const hits = list.filter(x => !x.isMiss)
  if (hits.length < 10) return undefined
  const early = median(hits.slice(0, 5).map(x => x.ttft))
  const recent = median(hits.slice(-5).map(x => x.ttft))
  const context = hits[hits.length - 1].context
  if (early <= 0 || recent < 2 * early || recent < 2000 || context < 100_000) return undefined
  return `First-token wait is ${(recent / early).toFixed(1)}× what it was at the start (${fmt(early)} → ${fmt(recent)} at ${tokens(context)} tokens). /compact or a new session would reset it.`
}

const contextPane = (els: Els, list: readonly StepStat[], columns: number, sum: Totals) => {
  const { Box, Text } = els
  if (list.length === 0) return <Text dimColor>No model requests recorded yet in this session.</Text>
  const last = list[list.length - 1]
  const hits = list.filter(x => !x.isMiss)
  const misses = list.filter(x => x.isMiss)
  const rows = BUCKETS.map((b, i) => {
    const lo = i === 0 ? 0 : BUCKETS[i - 1].max
    const mine = hits.filter(x => x.context >= lo && x.context < b.max)
    return { label: b.label, n: mine.length, ms: median(mine.map(x => x.ttft)) }
  }).filter(r => r.n > 0)
  const top = Math.max(1, ...rows.map(r => r.ms))
  const barW = Math.max(8, Math.min(30, columns - 26))
  // Context per turn: the largest request each turn carried.
  const perTurn = new Map<number, number>()
  for (const x of list) perTurn.set(x.turn, Math.max(perTurn.get(x.turn) ?? 0, x.context))
  const series = [...perTurn.values()].slice(-Math.max(8, columns - 4))
  const peak = Math.max(1, ...series)
  const spark = series.map(v => '▁▂▃▄▅▆▇█'[Math.min(7, Math.floor((v / peak) * 7.999))]).join('')
  const missMs = misses.reduce((a, x) => a + Math.max(0, x.ttft - median(hits.map(h => h.ttft))), 0)
  const missUsd = sumUsd(misses.map(x => ({ usd: x.missUsd })))
  const turnUsd = (sum.turnUsd ?? []).slice(-Math.max(8, columns - 4))
  const usdPeak = Math.max(0.0001, ...turnUsd)
  const usdSpark = turnUsd.map(v => '▁▂▃▄▅▆▇█'[Math.min(7, Math.floor((v / usdPeak) * 7.999))]).join('')
  const recent = turnUsd.slice(-5)
  const early = turnUsd.slice(0, 5)
  const avg = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, x) => a + x, 0) / xs.length)
  const advice = nudgeOf(list)

  return (
    <Box flexDirection="column" gap={1}>
      <Text>
        <Text bold>{tokens(last.context)} tokens now</Text>
        <Text dimColor> · started at {tokens(list[0].context)} · {list.length} requests</Text>
      </Text>
      <Box flexDirection="column">
        <Text dimColor>First-token wait by context size (cached requests, median)</Text>
        {rows.map(r => (
          <Text key={`b:${r.label}`}>
            {r.label.padEnd(10)}
            <Text color={CLAUDE}>{'█'.repeat(Math.max(1, Math.round((r.ms / top) * barW)))}</Text>
            <Text bold> {fmt(r.ms)}</Text>
            <Text dimColor> · {r.n}</Text>
          </Text>
        ))}
      </Box>
      <Box flexDirection="column">
        <Text dimColor>Context over the session ({perTurn.size} turns)</Text>
        <Text color={CLAUDE}>{spark}</Text>
      </Box>
      {turnUsd.length > 0 && (
        <Box flexDirection="column">
          <Text>
            <Text bold>{money(sum.usd ?? 0)}</Text>
            <Text dimColor> over {sum.turns} turns · last {money(turnUsd[turnUsd.length - 1] ?? 0)}</Text>
            {turnUsd.length >= 10 && <Text dimColor> · recent turns avg {money(avg(recent))} vs {money(avg(early))} at the start</Text>}
          </Text>
          <Text dimColor>Cost per turn</Text>
          <Text color="#34D399">{usdSpark}</Text>
        </Box>
      )}
      <Box flexDirection="column">
        <Text>
          <Text dimColor>Cache misses: </Text>
          <Text bold>{misses.length}</Text>
          {misses.length > 0 && <Text dimColor> (about +{fmt(missMs)} of waiting, +{money(missUsd)} over cached)</Text>}
        </Text>
        {misses.slice(-5).map(x => (
          <Text key={`m:${x.at}`} dimColor>
            {'  '}turn {x.turn} · re-read {tokens(x.fresh)} · waited {fmt(x.ttft)}{x.missUsd !== undefined ? ` · +${money(x.missUsd)}` : ''}
          </Text>
        ))}
        {misses.length > 0 && <Text dimColor>  A miss follows a pause of about 5 minutes or a change early in the conversation; compacting does not prevent it.</Text>}
      </Box>
      {advice !== undefined && (
        <Text>
          <Text color="#60A5FA">ⓘ </Text>
          {advice}
        </Text>
      )}
    </Box>
  )
}

// ---- Hooks ----

const headOf = (text: string) => text.trim().slice(0, 200)

// A text block's key: its length and a hash of its head, the same from the stored row and the drawn one.
const keyOf = (head: string, length: number) => {
  let h = 5381
  for (let i = 0; i < head.length; i++) h = ((h << 5) + h + head.charCodeAt(i)) | 0
  return `${length}-${(h >>> 0).toString(36)}`
}

// What a call did, for the card's tooltip: the first of the usual descriptive fields.
function detailOf(e: object) {
  const input = e as Record<string, unknown>
  const raw = ['description', 'command', 'file_path', 'pattern', 'url', 'query', 'prompt']
    .map(k => input[k])
    .find(v => typeof v === 'string' && v.trim() !== '')
  if (typeof raw !== 'string') return undefined
  const one = raw.replace(/\s+/g, ' ').trim()
  return one.length > 90 ? `${one.slice(0, 89)}…` : one
}

// The id a background launch's result names its task by.
function taskIdOf(result: unknown) {
  const m = JSON.stringify(result ?? null).match(/"(?:backgroundTaskId|taskId|task_id|agentId|agent_id|shellId)"\s*:\s*"([^"]+)"/)
  return m?.[1]
}

// Subagent work belongs to the turn that launched it in the background, else to the running turn.
function addSub($: EngineInterface, span: SubSpan) {
  return update($, turns, list => {
    let at = list.findIndex(t => (t.bg ?? []).some(b => b.taskId === span.agentId))
    if (at < 0) at = list.length - 1
    if (at < 0 || (list[at].endedAt !== undefined && !(list[at].bg ?? []).some(b => b.taskId === span.agentId))) return list
    return list.map((t, i) => (i === at ? { ...t, sub: [...(t.sub ?? []), span] } : t))
  })
}

function lanesToggle($: EngineInterface, open: boolean) {
  return async () => {
    await update($, lanesOpen, () => !open)
    await $.store.set('lanes', !open)
  }
}

// What the working set keeps: the running turn, the last finished one, and turns with background work still running.
const pruned = (list: readonly TurnRecord[]) => {
  const lastDone = [...list].reverse().find(t => t.endedAt !== undefined)
  return list.filter(t => t.endedAt === undefined || t === lastDone || (t.bg ?? []).some(b => b.end === undefined))
}

// Adds one finished turn to the session's totals.
const addTotals = (sum: Totals, t: TurnRecord): Totals => {
  const v = viewOf(t, [], null, t.endedAt ?? t.startedAt)
  const claude = { ...sum.claude }
  for (const p of v.phaseMs) claude[p.phase] = (claude[p.phase] ?? 0) + p.ms
  const kinds = { ...sum.kinds }
  for (const g of v.groups) {
    const was = kinds[g.kind.label] ?? { ms: 0, calls: 0, tools: {} }
    const tools = { ...was.tools }
    for (const [name, n] of Object.entries(g.tools)) tools[name] = (tools[name] ?? 0) + n
    kinds[g.kind.label] = { ms: was.ms + g.ms, calls: was.calls + g.calls, tools }
  }
  return {
    turns: sum.turns + 1,
    turnMs: sum.turnMs + v.total,
    usd: (sum.usd ?? 0) + v.cost.total,
    turnUsd: [...(sum.turnUsd ?? []), v.cost.total].slice(-200),
    claude,
    kinds,
  }
}

// Saves a finished turn's card copy and drops the oldest copies past the limit.
async function keepCard($: EngineInterface, id: string, record: TurnRecord, limit: number) {
  await update($, atom({ ...doneFamily, id }, null), () => record)
  const order = [...(await read($, doneOrder)).filter(k => k !== id), id]
  const dropped = order.length > limit ? order.slice(0, order.length - limit) : []
  for (const old of dropped) await update($, atom({ ...doneFamily, id: old }, null), () => null)
  await update($, doneOrder, () => order.slice(dropped.length))
}

// Removes a card copy (its reply moved it to another text block).
async function dropCard($: EngineInterface, id: string) {
  await update($, atom({ ...doneFamily, id }, null), () => null)
  await update($, doneOrder, order => order.filter(k => k !== id))
}

function contextOpener($: EngineInterface) {
  return () => $.ui.open({ id: CONTEXT_PANE, title: 'Context' })
}

function viewSetter($: EngineInterface) {
  return (v: ViewMode) => async () => {
    await update($, mode, () => v)
    await $.store.set('mode', v)
  }
}

// The session's cost as /cost totals it, and whether the account is on a subscription.
async function ledgerOf($: EngineInterface) {
  try {
    const u = await $.session.usage()
    return { usd: u.cost?.usd, isSub: u.rateLimits.length > 0 }
  } catch {
    return { usd: undefined, isSub: false }
  }
}

// What a request read first: the tool calls that ended since the previous request.
const afterOf = (t: TurnRecord, at: number) => {
  const since = (t.reqs ?? []).reduce((a, r) => Math.max(a, r.end), t.startedAt)
  const counts: Record<string, number> = {}
  for (const s of t.spans) if (s.end > since && s.end <= at) counts[shortName(s.tool)] = (counts[shortName(s.tool)] ?? 0) + 1
  const out = Object.entries(counts).map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(', ')
  return out === '' ? undefined : out
}

// Adds to the turn still running, if there is one.
function onLiveTurn($: EngineInterface, fn: (t: TurnRecord) => TurnRecord) {
  return update($, turns, list => {
    const at = list.length - 1
    if (at < 0 || list[at].endedAt !== undefined) return list
    return list.map((t, i) => (i === at ? fn(t) : t))
  })
}

const chunkPhase = (kind: string, was: Phase): Phase =>
  kind === 'thinking' ? 'thinking' : kind === 'text' ? 'writing' : kind === 'tool' || kind === 'input' ? 'composing' : was

export const register: Register = (on, options) => {
  const setting = String((options as Record<string, unknown>).cardsToKeep ?? '100')
  const limit = setting === 'all' ? Number.POSITIVE_INFINITY : Number(setting) > 0 ? Number(setting) : 100
  let ticker: { cancel: () => void } | undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'time-spent',
      description: 'Time per tool type; `view <mode>` switches the cards',
      argumentHint: '[context | view timeline|bars|compact|hide]',
    })
    const saved = await $.store.get('mode')
    if (isMode(saved)) await update($, mode, () => saved)
    const savedLanes = await $.store.get('lanes')
    if (typeof savedLanes === 'boolean') await update($, lanesOpen, () => savedLanes)
    const all = await read($, turns)
    if (all.length === 0 || all[all.length - 1].endedAt !== undefined) await update($, liveKey, () => null)
    // A history from before the totals existed: sum it once, then keep only the working set.
    if ((await read($, totals)).turns === 0 && all.some(t => t.endedAt !== undefined)) {
      await update($, totals, () => all.filter(t => t.endedAt !== undefined).reduce(addTotals, EMPTY_TOTALS))
    }
    for (const t of await read($, turns)) {
      if (t.endedAt === undefined || t.anchor === undefined) continue
      const id = keyOf(t.anchor.head, t.anchor.length)
      if ((await read($, atom({ ...doneFamily, id }, null))) === null) await keepCard($, id, t, limit)
    }
    await update($, turns, list => pruned(list))

    return next(e)
  })

  on('command.run', { command: 'time-spent' }, async ($, e) => {
    const [verb, arg] = e.args.trim().split(/\s+/)
    if (verb === 'context') {
      await $.ui.open({ id: CONTEXT_PANE, title: 'Context' })
      return { text: 'Context pane opened.' }
    }
    if (verb === 'view') {
      const current = await read($, mode)
      const want = arg === undefined || arg === '' ? MODES[(MODES.indexOf(current) + 1) % MODES.length] : arg === 'hide' ? 'off' : arg
      if (!isMode(want)) return { text: `Unknown view "${want}". Use one of: timeline, bars, compact, hide.` }
      await update($, mode, () => want)
      await $.store.set('mode', want)
      return { text: `Card view: **${want === 'off' ? 'hide' : want}**.` }
    }
    const sum = await read($, totals)
    if (sum.turns === 0) return { text: 'Nothing recorded yet in this chat.' }
    const claudeMs = Object.values(sum.claude).reduce((x, y) => x + y, 0)
    const lines = [
      `- **Claude**: ${fmt(claudeMs)} (${PHASES.map(p => `${p.label.toLowerCase()} ${fmt(sum.claude[p.phase] ?? 0)}`).join(', ')})`,
      ...Object.entries(sum.kinds)
        .sort((x, y) => y[1].ms - x[1].ms)
        .map(([label, k]) => `- **${label}**: ${fmt(k.ms)} (${k.calls} call${k.calls === 1 ? '' : 's'}: ${Object.keys(k.tools).join(', ')})`),
    ]

    return {
      text: [
        `**Time spent:** ${fmt(sum.turnMs)} over ${sum.turns} turn${sum.turns === 1 ? '' : 's'}${sum.usd !== undefined ? ` · **${money(sum.usd)}**` : ''}`,
        ...lines,
      ].join('\n'),
    }
  })

  on('turn.start', async ($, e, next) => {
    const now = await $.clock.now()
    const { usd: usdStart } = await ledgerOf($)
    await update($, turns, list => [...pruned(list), { turnId: e.turnId, startedAt: now, spans: [], model: [], sub: [], reqs: [], usdStart }])
    await update($, running, () => ({}))
    await update($, subRunning, () => ({}))
    await update($, step, () => null)
    await update($, liveKey, () => null)
    await update($, tick, () => now)
    ticker?.cancel()
    ticker = $.clock.every(1000, () => {
      void $.clock.now().then(t => update($, tick, () => t))
    })

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      ticker?.cancel()
      ticker = undefined
      const now = await $.clock.now()
      const nudge = nudgeOf(await read($, steps))
      const ledger = await ledgerOf($)
      await update($, turns, list =>
        list.map(t =>
          t.turnId === e.turnId
            ? {
                ...t,
                endedAt: now,
                nudge,
                isSub: ledger.isSub,
                usd: ledger.usd !== undefined && t.usdStart !== undefined ? Math.max(0, ledger.usd - t.usdStart) : undefined,
              }
            : t,
        ),
      )
      const finished = (await read($, turns)).find(t => t.turnId === e.turnId)
      if (finished !== undefined) await update($, totals, sum => addTotals(sum, finished))
      if (finished?.anchor !== undefined) {
        const id = keyOf(finished.anchor.head, finished.anchor.length)
        await keepCard($, id, finished, limit)
      }
      await update($, liveKey, () => null)
      await update($, running, () => ({}))
      await update($, step, () => null)
      await update($, tick, () => now)
    }

    return next(e)
  })

  // Model requests: the main loop's split by what is streaming; a subagent's as one span.
  on('turn.step', async function* ($, e, next) {
    const t0 = await $.clock.now()
    const isMain = e.agentId === undefined
    const segs: PhaseSeg[] = []
    let phase: Phase = 'waiting'
    let since = t0
    const subId = `${e.agentId ?? ''}:${e.turnId}:${e.index}`
    if (isMain) await update($, step, () => ({ phase, since }))
    else {
      const agentId = e.agentId as string
      await update($, subRunning, r => ({ ...r, [subId]: { agentId, tool: '@model', start: t0 } }))
    }
    const stream = next(e)
    let ran: { usage?: Usage | null } | undefined
    try {
      for await (const chunk of stream) {
        const p = chunkPhase((chunk as { kind: string }).kind, phase)
        if (isMain && p !== phase) {
          const at = await $.clock.now()
          segs.push({ phase, start: since, end: at })
          phase = p
          since = at
          await update($, step, () => ({ phase, since }))
        }
        yield chunk
      }
      ran = await stream.result
      return ran
    } finally {
      const end = await $.clock.now()
      if (isMain) {
        segs.push({ phase, start: since, end })
        await update($, step, () => null)
        const usage = ran?.usage
        await onLiveTurn($, t => {
          if (!usage) return { ...t, model: [...(t.model ?? []), ...segs] }
          const req: Req = {
            start: t0,
            end,
            model: usage.model ?? '',
            usd: usdOf(usage),
            input: usage.input_tokens ?? 0,
            output: usage.output_tokens ?? 0,
            cacheRead: usage.cache_read_input_tokens ?? 0,
            cacheWrite: usage.cache_creation_input_tokens ?? 0,
            after: afterOf(t, t0),
          }
          return { ...t, model: [...(t.model ?? []), ...segs], reqs: [...(t.reqs ?? []), req] }
        })
        if (usage) {
          const fresh = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
          const context = fresh + (usage.cache_read_input_tokens ?? 0)
          const ttft = segs[0]?.phase === 'waiting' ? segs[0].end - segs[0].start : 0
          const turn = (await read($, totals)).turns + 1
          const isMiss = context > 20_000 && fresh > context / 2
          const stat: StepStat = { turn, at: t0, ttft, context, fresh, isMiss, usd: usdOf(usage), missUsd: isMiss ? missUsdOf(usage) : undefined }
          await update($, steps, list => [...list, stat].slice(-500))
        }
      } else {
        const agentId = e.agentId as string
        await update($, subRunning, r => {
          const { [subId]: _, ...rest } = r
          return rest
        })
        await addSub($, { agentId, tool: '@model', start: t0, end, usd: ran?.usage ? usdOf(ran.usage) : undefined })
      }
    }
  })

  on('tool.call', async ($, e, next) => {
    const start = await $.clock.now()
    if (e.agentId !== undefined) {
      const agentId = e.agentId
      const id = e.tool_use_id
      await update($, subRunning, r => ({ ...r, [id]: { agentId, tool: e.tool, start } }))
      try {
        return await next(e)
      } finally {
        const end = await $.clock.now()
        await update($, subRunning, r => {
          const { [id]: _, ...rest } = r
          return rest
        })
        await addSub($, { agentId, tool: e.tool, start, end })
      }
    }
    const detail = detailOf(e)
    const isBg = (e as unknown as Record<string, unknown>).run_in_background === true
    await update($, running, r => ({ ...r, [e.tool_use_id]: { tool: e.tool, start, detail } }))
    try {
      const ran = await next(e)
      if (isBg) {
        const task: BgTask = { id: e.tool_use_id, tool: e.tool, start, detail, taskId: taskIdOf(ran) }
        await onLiveTurn($, t => ({ ...t, bg: [...(t.bg ?? []), task] }))
      }
      return ran
    } finally {
      const end = await $.clock.now()
      await update($, running, r => {
        const { [e.tool_use_id]: _, ...rest } = r
        return rest
      })
      await onLiveTurn($, t => ({ ...t, spans: [...t.spans, { tool: e.tool, start, end, detail }] }))
    }
  })

  // Each text block the model writes on the main loop becomes the turn's anchor.
  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    if (e.agentId === undefined && e.message.role === 'user') {
      const raw = JSON.stringify(e.message.content ?? '')
      const ends = [...raw.matchAll(/<task-id>([^<]+)<\/task-id>[\s\S]*?<status>([^<]+)<\/status>/g)]
      if (ends.length > 0) {
        const now = await $.clock.now()
        for (const [, taskId, status] of ends) {
          if (!/complet|fail|kill|stop|cancel|error/i.test(status)) continue
          await update($, turns, list =>
            list.map(t =>
              (t.bg ?? []).some(b => b.taskId === taskId && b.end === undefined)
                ? { ...t, bg: (t.bg ?? []).map(b => (b.taskId === taskId && b.end === undefined ? { ...b, end: now, status } : b)) }
                : t,
            ),
          )
          const owner = (await read($, turns)).find(t => (t.bg ?? []).some(b => b.taskId === taskId))
          if (owner?.endedAt !== undefined && owner.anchor !== undefined) {
            const id = keyOf(owner.anchor.head, owner.anchor.length)
            if ((await read($, doneOrder)).includes(id)) await update($, atom({ ...doneFamily, id }, null), () => owner)
          }
        }
      }
      return stored
    }
    if (e.agentId !== undefined || e.door !== 'response' || e.message.role !== 'assistant') return stored
    const texts = (Array.isArray(e.message.content) ? e.message.content : [])
      .filter((b: { type?: string; text?: string }) => b.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '')
      .map((b: { text: string }) => b.text)
    const text = texts[texts.length - 1]
    if (text === undefined) return stored
    const head = headOf(text)
    const length = text.trim().length
    const anchor = { id: stored.uuid, head, length }
    const list = await read($, turns)
    const last = list[list.length - 1]
    if (last === undefined) return stored
    if (last.endedAt === undefined) {
      await onLiveTurn($, t => ({ ...t, anchor }))
      await update($, liveKey, () => keyOf(head, length))
      return stored
    }
    // The reply landed after its turn ended: move that turn's finished card down to it.
    const moved = { ...last, anchor }
    await update($, turns, l => l.map(t => (t.turnId === last.turnId ? moved : t)))
    if (last.anchor !== undefined) {
      await dropCard($, keyOf(last.anchor.head, last.anchor.length))
    }
    await keepCard($, keyOf(head, length), moved, limit)

    return stored
  })

  on('ui.render', { component: 'Pane', requestId: CONTEXT_PANE }, async ($, e) => {
    const els = $.ui.resolve(e) as unknown as Els

    return contextPane(els, await read($, steps), Math.max(30, e.props.bodyColumns ?? 40), await read($, totals))
  })

  // The live card sits above the prompt: inline, under a text block the desktop app folds into
  // the turn's tool group, it was hidden while the turn ran.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const list = await read($, turns)
    const turn = list[list.length - 1]
    const view = await read($, mode)
    if (turn === undefined || turn.endedAt !== undefined || view === 'off') return next(e)
    const els = $.ui.resolve(e) as unknown as Els
    try {
      const now = Math.max(await read($, tick), turn.startedAt)
      const live = Object.values(await read($, running))
      const phase = await read($, step)
      const v = viewOf(turn, live, phase, now, Object.values(await read($, subRunning)))
      const open = await read($, lanesOpen)
      const doing = live.length > 0 ? `Running ${[...new Set(live.map(c => shortName(c.tool)))].join(', ')}` : phase !== null ? phaseOf(phase.phase).label : 'Working'
      return cardOf(els, v, view, Math.max(40, e.props.bodyColumns), viewSetter($), { open, toggle: lanesToggle($, open) }, doing, contextOpener($))
    } catch (err) {
      return <els.Text color="#F43F5E">time-spent: {String(err)}</els.Text>
    }
  })

  // Inline, under the turn's reply: the full card once the turn ends.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    // A finished card reads its own member alone, so other turns' writes never redraw it.
    const key = keyOf(headOf(e.props.text), e.props.text.trim().length)
    const finished = await read($, atom({ ...doneFamily, id: key }, null))
    const turn: TurnRecord | undefined = finished ?? undefined
    if (turn === undefined) return next(e)
    const view = await read($, mode)
    const els = $.ui.resolve(e) as unknown as Els
    const isLive = turn.endedAt === undefined
    if (view === 'off') {
      if (isLive) return next(e)
      return (
        <els.Box flexDirection="column" gap={1}>
          <els.Markdown text={e.props.text} />
          {switcherOf(els, view, viewSetter($))}
        </els.Box>
      )
    }
    try {
      const now = isLive ? Math.max(await read($, tick), turn.startedAt) : (turn.endedAt as number)
      const live = isLive ? Object.values(await read($, running)) : []
      const subLive = isLive ? Object.values(await read($, subRunning)) : []
      const v = viewOf(turn, live, isLive ? await read($, step) : null, now, subLive)
      const phase = isLive ? await read($, step) : null
      const open = await read($, lanesOpen)
      const doing = live.length > 0 ? `Running ${[...new Set(live.map(c => shortName(c.tool)))].join(', ')}` : phase !== null ? phaseOf(phase.phase).label : 'Working'

      return (
        <els.Box flexDirection="column" gap={1}>
          <els.Markdown text={e.props.text} />
          {cardOf(els, v, view, Math.max(40, e.viewport?.columns ?? 80), viewSetter($), { open, toggle: lanesToggle($, open) }, doing, contextOpener($))}
        </els.Box>
      )
    } catch (err) {
      return (
        <els.Box flexDirection="column">
          <els.Markdown text={e.props.text} />
          <els.Text color="#F43F5E">time-spent: {String(err)}</els.Text>
        </els.Box>
      )
    }
  })
}
