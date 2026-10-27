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

Voice notes arrive as type `audio` with `voice: true` (Meta's audio webhook reference). Type `voice` is accepted too.

### Sending

`src/whatsapp/graph.ts` sends through the Graph API v26.0 with `WHATSAPP_ACCESS_TOKEN` (a system-user token) and `WHATSAPP_PHONE_NUMBER_ID`: plain text, a message with one reply button, a message with one link button, and the "typing..." indicator. It keeps messages to one person 6 seconds apart (WhatsApp's pair rate limit) and retries rate limits, Meta server errors and network failures after 1, 4 and 16 seconds. It downloads photos and voice notes by media id, checking type, size and hash, and fetches a fresh URL once if the 5-minute URL has expired.

### Crash safety

`src/joblog.ts` keeps an append-only log in `.data/joblog.jsonl`, synced to disk after every write:

- **Dedupe.** Meta retries webhooks for up to 7 days. A message id seen before is dropped, also after a restart.
- **Nothing lost.** A message is recorded before the 200 goes back. One a crash left unhandled is handled again at start-up.
- **No double paid calls.** Each paid step of a job is recorded as started before the call and done after. A finished step returns its saved result without calling again. A step a crash cut off is never rerun, because Meta may have billed it: the job log marks that job failed itself, so no job can be left open.
- **Damage stops start-up.** A line that isn't one of the entries the log writes stops start-up rather than being guessed at; only a last line cut short by a crash is trimmed.

Run one server process per `.data/` folder, and keep `.data/` on a persistent volume: a wiped disk loses the dedupe record, and Meta's retries would be handled again.

The log holds traders' numbers and messages, so `.data/` is kept out of git.

## Meta Model API

`src/meta/client.ts` is the only code that calls the Meta Model API (`https://api.meta.ai/v1`), and every call goes through `SpendGuard.paid()`. Costs come from Meta's published Standard-mode prices (`src/meta/costs.ts`, read 26 Oct 2026). Contributor mode is never used, because it lets Meta train on traders' photos and voice notes.

Each request has a 120-second time limit. Rate limits (429), Meta server errors (500, 502, 503, 504), timeouts and network failures are retried up to 3 attempts in all, with exponential backoff and jitter, waiting at least as long as Meta's `Retry-After` (capped at 30 seconds). Other errors are not retried. Every attempt is its own paid call, so SpendGuard counts and caps each one. A missing or placeholder `MODEL_API_KEY` stops the client being created, before any paid call.

In development, pass a cache directory. A request already made is answered from `.cache/` for free and never reaches SpendGuard, so reruns cost nothing.

### Voice notes

`src/pipeline/voice.ts` converts a WhatsApp voice note (OGG/Opus) to mono 16-bit 24 kHz WAV with ffmpeg, then sends it to Muse Voice Transcribe. Nigerian Pidgin isn't one of that model's evaluated languages, so the request sets `languageBias: ["English"]` and passes price words (naira, ₦, kobo) and the stall's item names as keywords. Notes under 0.3 seconds or over 10 minutes are refused before any paid call. A file over 16 MB (WhatsApp's own audio limit) is refused before decoding, and decoding stops at 601 seconds, so a very long note can't fill the server's memory. An empty transcript asks the trader to send again; nothing is guessed. Pidgin accuracy is a measured risk, not a solved one.

ffmpeg must be installed to run the server and the tests.

### Cut-outs

`src/pipeline/cutouts.ts` turns one stall photo into one transparent PNG per product, following Meta's SAM 3 Agent pattern:

1. The photo is turned upright (EXIF) and shrunk to at most 1600 px.
2. Muse Spark proposes up to 12 products, each with two short phrasings, plus one broad phrase for the stall's goods. Phrasings with lists, negation or position words are dropped, because SAM 3.1 can't use them.
3. SAM 3.1 segments each phrasing, and "person" once. Masks under 0.5 confidence are dropped, as are masks covering more than 40% of the photo (a table or the whole stall), masks lying mostly on a person, and duplicates (more than 30% of the smaller mask). If one SAM call fails, no new ones start.
4. Each proposed product keeps only its most confident instance, so 40 tins or a heap of tomatoes give one cut-out. At most 6 extra items from the broad phrase are kept.
5. Muse Spark reviews a zoomed crop of each candidate and keeps only sellable products with a name. A crop without a clear verdict is dropped.
6. Muse Spark boxes any product nothing caught, and SAM 3.1 segments those boxes in one request (at most 16). Those masks get every check above, including review, so a box over the trader's shirt can't become a product.
7. Each product is cut from the trader's own pixels with its mask. Nothing is generated.

A photo with corrupt data, or one too large to open (over 100 megapixels), is refused with a message the trader can act on.

Whatever the photo holds, one photo costs at most 35 paid calls, so a job takes one stall photo and stays within the 60-call limit.

To try it on a real photo (needs `MODEL_API_KEY`; responses are cached in `.cache/`):

```bash
bun src/pipeline/try-cutouts.ts stall.jpg
```

### Prices: ask, never guess

`src/pipeline/pricing.ts` runs a Muse Spark tool loop over the item list and everything the trader said (voice transcripts and typed text). Spark can only call `set_price(item, price, unit, quote)` or `flag_missing_price(item)`. A price counts only when the quote verifier in `src/pipeline/quotes.ts` agrees, in code:

| Rule | Asked back instead of priced |
|---|---|
| The quote is the trader's own words, as whole words in one message | a made-up quote; "3000" cut out of "30000" |
| Code reads exactly one price from the quote, equal to Spark's | "rice dey" (no price), "N/A", "free", 650 read as 650,000, "1,5OO" (letter O), "1000-1200", "2k/2.5k", "500 each, 2000 for five" |
| The quote sits in this item's part of the message, which names the item before the price | Rice's price used for Beans; "all the tins 800" for a bag of rice |
| It is not one end of a range | "5-8 thousand", "5 to 8k", "two to three thousand", "1,000-1,200", "2000 or 2500" |
| It is the trader's last word on the item | "3000... no, 3500" quoted as 3000; a later voice note with a new price |
| No other item has the same name | two items both called "Tomato" |

Prices are read as traders say them: `650` is 650, `₦6,000` is 6,000, `3k` and `3 thousand` are 3,000, `1.8` is 1,800, `1.500` is 1,500, `5-8` on its own is 5,800 (but "5-8 thousand" is a range), and number words ("two thousand five hundred") work. "All the tins 800" prices every item sold by the tin.

A refused call goes back to Spark with the reason, so it can fix it or flag the item. Any item still without a price is asked about with a question code writes ("How much is Rice?"). The model's own wording never reaches the trader.

The loop stops when every item is decided, when Spark answers in plain text, after 4 turns, or when the same call is made 3 times. History is replayed statelessly (`store: false`, encrypted reasoning).

## Build log

See [docs/build-log.md](docs/build-log.md).

## Licence

MIT. See [LICENSE](LICENSE).
