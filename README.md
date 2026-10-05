# claude-time-spent

A Claude Code mod that shows where the time in each turn went: Claude's own work
(thinking, writing, composing tool input, waiting for the first token) and every
tool type (commands, agents, edits, reads and searches, web, browser, MCP), as a
card inline in the chat.

- **Live card** under Claude's latest message while a turn runs, updated every second
- **Finished card** under the final reply: a time strip of the turn in order, a legend
  with totals, and lanes per tool type (calls that ran together stack; parallel time is
  shaded; a subagent's own model and tool time shows on an "inside" lane)
- **Background tasks** (commands and agents run in the background) on the card of the
  turn that launched them, from launch to their completion notice
- A footer that compares recorded time with what the chart accounts for
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

## Commands

- `/time-spent`: totals for the whole session, per tool type
- `/time-spent view <timeline|bars|compact|hide>`: switch the cards' view

## Files

- `hooks/register.tsx`: the hooks module
- `types/index.d.ts`: the state contract
- `.claude-plugin/plugin.json`: the manifest
