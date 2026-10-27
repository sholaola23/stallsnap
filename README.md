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

`src/whatsapp/graph.ts` sends through the Graph API v26.0 with `WHATSAPP_ACCESS_TOKEN` (a system-user token) and `WHATSAPP_PHONE_NUMBER_ID`: plain text, a message with one reply button, a message with one link button, and the "typing..." indicator. It keeps messages to one person 6 seconds apart (WhatsApp's pair rate limit) and retries rate limits, Meta server errors and network failures after 1, 4 and 16 seconds. It downloads photos and voice notes by media id, checking type, size and hash, and fetches a fresh URL once if the 5-minute URL has expired. Every Graph call gives up after 30 seconds and every download after 60, and the access token is only sent to Meta's own media hosts (`lookaside.fbsbx.com`, `*.fbcdn.net`, `*.whatsapp.net` and similar, over https on the standard port).

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
| A change, such as "rice na 1500" (the list's own example uses the first item's name) | A new list with a new button. The old button no longer publishes |
| A text or voice note after the list with no number in it, such as "thanks" | A short hint on how to change a price or publish. Nothing is priced again |
| "Yes, publish" (or a typed yes such as "yes please", "ok o", "confirm" or 👍 in any skin tone) | The catalogue link, as an "Open catalogue" button and as text to forward |
| A reaction on the list | "To put it online, tap Yes, publish on the list." |
| A new photo at any point after the list | A new catalogue. The old list's button then gets "That list is from your old photo..." |

A photo or voice note StallSnap can't use (unreadable, too big, no speech) is dropped and the trader is asked to send it again; the rest of the job is kept. The spend cap pauses StallSnap and ends the job. Anything else that breaks ends the job, and the trader is asked to start again.

After a crash, the message that started the cut-off work is replayed once and gets one answer: a list whose text went out but whose button didn't gets only the button, and a publish that was cut off sends the link once. A message older than 23 hours (Meta retries for days) starts no paid work, since the reply window has probably closed.

Paid calls per job stay under SpendGuard's cap of 60 by design. Before each paid step the conversation checks the job can afford that step's worst case: 12 calls for a pricing round (4 turns, up to 3 attempts each) and 3 for each voice note not yet transcribed. If it can't, nothing paid starts: a change gets "That is a lot of changes...", and a first run whose cut-outs used the budget ends with a message asking for a photo with fewer items. If SpendGuard does refuse a call, the trader is told why: today's limit, this job's limit, or StallSnap being paused.

After a restart, a job that was working carries on: finished paid steps come back from the job log for free, and a paid step that was cut off ends the job cleanly. A message whose handling was cut off is handled again, and whatever it last sent goes again.

Limits per job: one photo, 10 voice notes or texts, 5 changes after the list.

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

`src/pipeline/pricing.ts` runs a Muse Spark tool loop over the item list and everything the trader said (voice transcripts and typed text). Spark can only call `set_price(item, price, unit, quote)` or `flag_missing_price(item)`. A price counts only when the quote verifier in `src/pipeline/quotes.ts` agrees, in code. It is an allow-list: a price is accepted only in one plain shape, and anything else is asked. A question to the trader is fine; a wrong price never is.

Each message is split at the listed items' names. A name is said when a run of that item's own name words includes the words that pick it out: "peak milk" or "peak milk 400g" for Peak Milk 400g, "50kg rice", "5 alive". After the name, up to the next item, the words must be:

- optional filler or packaging words ("the", "dey", "crate", "one cup"), an optional "na", "is" or "for", then **one price**;
- optionally a correction ("no", "sorry", "I mean") and a new price, where the last one wins;
- then only "naira", "per bag", "for one paint" or filler words.

One price is one number: digits or number words, with an optional N/₦ or "naira" and an optional k, thousand or hundred. `650` is 650, `₦6,000` and `N 6000` are 6,000, `3k`, `3 thousand` and `three thousand` are 3,000, `5 hundred` is 500, `5 hundred thousand` is 500,000, `2 thousand 5 hundred`, `2.5k` and `2k5` are 2,500, `1.8` is 1,800, `1.500` is 1,500, and `5-8` on its own is 5,800.

| Asked back instead of priced | Examples |
|---|---|
| A range or a choice | "5-8 thousand", "5 to 8k", "1,000-1,200", "2000 or 2500", "eggs 30 to 35 thousand" |
| A quantity | "2 7up 600", "2 bags of rice 6000", "3 tins of peak milk 1500", "rice for two 1000", "rice 500 each" |
| Anything else after the price | "rice 500, 2000 for five", "rice na 3000 add am to beans" |
| A number that can't be read | "1,5OO" (letter O), "650.50" |
| A name that isn't said | "all the tins 800", "the sachet na 100" |
| Two items with the same name | two items both called "Tomato" |
| The quote isn't the trader's words for this item, with its latest price | a made-up quote; Rice's price used for Beans; "3000" after "no, 3500" |

A size or number in a name is part of the name, never a price: "bread n500 na 700" is 700 for Bread N500, and "rice n500 to n700" is still a range. A later message that names the item with a number replaces the earlier one, and if it is unclear the item is asked.

A refused call goes back to Spark with the reason, so it can fix it or flag the item. Any item still without a price is asked about with a question code writes ("How much is Rice?"). The model's own wording never reaches the trader.

The loop stops when every item is decided, when Spark answers in plain text, after 4 turns, or when the same call is made 3 times. History is replayed statelessly (`store: false`, encrypted reasoning).

## Build log

See [docs/build-log.md](docs/build-log.md).

## Licence

MIT. See [LICENSE](LICENSE).
