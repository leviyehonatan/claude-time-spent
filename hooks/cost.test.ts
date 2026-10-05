import { expect, mock, test } from 'claude-code/testing'

// One main-loop request on Opus 5.5: 10k fresh input, 100k cache read, 2k output.
const USAGE = { model: 'claude-opus-5-5', input_tokens: 10_000, output_tokens: 2_000, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 0 }
// 10k × $4 + 2k × $20 + 100k × $0.20 per million = $0.10
const PRICE = '$0.10'

// The engine's side: a mocked clock and store, a session ledger at `ledger`, the turn events answered.
const engine = (on: any, ledger?: { usd: number }) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('session.usage', async () => ({ value: { startedAt: 0, context: {}, rateLimits: [], cost: ledger && { usd: ledger.usd } } }))
  on('turn.start', async ($: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', async () => ({ text: 'hi' }))
  on('turn.step', async function* ($: any, e: any) {
    await clock.advance(2000)
    yield { kind: 'text', index: 0, text: 'hi' }
    return { turnId: e.turnId, index: e.index, answer: 'hi', toolUses: [], stopReason: 'end_turn', usage: USAGE }
  })
  return clock
}

const turn = async ($: any) => {
  await $.turn.start({ turnId: 't1', text: 'go', kind: 'prompt' })
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  for await (const _ of stream) {
  }
  await stream.result
}

const command = ($: any) => $.command.run({ command: 'time-spent', args: '', origin: { kind: 'user' }, presentation: 'text' })

test('a turn is priced from its requests', async ($: any, on: any) => {
  engine(on)
  await turn($)
  await $.turn.complete({ turnId: 't1', reason: 'end_turn', text: 'hi' })
  expect((await command($)).text).toContain(PRICE)
})

test("a turn's total is the ledger's growth when there is a ledger", async ($: any, on: any) => {
  const ledger = { usd: 5 }
  engine(on, ledger)
  await turn($)
  ledger.usd = 5.37
  await $.turn.complete({ turnId: 't1', reason: 'end_turn', text: 'hi' })
  expect((await command($)).text).toContain('$0.37')
})

test('the live card draws under the spinner row while the turn runs', async ($: any, on: any) => {
  engine(on)
  // The engine's own spinner row, which the card draws under.
  on('ui.render', { component: 'Spinner' }, async ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, null, e.props.word)
  })
  await turn($)
  for (const surface of ['terminal', 'desktop'] as const) {
    const m = await $.ui.mount({ plugin: 'time-spent', surface, component: 'Spinner', props: { word: 'Working', message: null, suffix: '…', mode: 'tool-use' } })
    const drawn = JSON.stringify(await m.drawn())
    expect(drawn).toContain(PRICE)
    expect(drawn).toContain('Working')
  }
})

test('on the desktop the full live card draws under the live tool group', async ($: any, on: any) => {
  engine(on)
  on('ui.render', { component: 'ToolGroup' }, async ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, null, 'Ran 2 commands')
  })
  await turn($)
  const group = (isActive: boolean) => ({ calls: [], isActive, isExpanded: false })
  const live = JSON.stringify(await (await $.ui.mount({ plugin: 'time-spent', surface: 'desktop', component: 'ToolGroup', props: group(true) })).drawn())
  expect(live).toContain('Ran 2 commands')
  expect(live).toContain(PRICE)
  const old = JSON.stringify(await (await $.ui.mount({ plugin: 'time-spent', surface: 'desktop', component: 'ToolGroup', props: group(false) })).drawn())
  expect(old).not.toContain(PRICE)
})
