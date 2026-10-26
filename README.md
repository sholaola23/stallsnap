# StallSnap

StallSnap builds a priced catalogue for a market trader from a stall photo and a voice note sent on WhatsApp.

## Before the event

Before the hackathon kickoff (16:00 UK, Mon 26 Oct 2026), there were design notes, an idea spike, a day-one test and early prototype code for StallSnap in a separate repo. None of that is in this repo. Everything here was written after kickoff, and the dated build log shows when.

## Status

Work in progress for the Meta Global AI Developer Hackathon 2026 (Indie track). Submissions are due Wed 4 Nov 2026, 9pm ET.

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

## WhatsApp webhook

`bun src/server.ts` starts the server. It needs `APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` and `ALLOWED_NUMBERS` and refuses to start without them. `WHATSAPP_PHONE_NUMBER_ID` is optional; when set, messages to any other business number are dropped.

| Route | What it does |
|---|---|
| `GET /webhook` | Meta's verify handshake: echoes `hub.challenge` (digits only) when `hub.verify_token` matches |
| `POST /webhook` | Checks `X-Hub-Signature-256` against `APP_SECRET` on the raw body (401 if wrong), drops numbers not in `ALLOWED_NUMBERS`, records each new message id, then answers 200 and handles the messages afterwards |
| `GET /health` | Answers `ok` |

`ALLOWED_NUMBERS` takes international numbers separated by commas, for example `+44 7700 900123, 2348031234567`. A local number such as `07700900123`, or anything that isn't a phone number, stops start-up.

Voice notes are accepted whether Meta sends them as type `voice` or as `audio` with `voice: true`.

### Crash safety

`src/joblog.ts` keeps an append-only log in `.data/joblog.jsonl`, synced to disk after every write:

- **Dedupe.** Meta retries webhooks for up to 7 days. A message id seen before is dropped, also after a restart.
- **Nothing lost.** A message is recorded before the 200 goes back. One a crash left unhandled is handled again at start-up.
- **No double paid calls.** Each paid step of a job is recorded as started before the call and done after. A finished step returns its saved result without calling again. A step a crash cut off is never rerun, because Meta may have billed it, so that job fails cleanly instead.

The log holds traders' numbers and messages, so `.data/` is kept out of git.

## Meta Model API

`src/meta/client.ts` is the only code that calls the Meta Model API (`https://api.meta.ai/v1`), and every call goes through `SpendGuard.paid()`. Costs come from Meta's published Standard-mode prices (`src/meta/costs.ts`, read 26 Oct 2026). Contributor mode is never used, because it lets Meta train on traders' photos and voice notes.

In development, pass a cache directory. A request already made is answered from `.cache/` for free and never reaches SpendGuard, so reruns cost nothing.

### Voice notes

`src/pipeline/voice.ts` converts a WhatsApp voice note (OGG/Opus) to mono 16-bit 24 kHz WAV with ffmpeg, then sends it to Muse Voice Transcribe. Nigerian Pidgin isn't one of that model's evaluated languages, so the request sets `languageBias: ["English"]` and passes price words (naira, ₦, kobo) and the stall's item names as keywords. Notes under 0.3 seconds or over 10 minutes are refused before any paid call. An empty transcript asks the trader to send again; nothing is guessed. Pidgin accuracy is a measured risk, not a solved one.

ffmpeg must be installed to run the server and the tests.

## Build log

See [docs/build-log.md](docs/build-log.md).

## Licence

MIT. See [LICENSE](LICENSE).
