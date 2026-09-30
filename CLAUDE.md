# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A personal LINE reminder tool for one user (kai). kai creates reminders by voice (Gemini Live) or by typing in a small web app / PWA; a Cloudflare Worker sends them via the LINE Messaging API at the scheduled time, to kai or to family/friends who have added the LINE Official Account. Not a product; single user, single password. The plan document is linked from `README.md`.

kai has no programming background. Code comments, commit messages, and all user-facing strings are in Traditional Chinese (Taiwan), written in plain language. Keep that convention.

## Commands

```bash
npm run dev       # wrangler dev (local Worker + local D1; needs .dev.vars, copy from .dev.vars.example)
npm run deploy    # wrangler deploy
npm test          # node --test (runs test/*.test.js)
node --test test/voice.test.js                      # one test file
node --test --test-name-pattern='日曆' test/        # tests whose name matches
```

No build step, bundler, linter, or runtime dependencies: plain ES modules, `wrangler` is the only devDependency. Tests only cover pure functions (no D1/fetch mocks), so keep testable logic like date math free of `env`.

Secrets (set with `wrangler secret put`, or in `.dev.vars` locally): `APP_PASSWORD`, `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_CHANNEL_SECRET`, `GEMINI_API_KEY`. Features degrade gracefully when a secret is missing (`/api/me` reports `lineReady` / `voiceReady`). Plain var `KEEP_SENT_MINUTES` in `wrangler.jsonc` controls how long finished reminders are kept.

## Architecture

One Cloudflare Worker (`src/index.js`) with two entry points:

- `fetch`: `/api/*` is handled by the Worker (`run_worker_first`); everything else is served from `public/` as static assets. Routing is a hand-written if/regex chain in `handleApi`. Throwing `UserError` (from `reminders.js`) returns a 400 with its message shown to kai; any other error becomes a generic 500.
- `scheduled`: cron every minute runs `runSchedule` (send due reminders, delete old ones).

**Database**: D1 bound as `DB`. There are no migration files: `src/db.js` runs `CREATE TABLE IF NOT EXISTS` on first request per isolate (`ensureSchema`). Schema changes must be additive and idempotent in that same list (e.g. an `ALTER` guarded appropriately), since existing production data is never recreated. Times are stored as epoch milliseconds.

**Auth** (`src/auth.js`): single shared password. Session cookie is `expires.HMAC(expires)` keyed on the password itself, so changing `APP_PASSWORD` invalidates all sessions. Login failures are rate-limited per IP in `login_attempts`. The LINE webhook is the only unauthenticated API and is verified by LINE's HMAC signature instead.

**Contacts**: there is no manual "add contact". Contacts are created only when someone follows the LINE bot, adds it to a group, or messages it (`handleLineEvents`). kai then gives them a nickname in the app and marks one as `is_self`. A reminder targets a contact's `line_id` (user, group, or room).

**Sending reliability** (`runSchedule`): reminder status flows `pending → sending → sent | failed`, or `pending → cancelled`. Each row is claimed with a conditional `UPDATE ... WHERE status='pending'` to avoid double sends; rows stuck in `sending` over 5 minutes are reset. Pushes carry a deterministic `X-Line-Retry-Key` derived from the reminder id, so a resend is deduplicated by LINE (HTTP 409 is treated as sent). 5xx/network errors retry each minute for up to 30 minutes; other errors become `failed` with a friendly Chinese message. `sent_at` doubles as the "finished at" timestamp for cleanup, including for cancelled/failed rows.

**Voice flow** (the part that spans the most files):
1. Browser (`public/voice.js`) calls `POST /api/voice/session`.
2. `src/voice.js` asks Google for a one-time ephemeral token (tries `v1beta`, then `v1alpha`) with the **entire** Live setup locked into it: model, system prompt, and the `create_reminder` tool. The real `GEMINI_API_KEY` never reaches the browser. The setup sent by the browser is ignored when the token carries one, so anything the model needs must be in `bidiGenerateContentSetup` on the server.
3. The system prompt embeds a 21-day Taipei-time calendar (`calendarText`) with labels like 本週/下週/明天 so the model resolves relative dates correctly, plus the current contact names. Taiwan is fixed UTC+8 (no DST); all date math is done by offsetting, not with `Intl`.
4. Browser opens the WebSocket directly to Gemini, streams 16 kHz PCM from `public/mic-worklet.js`, plays 24 kHz PCM back.
5. When the model calls `create_reminder` (found in either `toolCall` or inline `functionCall` parts), the browser forwards the args to `POST /api/voice/create`, which fuzzy-matches the recipient name (`我`/`自己` → the `is_self` contact), parses `YYYY-MM-DDTHH:mm` as Taipei time, dedupes identical reminders created in the last 10 minutes, and returns `{ok, reason}` that the browser sends back as the tool response so the model can speak the result.

Frontend (`public/`) is vanilla JS modules with no framework; `app.js` drives login, reminder list, typed reminder form, and contacts; all times are displayed in `Asia/Taipei`.
