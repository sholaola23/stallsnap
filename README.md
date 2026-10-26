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

Voice notes arrive as type `audio` with `voice: true` (Meta's audio webhook reference). Type `voice` is accepted too.

### Sending

`src/whatsapp/graph.ts` sends through the Graph API v26.0 with `WHATSAPP_ACCESS_TOKEN` (a system-user token) and `WHATSAPP_PHONE_NUMBER_ID`: plain text, a message with one reply button, a message with one link button, and the "typing..." indicator. It keeps messages to one person 6 seconds apart (WhatsApp's pair rate limit) and retries rate limits, Meta server errors and network failures after 1, 4 and 16 seconds. It downloads photos and voice notes by media id, checking type, size and hash, and fetches a fresh URL once if the 5-minute URL has expired.

### The conversation

`src/whatsapp/conversation.ts` runs one catalogue job per trader. Every message StallSnap sends is in `src/whatsapp/copy.ts`.

| Trader sends | StallSnap replies |
|---|---|
| A greeting or anything off-topic | The welcome, which says StallSnap only makes catalogues |
| A photo only | "Photo received. Now send a voice note saying your prices." |
| A voice note only | "Voice note received. Now send a photo of your stall." |
| A photo and a voice note (or typed prices, or a caption), in either order | "Thank you! I am making your price list now...", with "typing..." while it works |
| (Some items have no price) | One message listing those items with a question each. Nothing is guessed |
| A voice note or text answering | **One** priced list with **one** "Yes, publish" button. Items still without a price say "ask for price" |
| A change, such as "2 na 150" | A new list with a new button. The old button no longer publishes |
| "Yes, publish" (or a typed yes) | The catalogue link, as an "Open catalogue" button and as text to forward |
| A new photo at any point after the list | A new catalogue |

A photo or voice note StallSnap can't use (unreadable, too big, no speech) is dropped and the trader is asked to send it again; the rest of the job is kept. The spend cap pauses StallSnap and ends the job. Anything else that breaks ends the job, and the trader is asked to start again.

After a restart, a job that was working carries on: finished paid steps come back from the job log for free, and a paid step that was cut off ends the job cleanly. A message whose handling was cut off is handled again, and whatever it last sent goes again.

Limits per job: one photo, 10 voice notes or texts, 5 changes after the list.

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

### Cut-outs

`src/pipeline/cutouts.ts` turns one stall photo into one transparent PNG per product, following Meta's SAM 3 Agent pattern:

1. The photo is turned upright (EXIF) and shrunk to at most 1600 px.
2. Muse Spark proposes up to 12 products, each with two short phrasings, plus one broad phrase for the stall's goods. Phrasings with lists, negation or position words are dropped, because SAM 3.1 can't use them.
3. SAM 3.1 segments each phrasing, and "person" once. Masks under 0.5 confidence are dropped, as are masks lying mostly on a person. Overlapping masks are deduped by confidence (more than 30% of the smaller mask means a duplicate).
4. Muse Spark reviews a zoomed crop of each mask and keeps only sellable products. A crop without a clear verdict is dropped.
5. Muse Spark boxes any product nothing caught, and SAM 3.1 segments those boxes in one request (at most 16).
6. Each product is cut from the trader's own pixels with its mask. Nothing is generated.

One photo costs about 20 to 30 paid calls, so a job takes one stall photo, within the 60-call limit.

To try it on a real photo (needs `MODEL_API_KEY`; responses are cached in `.cache/`):

```bash
bun src/pipeline/try-cutouts.ts stall.jpg
```

### Prices: ask, never guess

`src/pipeline/pricing.ts` runs a Muse Spark tool loop over the item list and everything the trader said (voice transcripts and typed text). Spark can only call `set_price` or `flag_missing_price`, and every call is checked before it counts:

| Check | Refused example |
|---|---|
| The item is one of the cut-outs | item 3 on a two-item stall |
| Whole naira from 10 to 5,000,000 | `650.50` (kobo), `-6000`, `"N/A"` |
| A known sale unit | `per bag` |
| The quote is the trader's own words, found in the transcript | a quote Spark made up |
| If the quote has digits, the price matches one of them | 750 for "Peak milk na 650"; 600 for "6OO" |
| The quote isn't a range or a choice | "two to two-five", "3k or 3,500" |

A refused call is answered with the reason, so Spark can fix it or ask. Any item still without a price at the end gets a question for the trader. Shorthand the trader really uses is accepted: `₦6,000`, `6k`, `1.8` for 1,800, `5-8` for 5,800, and prices in words. A later correction wins over an earlier price.

The loop stops when every item is decided, when Spark answers in plain text, after 4 turns, or when the same call is made 3 times. History is replayed statelessly (`store: false`, encrypted reasoning).

## Build log

See [docs/build-log.md](docs/build-log.md).

## Licence

MIT. See [LICENSE](LICENSE).
