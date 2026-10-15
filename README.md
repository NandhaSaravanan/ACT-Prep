# Bubble Sheet — self-hosted

The Bubble Sheet ACT practice app, moved off claude.ai so it runs on your own domain with full features:
Claude reads test booklets and answer keys, explains misses, sorts questions by topic and writes new
practice questions, and progress syncs across devices.

```
public/index.html   the app (ported from the artifact; loads /runtime.js first)
public/runtime.js   stand-in for the claude.ai runtime: window.claude.use("sample" | "db" | "user")
api/sample.js       calls the Claude API with your key (images + JSON parsing + rate limit)
api/db.js           small document store on Upstash Redis (per-user saves, shared question bank, reports)
lib/                shared helpers
scripts/            dev server, tests, and the port script for future artifact updates
```

## Deploy on Vercel (about 10 minutes)

1. **Push this folder to a GitHub repo** (or skip git and run `npx vercel` from this folder).
2. **Import it on vercel.com → Add New → Project.** No build step, no framework; defaults are fine.
3. **Add the Redis store:** in the project, open *Storage → Create → Upstash for Redis* (free tier is plenty).
   This drops `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` into your environment automatically.
   Without it the site still works, but every visitor's progress stays in their own browser.
4. **Set environment variables** (*Settings → Environment Variables*):

   | Variable | Required | What it does |
   |---|---|---|
   | `ANTHROPIC_API_KEY` | yes | Your Claude API key from console.anthropic.com. |
   | `OWNER_KEY` | recommended | A long random string. Visit `https://your-site/?owner=<OWNER_KEY>` once and your browser is in owner mode: generated questions go into the shared bank, and "this explanation seems off" reports are saved for you. |
   | `ACCESS_CODE` | optional | If set, visitors must enter this code once before the site will call Claude. Share `https://your-site/?access=<code>` to skip the prompt. Strongly recommended if the URL will be public, since every Claude call bills your key. |
   | `SAMPLE_PER_HOUR` | optional | Per-visitor (per IP) cap on Claude calls per hour. Default 150. |
   | `MODEL_DEFAULT` / `MODEL_COMPLEX` | optional | Defaults `claude-sonnet-5-5` (page reading, explanations) and `claude-opus-5-5` (answer keys, writing questions). |

5. **Redeploy** after changing variables (*Deployments → ⋯ → Redeploy*).
6. **Custom domain:** *Settings → Domains*, add yours, point DNS where Vercel tells you.

## How identity works

There is no login. Each browser makes itself a random **sync code** on first visit, and saves live under it.
*Settings → Use this on another device* gives a link (`/?sync=<code>`) that adopts the same code on another
phone or computer. Anyone with that link sees that progress, so treat it like a password.

## What it costs

Setting up a test reads every booklet page and the answer key through Claude (the big one-time cost per
test, typically tens of cents), and each explanation or batch of generated questions is one more call.
Keep `ACCESS_CODE` and `SAMPLE_PER_HOUR` on if the site is reachable by people you don't know.

## Run locally

```
cp .env.example .env     # fill in ANTHROPIC_API_KEY (and Upstash vars if you want cloud saves)
npm run dev              # http://localhost:3000
npm test                 # API tests against a fake Claude + fake Redis, no key needed
python3 -I scripts/browser-test.py   # optional headless-browser boot test (needs playwright)
```

## Updating the app from a newer artifact

If you keep editing the original on claude.ai, export its `index.html` again and run:

```
python3 -I scripts/port.py path/to/exported/index.html
```

It rebuilds `public/index.html` (head, shim, sync panel, wording) and refuses to continue if the
artifact changed in a way the script does not recognise.

## Notes

- Test PDFs are rendered in the browser and page images go to the Claude API only while a test is being
  set up or explained; nothing from the PDF is stored on the server.
- The Redis store holds: `data/users/<sync code>/*` (profile, scores, mistakes, quizzes), `qbank/*`
  (shared questions, owner-written), `reports/*` (owner-only).
- `api/sample.js` has a 120 s limit set in `vercel.json`, enough for a batch of five booklet pages.
