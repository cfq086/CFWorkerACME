# AGENTS.md

CertHub (CFWorkerACME): a self-hosted ACME SSL certificate issuance platform (Hono backend + React frontend). Same backend runs on **three targets** — Cloudflare Workers, Tencent EdgeOne Pages, and plain Node/Docker.

## Architecture / entrypoints

- `src/cfapp.ts` — **Cloudflare Worker entry** (`wrangler.jsonc` `main`). Registers probe-guard + SPA fallback middleware around the Hono app, then `index.app.fire()` and a `scheduled()` handler for cron tasks. Route registration itself lives in `src/index.ts` (`mount*Routes` + legacy inline routes).
- `src/basic.ts` — **Node self-hosted entry** (webpack bundles to `dist/bundle.js` via `build-js`; served on port 3000).
- EdgeOne Pages: uses `edgeone.json` rewrites + `edgeone` CLI (`npm run dev-eo/build-eo/deploy-eo`). EdgeOne has **no D1** — set `DB_SOURCE=mysql|prisma`.
- Backend bindings are typed in `Bindings` (`src/index.ts`). Frontend builds to `../public` (gitignored); static files are served by the **Workers Assets binding (`ASSETS`)**, not Worker code.

## Build / dev / deploy commands

- `npm install` then `npm --prefix frontend install` (frontend is a nested Vite project; also has pnpm lockfiles but npm is the documented path).
- `npm run dev-cf` / `dev-cf:test` — local wrangler dev (`:test` variant loads gitignored `wrangler.encrypt.jsonc` with real keys).
- `npm run deploy-cf` / `deploy-cf:test` — builds frontend + deploys Worker. `:test` uses `wrangler.encrypt.jsonc`.
- `npm run web-dev` — frontend dev server on :5173, proxies API paths to `http://127.0.0.1:8787` (wrangler dev default). See `frontend/vite.config.ts` `API_PATHS` — add new backend route prefixes there.
- `npm run dev-js` (tsx watch) / `build-js` + `deploy-js` (Node/Docker).
- No test framework is configured — don't assume `npm test` exists.

## Critical gotchas

- **`acme-client` is patched** (`patches/acme-client+5.4.0.patch`) to swap axios → xior so it runs on Workers. `postinstall` and `patch:acme` apply it. **Edit `patches/`, never `node_modules/`**; after any `npm install` the patch must be re-applied (the dev/deploy scripts already call `patch:acme`).
- **Cron**: `wrangler.jsonc` `triggers.crons` must stay exactly in sync with `CRON_PUSH` / `CRON_DAILY` constants in `src/cfapp.ts` (compared after trim + whitespace-collapse; cron runs in **UTC**). Changing one side without the other silently disables the job.
- **`wrangler.jsonc` uses `assets` (Workers Static Assets) with `not_found_handling: "none"`** so unhandled paths reach the Worker SPA fallback. Do not reintroduce the old `site` block (`assets` + `site` can't coexist) and do not switch to `"single-page-application"` — it bypasses probe-guard (`src/utils/probe-guard.ts`) which must keep returning 404 for `/.env`-style scanner probes before the SPA fallback. `.well-known` must stay allowed.
- **Let's Encrypt on Cloudflare Workers hits SSL 525** — LE uses a proxy directory (see README §备注说明); GTS/ZeroSSL/SSL.com need EAB creds (`*_keyMC/keyID/KeyTS`). Let's Encrypt + buypass reuse `Users.keys`; EAB CAs use their own env confs.

## Database

- Three backends behind `DB_SOURCE` (`d1` default / `mysql` / `prisma`), selected in `src/db/index.ts` (`getDao`/`ensureDao`).
- **New code must go through `ensureDao(env)`** (DAO interface in `src/db/dao.ts`) — never call `env.DB_CF.prepare()` directly. `ensureDao` also runs idempotent migrations (`src/db/migrations/`).
- Legacy paths (`index.ts`, `users.ts`, `certs.ts`) still use `saves.selectDB/insertDB/updateDB/deleteDB(env.DB_CF, ...)` wrappers (thin D1Dao shims in `src/saves.ts`). Signatures differ: `selectDB` takes the old `{col: {value, op}}` where form; **`deleteDB` takes a plain `{col: value}` kv** (passing the SelectWhere form throws `D1_TYPE_ERROR`). `selectDB` supports `opts.cols` to avoid loading heavy `keys`/`cert`/`data` blobs in hot loops.
- Config is read via `readConf/readBool/readInt` (`src/db/conf.ts`): precedence **Confs (DB) → env → defaults**, with a 60s in-memory cache — call `invalidateConf(name)` after writes. `DEFAULT_CONF_MAP` lives in `src/db/migrations/001_admin_console.ts`.

## Domain / order state machine (`Apply.flag`)

`0` new (create ACME order) → `1` auto DNS proxy → `2` **waiting user DNS config** (terminal in the auto-push loop) → `3` verify → `4` fetch cert → `5` issued; `-1` failed/revoked. Auto-push cron stops at `2/5/<0`; `renewCerts` resets `5 → 0`; only `flag=5` orders can toggle auto-renew. Manual push via `/order/?op=process`. Order-level CAS lock prevents concurrent processing (`processOne` returns `locked`).

`Users.flag`: `0` = registered placeholder (verification code sent, not completed), `1` = fully registered. Passwords are encrypted (CryptoJS AES + HMAC scheme in `src/users.ts`), auth via signed cookie.

## Conventions

- Code comments, logs, and commit messages are in **Chinese** — keep new code consistent.
- Frontend uses React + antd with a Cyber-Kawaii terminal theme, **HashRouter** (routes like `/#/admin/...` so they never collide with real backend `/admin` paths). Path aliases `@/`, `@components/`, `@pages/`, `@api/` etc. are defined in `frontend/vite.config.ts`.
- Docker injects env with an `OPLIST_` prefix, stripped and sed-rewritten into `wrangler.jsonc` by `entrypoint.sh`.
