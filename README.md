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

Each call states its worst-case cost. That amount is held before the call starts, so calls running together can't pass the cap, and is swapped for the real cost when the call ends. A call that fails keeps its worst-case cost, since Meta may have billed it. Each retry must be its own paid call.

Spend and per-job counts live only in `.data/spend-ledger.json`. Every check reads and writes that file under a lock, so two processes on one machine share one $2 cap. Money is counted in whole micro-dollars. The day rolls over at UTC midnight and only forwards, so a clock stepping back can't reset the cap. If the file is damaged, paid calls stop until it is fixed. Keep `.data/` on a persistent volume: a host that wipes the disk on each deploy would start each deploy at $0. Any value of `STALLSNAP_PAID_CALLS` other than blank, `on` or `off` stops start-up, and nothing in the code can switch paid calls on when it says `off`.

Check today's spend with `bun src/spend-guard.ts`.

## WhatsApp webhook

`bun src/server.ts` starts the server. It needs `APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` and `ALLOWED_NUMBERS` and refuses to start without them. `WHATSAPP_PHONE_NUMBER_ID` is optional; when set, messages to any other business number are dropped.

| Route | What it does |
|---|---|
| `GET /webhook` | Meta's verify handshake: echoes `hub.challenge` (digits only) when `hub.verify_token` matches |
| `POST /webhook` | Checks `X-Hub-Signature-256` against `APP_SECRET` on the raw body (401 if wrong), drops numbers not in `ALLOWED_NUMBERS`, records each new message id, then answers 200 and handles the messages afterwards |
| `GET /health` | Answers `ok` |

`ALLOWED_NUMBERS` takes international numbers separated by commas, for example `+44 (0)7700 900123, 2348000000001`. A `(0)` trunk prefix and invisible marks copied from phone contacts are removed. A local number such as `07700900123`, a 0 straight after +44 or +234, or anything that isn't a phone number stops start-up, and the error names the entry by its position and last 4 digits only.

Voice notes are accepted whether Meta sends them as type `voice` or as `audio` with `voice: true`.

### Crash safety

`src/joblog.ts` keeps an append-only log in `.data/joblog.jsonl`, synced to disk after every write:

- **Dedupe.** Meta retries webhooks for up to 7 days. A message id seen before is dropped, also after a restart.
- **Nothing lost.** A message is recorded before the 200 goes back. One a crash left unhandled is handled again at start-up.
- **No double paid calls.** Each paid step of a job is recorded as started before the call and done after. A finished step returns its saved result without calling again. A step a crash cut off is never rerun, because Meta may have billed it: the job log marks that job failed itself, so no job can be left open.
- **Damage stops start-up.** A line that isn't one of the entries the log writes stops start-up rather than being guessed at; only a last line cut short by a crash is trimmed.

Run one server process per `.data/` folder, and keep `.data/` on a persistent volume: a wiped disk loses the dedupe record, and Meta's retries would be handled again.

The log holds traders' numbers and messages, so `.data/` is kept out of git.

## Build log

See [docs/build-log.md](docs/build-log.md).

## Licence

MIT. See [LICENSE](LICENSE).
