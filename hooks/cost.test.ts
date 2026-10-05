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

test('the live card draws above the prompt while the turn runs', async ($: any, on: any) => {
  engine(on)
  await turn($)
  for (const surface of ['terminal', 'desktop'] as const) {
    const m = await $.ui.mount({ plugin: 'time-spent', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: true, maxRows: 40, bodyColumns: 100 } })
    expect(JSON.stringify(await m.drawn())).toContain(PRICE)
  }
})
