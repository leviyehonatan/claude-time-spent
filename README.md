# claude-time-spent

A Claude Code mod that shows where the time in each turn went: Claude's own work
(thinking, writing, composing tool input, waiting for the first token) and every
tool type (commands, agents, edits, reads and searches, web, browser, MCP), and what
the turn cost, as a card inline in the chat.

- **Live card** under the running turn's spinner, updated every second (always in view,
  even while the desktop app folds the turn's messages into its tool group; above the prompt
  on surfaces with no spinner row)
- **Finished card** under the final reply: a time strip of the turn in order, a legend
  with totals, and lanes per tool type (calls that ran together stack; parallel time is
  shaded; a subagent's own model and tool time shows on an "inside" lane)
- **Background tasks** (commands and agents run in the background) on the card of the
  turn that launched them, from launch to their completion notice
- A footer that compares recorded time with what the chart accounts for
- **Cost** of each turn: the exact total from the session's cost ledger (what `/cost` reads),
  split into Claude's own requests, agents and anything else, the cost on the Claude and
  Agents lanes, and, with the lanes open, the priciest requests with the tool results each
  one read first. Requests are priced from their token counts at list price, then scaled to
  the ledger. On a subscription the figures are API list-price equivalents, not a bill.
- **Context pane** (the **context ↗** button on a card, or `/time-spent context`): the context
  size now and over the session, the median first-token wait by context size (cached requests
  only), cache misses with how much they re-read and what they cost over a cached read, and the
  session's cost (from the ledger, so cost between turns counts too) with a cost-per-turn trend
- A quiet **ⓘ** line on a turn's card when cached requests now wait at least twice as long as
  early in the session at 100k+ tokens, suggesting `/compact` or a new session
- Views: `timeline`, `bars`, `compact`, `hide`; click **▾ ◷ Time spent** to fold the lanes.
  Both choices are remembered across sessions.

The desktop app draws the cards as SVG; the terminal gets a text version.

## Install

```bash
git clone https://github.com/leviyehonatan/claude-time-spent ~/.claude/mods/time-spent
```

Then add the folder to the `env` block of `~/.claude/settings.json`:

```json
"env": {
  "CLAUDE_CODE_PLUGIN_DIRS": "~/.claude/mods/time-spent"
}
```

New sessions load it, including ones the desktop app starts. A running session picks
it up after a restart (in the terminal, `claude --resume`). For a single terminal session
instead: `claude --plugin-dir ~/.claude/mods/time-spent`.

## Settings

- **Cards to keep** (`25`, `50`, `100`, `200`, `all`; default `100`): how many finished turns keep
  their card in a session. Older turns show as plain messages. Change it in `/config`.

## Commands

- `/time-spent`: totals for the whole session, per tool type
- `/time-spent context`: open the Context pane
- `/time-spent view <timeline|bars|compact|hide>`: switch the cards' view

## Files

- `hooks/register.tsx`: the hooks module
- `types/index.d.ts`: the state contract
- `.claude-plugin/plugin.json`: the manifest

## License

MIT: see [LICENSE](LICENSE).
