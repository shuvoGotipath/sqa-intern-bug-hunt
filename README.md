# SQA Intern Bug Hunt

A hiring challenge for SQA interns. Candidates test **ShopNest**, a small demo store with 22 planted defects, and write bug reports. Submitting the reports unlocks the job application form. The hiring team reviews scores, reports and CVs in a protected admin dashboard.

> **Confidential:** the expected bug list lives in `server/evaluation/answerKey.js`. The server never serves it to the browser. Do not share this repository with candidates.

## Candidate flow

1. Welcome page → rules → **Start challenge** (creates a server-side session in an HttpOnly cookie).
2. Workspace: the ShopNest demo runs in an iframe with Desktop / Tablet / Mobile width toggles. The workspace also has an elapsed-time tracker, a report counter, hints (each one lowers the score), and a report form with optional screenshot upload. Candidates can edit or delete reports.
3. Review screen: shows every report and warns about likely duplicates or one-line steps → **Submit challenge**.
4. The server evaluates and stores the results. The candidate never sees the score. The application form then unlocks.
5. Application form (name, email, phone, institution, education level, experience, CV, LinkedIn/portfolio, "Why SQA?") → **Submit application** → confirmation with a reference number.

Progress is stored on the server. A refresh, or reopening the browser within 14 days, resumes at the same step. Report and application drafts are also kept in localStorage.

## Requirements

- Node.js **20 or newer** (tested on Node 24)
- A **MongoDB** database (MongoDB Atlas free tier works) for candidate data and results
- An **S3-compatible bucket** (AWS S3, Cloudflare R2, MinIO, …) for CVs and screenshots. Without S3 settings, files are saved in `uploads/`, which is allowed in development only.

## Configuration

Copy `.env.example` to `.env` and fill in the values. `.env` is ignored by git, so keep all secrets there and never in `.env.example`.

| Variable | Purpose |
| --- | --- |
| `MONGODB_URI`, `MONGODB_DB` | MongoDB connection string and database name (default `sqa_hiring`) |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Private bucket for uploads. Files are never public: the app streams them to the candidate who uploaded them or to signed-in admins |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | Admin dashboard login |
| `NODE_ENV`, `SECURE_COOKIES`, `TRUST_PROXY` | Production/HTTPS settings |

On startup the server connects to MongoDB, creates its indexes and checks the bucket. If either service is unreachable it exits with a clear error.

## Run locally

```bash
npm install
npm start
```

- Candidate page: http://localhost:3000
- Admin dashboard: http://localhost:3000/admin

If `ADMIN_PASSWORD` is not set, development mode uses the password `change-me-local-only` with username `admin` and prints a warning. Production mode refuses to start without a password of at least 12 characters.

`npm run dev` restarts the server automatically when files change.

## Tests

```bash
npm test
```

