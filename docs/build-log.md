# Build log

Dated record of what was built in this repo. All times are UK time. Everything here was written after the hackathon kickoff at 16:00 on Mon 26 Oct 2026.

| Date | What |
|---|---|
| Mon 26 Oct | Repo started: README with the "Before the event" note, MIT licence. |
| Mon 26 Oct | PR 1, scaffold: Bun 1.4.4 and TypeScript, CI (typecheck, unit tests, messy-input suite), `.env.example` with names only, env reader that treats placeholder secrets as missing. |
| Mon 26 Oct | PR 2, spend cap: `SpendGuard.paid()` with a $2 daily cap, 60 calls per job and the `STALLSNAP_PAID_CALLS=off` switch. Worst-case cost is held before each call; spend survives restarts; a damaged ledger stops paid calls. Mutation-checked: breaking any limit fails a test. |
