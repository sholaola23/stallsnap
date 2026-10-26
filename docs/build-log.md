# Build log

Dated record of what was built in this repo. All times are UK time. Everything here was written after the hackathon kickoff at 16:00 on Mon 26 Oct 2026.

| Date | What |
|---|---|
| Mon 26 Oct | Repo started: README with the "Before the event" note, MIT licence. |
| Mon 26 Oct | PR 1, scaffold: Bun 1.4.4 and TypeScript, CI (typecheck, unit tests, messy-input suite), `.env.example` with names only, env reader that treats placeholder secrets as missing. |
| Mon 26 Oct | PR 2, spend cap: `SpendGuard.paid()` with a $2 daily cap, 60 calls per job and the `STALLSNAP_PAID_CALLS=off` switch. Worst-case cost is held before each call; spend survives restarts; a damaged ledger stops paid calls. Mutation-checked: breaking any limit fails a test. |
| Mon 26 Oct | PR 3, WhatsApp webhook: verify handshake, `X-Hub-Signature-256` check on the raw body, `ALLOWED_NUMBERS` allow-list, dedupe on message id, crash-safe job log (lost messages handled after restart, interrupted paid steps never rerun). Checked against the running server with curl. Live phone test PENDING. |
| Mon 26 Oct | PR 4a, Meta client and voice: one client for the Meta Model API with costs from Meta's price page, development cache, OGG/Opus to WAV with ffmpeg, Muse Voice Transcribe with English bias and price keywords. Tested on fakes; live call PENDING until `MODEL_API_KEY` is set. |
| Mon 26 Oct | PR 4b, cut-outs: SAM 3.1 with Meta's parser, Spark proposals with two phrasings per product, person masks dropped, greedy dedupe, Spark crop review, box prompts for missed products, transparent PNGs from the trader's own pixels. Messy suite caught a crash on `null` items in model output; fixed at the API boundary and in each reader. Live run PENDING until `MODEL_API_KEY` is set. |
| Mon 26 Oct | PR 4c, pricing: Spark tool loop with `set_price` and `flag_missing_price`. Each price must quote the trader's own words found in the transcript, match the quote's digits and not be a range; anything else is asked back. Messy suite caught spoken ranges being accepted; fixed. Live run PENDING until `MODEL_API_KEY` is set. |
| Mon 26 Oct | PR 5a, WhatsApp sending: Graph API v26.0 client for text, one reply button, link button, typing indicator and media download, checked against Meta's `.md` references. Confirmed from Meta's audio webhook reference that voice notes arrive as `audio` with `voice: true`. |
