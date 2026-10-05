export type ViewMode = 'timeline' | 'bars' | 'compact' | 'off'

/** `detail` is what the call did, for the tooltip (a command's description, a file). */
export type ToolSpan = { tool: string; start: number; end: number; detail?: string }

export type RunningCall = { tool: string; start: number; detail?: string }

/** What the model was doing while a request streamed. */
export type Phase = 'waiting' | 'thinking' | 'writing' | 'composing'

export type PhaseSeg = { phase: Phase; start: number; end: number }

/** A subagent's own work: a model request (`tool: '@model'`) or one of its tool calls. */
export type SubSpan = { agentId: string; tool: string; start: number; end: number }

/** A command or agent launched in the background: from launch until its completion notice. */
export type BgTask = { id: string; tool: string; start: number; end?: number; detail?: string; taskId?: string; status?: string }

export type TurnRecord = {
  turnId: string
  startedAt: number
  endedAt?: number
  spans: ToolSpan[]
  /** The main loop's model requests, split by phase. */
  model: PhaseSeg[]
  /** Work done inside subagents during this turn. */
  sub: SubSpan[]
  /** Background work this turn launched; it is drawn on this turn's card alone. */
  bg?: BgTask[]
  /** The turn's latest text block so far: the finished card is drawn under it. */
  anchor?: { id: string; head: string; length: number }
}


/** The session so far, summed as each turn ends, for `/time-spent`. */
export type Totals = {
  turns: number
  turnMs: number
  /** Claude's time per phase. */
  claude: Record<string, number>
  /** Each tool type's time, calls and tools by name. */
  kinds: Record<string, { ms: number; calls: number; tools: Record<string, number> }>
}

declare module 'claude-code' {
  interface PluginState {
    'time-spent': {
      /**
       * The working set: the running turn, the last finished one (its reply may land late)
       * and any turn whose background tasks still run. Finished turns live in `done`.
       */
      turns: TurnRecord[]
      /** The session's totals. */
      totals: Totals
      /** How the summaries are drawn. */
      mode: ViewMode
      /** Whether the cards show their lanes under the strip. */
      lanes: boolean
      /** Main-loop tool calls still running, by tool_use_id. */
      running: Record<string, RunningCall>
      /** Subagent work still running (model requests and tool calls), drawn up to now. */
      subRunning: Record<string, { agentId: string; tool: string; start: number }>
      /** The main loop's model request in flight: its phase now and since when. */
      step: { phase: Phase; since: number } | null
      /** Each finished turn, by the key of the text block its card sits under. */
      done: StateFamily<TurnRecord | null>
      /** The key of the text block the running turn's live card sits under. */
      liveKey: string | null
      /** The clock, ticked each second while a turn runs, so the live view moves. */
      now: number
    }
  }
}
