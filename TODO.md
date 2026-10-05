# TODO

- **Keep writes small in long sessions.** Every state write copies the whole `turns`
  history (up to 200 turns, ~1–2 MB at worst). Keep only the running turn there; finished
  turns already live in their own `done` card copy, so every card still shows.
- **Setting: how many cards to keep.** The `done` copies are never pruned. Add a
  `userConfig` option (for example "Cards to keep", default 100) and drop the oldest copies
  past it; those turns then show as plain messages.
- **License.** The repo has none yet; decide whether to add one (for example MIT).
