# Build log

Dated record of what was built in this repo. All times are UK time. Everything here was written after the hackathon kickoff at 16:00 on Mon 26 Oct 2026.

| Date | What |
|---|---|
| Mon 26 Oct | Repo started: README with the "Before the event" note, MIT licence. |
| Mon 26 Oct | PR 1, scaffold: Bun 1.4.4 and TypeScript, CI (typecheck, unit tests, messy-input suite), `.env.example` with names only, env reader that treats placeholder secrets as missing. |
| Mon 26 Oct | PR 1, QA round 1 fixes: the `.env.example` guard now fails on a value even in a comment line; placeholder secrets (quoted blanks, `xxxx`, `YOUR_API_KEY_HERE`, `sk-...`, zero-width spaces, the name as its own value) read as missing; CI fails if a test file sits where CI doesn't run it; lockfile refreshed. README "Before the event" note replaced with Shola's approved wording. |
| Mon 26 Oct | PR 1, QA round 2 fixes: the `.env.example` guard catches `NAME=value` anywhere on a line (`## `, `# export `, `# e.g. `, `# - `); the test-location guard covers `.spec`, `_test` and `_spec` files in every JS and TS form; operator-chosen values such as `my-stallsnap-verify-2026` are no longer read as placeholders. |