There are 85 tests (Node's built-in test runner). They run against a throwaway in-memory MongoDB (`mongodb-memory-server`) and a temporary folder, so they never touch your real database or bucket. The first run downloads a MongoDB binary. They cover:

- **Completion gate** (`tests/gate.test.js`): an application is refused with no session, while the challenge is in progress, with a forged cookie, or with client-supplied "completed" flags. The challenge needs reports and explicit confirmation. Submitting locks the reports and does not leak the score. A full start → report → submit → apply journey is tested, and duplicate applications are refused. Field validation, CV type/size checks, CSRF header and answer-key protection are also tested.
- **Scoring** (`tests/scoring.test.js`): one realistic report per planted bug must match the right bug. Also tested: false positives, duplicates, vague reports, severity/priority accuracy, hint penalties and admin overrides.
- **Admin** (`tests/admin.test.js`): authentication, rate limiting, filters, candidate detail, CV/evidence download, status changes, verdict overrides, CSV export (including formula-injection guarding) and logout.
- **Demo app** (`tests/demo.test.js`): every planted defect stays reproducible, and behaviour that is meant to be correct stays correct, so candidates aren't penalised for unintended bugs.

## Deployment

The app is a single stateless Node process. Data lives in MongoDB and files in S3, so it runs on any VPS or PaaS (Render, Railway, Fly.io, a plain VM) without a persistent disk.

1. Set the variables from `.env.example` in your host's environment settings, with a long `ADMIN_PASSWORD`.
2. Set `NODE_ENV=production`, `SECURE_COOKIES=true`, and `TRUST_PROXY=true` behind a reverse proxy or HTTPS terminator. Production mode refuses to start without S3 settings.
3. In MongoDB Atlas, allow the server's IP address under *Network Access*.
4. `npm ci --omit=dev && npm start` (or run it with systemd or pm2).
5. Serve it over **HTTPS only**. Example nginx location:

```nginx
location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  client_max_body_size 6m;
}
```

**Backups:** use Atlas backups (or `mongodump --uri "$MONGODB_URI" --db sqa_hiring`) and your bucket's versioning or replication.

**Starting fresh:** drop the `sqa_hiring` database (or use a new `MONGODB_DB` name) and empty the `cv/` and `evidence/` folders in the bucket.

**Data model:** collections `sessions`, `reports`, `applications`, `adminSessions` (auto-expiring) and `demoState`. Bucket keys are `cv/<reference>/<random>.pdf` and `evidence/<reference>/<random>.png`.

## Security

| Concern | Measure |
| --- | --- |
| Answer key exposure | Stored server-side only (`server/evaluation/`); only `public/` is served statically; admin-only API |
| Faking completion | Status lives in the database. The application endpoint checks it on the server and ignores client flags, and unique indexes allow only one application per session and per email. Session tokens are 256-bit random and stored as SHA-256 hashes |
| Report tampering | Reports are validated on the server, scoped to the session, and locked after submission |
| CSRF | SameSite cookies and a required `X-Requested-With` header on every state-changing API call |
| Admin access | Credentials from env with a constant-time comparison. Login is rate limited (10 attempts / 15 min). Sessions are HttpOnly + SameSite=Strict, expire after 8 hours and are revocable |
| Uploads | Type is checked by file signature, not file name. Limits: CV PDF/DOC/DOCX up to 5 MB, evidence PNG/JPG/GIF/WebP up to 3 MB. Files get random names in a private bucket and are served only through authorised routes |
| XSS | All user content is HTML-escaped. Strict CSP (`script-src 'self'`) plus `nosniff` and frame restrictions |
| CSV export | Spreadsheet formula injection is neutralised |

Note: the demo store's client-side code is necessarily visible in the browser. It has no comments or labels that reveal bugs, and roughly half the defects live in the server-side demo API, where candidates cannot see the code.

## Scoring (admin-only)

The **Answer key & scoring** tab in the dashboard shows these rules.

- Base points by difficulty: easy 6, medium 9, hard 12. An edge-case bug earns a +2 bonus. The maximum is 219 points, which is 100%.
- Each matched bug splits its points: identification 30%, reproducibility of steps 25%, expected-vs-actual quality 25%, severity accuracy 10%, priority accuracy 10%. A wrong module reduces identification credit. A severity or priority one level off earns half.
- **Duplicates earn 0.** Only the best report for each bug counts.
- Reports that match nothing count as false positives (−2 each, capped at −10). They are flagged for manual review.
- Each hint costs −3. Time is shown for context but never scored.
- Automatic matching uses keyword groups per bug. On the candidate page, a reviewer can override any report's verdict: auto, invalid, match to a specific bug, or "valid but not in the key" for bonus credit. The score is recalculated immediately.

### Changing the challenge

- Bugs and matching rules: `server/evaluation/answerKey.js`. The demo implementation is in `server/routes/demo.js` (API) and `public/demo/` (UI).
- After any change, run `npm test`. `tests/demo.test.js` and `tests/scoring.test.js` catch planted bugs that were accidentally fixed and reports that no longer match.
- Hints: `server/evaluation/hints.js`.

## Project structure

```
server/
  index.js            entry point (.env loading, prod safety checks)
  app.js              Express app factory
  db.js               MongoDB connection and indexes
  storage.js          S3 / local-disk file storage
  security.js         tokens, cookies, CSP headers, CSRF guard, rate limiting
  validation.js       report + application validation
  uploads.js          upload limits and signature checks
  routes/candidate.js session, reports, hints, challenge submit, application
  routes/admin.js     admin auth, candidates, verdicts, CSV, files, answer key
  routes/demo.js      ShopNest demo API (contains planted defects)
  evaluation/         answer key, scoring engine, hints  (never served)
public/
  index.html, js/portal.js, css/   candidate experience
  demo/                            ShopNest demo store (system under test)
  admin/                           admin dashboard
tests/                             node:test suites
```
