# StallSnap

StallSnap builds a priced catalogue for a market trader from a stall photo and a voice note sent on WhatsApp.

## Before the event

**Before the event:** on the morning of kickoff day (Mon 26 Oct 2026, roughly 8am to 11am UK time), the idea was planned and tested in a separate repo. None of that code, data or test material is in this repo. Everything here was written after kickoff at 4pm UK the same day.

## Status

Work in progress for the Meta Global AI Developer Hackathon 2026 (Indie developer track). Submissions are due Wed 4 Nov 2026, 9pm ET.

## Develop

Needs [Bun](https://bun.sh) 1.4.4. Use bun, never npm.

```bash
bun install
bun run ci          # typecheck, unit tests, messy-input suite
```

The messy-input suite in `test/messy/` holds every attack QA has made on what this README promises. CI runs it on every pull request.

Secrets go in the environment, never in the repo. `.env.example` lists the names the code reads, with no values.

## Spend cap

Every paid Meta API call goes through `SpendGuard.paid()` in `src/spend-guard.ts`. It refuses a call before the call is made when:

| Limit | Value | What happens |
|---|---|---|
| `STALLSNAP_PAID_CALLS=off` | Off switch | Every paid call is refused |
| Calls per job | 60 | Call 61 in one job (one trader's photo and voice note) is refused |
| Daily spend | $2 (UTC day) | A call whose worst-case cost would take today's spend over $2 is refused |

Each call states its worst-case cost. That amount is held before the call starts, so calls running together can't pass the cap, and is swapped for the real cost when the call ends. A call that fails keeps its worst-case cost, since Meta may have billed it. Spend and per-job counts are kept in `.data/spend-ledger.json`, so a restart doesn't reset them. If that file is damaged, paid calls stop until it is fixed. Any value of `STALLSNAP_PAID_CALLS` other than blank, `on` or `off` stops start-up.

Check today's spend with `bun src/spend-guard.ts`.

## Build log

See [docs/build-log.md](docs/build-log.md).

## Licence

MIT. See [LICENSE](LICENSE).
