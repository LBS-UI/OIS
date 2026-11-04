# NextGen Smart Classroom — Online Registration & Records System

Cloudflare Worker (or Pages) + D1 system for student, employee/client, and visitor registration, assessment scoring, QR identification, and staff records management.

## Architecture

**Recommended (works with Deploy command `npx wrangler deploy`):**

| Layer | Technology |
|-------|------------|
| Frontend | Static files in `public/` |
| API | Cloudflare Worker (`worker/src/index.js`) |
| Database | Cloudflare D1 (`DB` binding) |
| Auth | Signed HttpOnly session cookie + env secrets |

The root `wrangler.toml` binds `public/` as static assets and routes `/api/*` to the Worker.

**Alternative — pure Cloudflare Pages:**

- Build command: *(empty)*
- Build output directory: `public`
- Pages Functions in `functions/api/[[path]].js` forward API calls to the same handler
- Do **not** set Deploy command to `npx wrangler deploy`

## Features

- Three registration categories: Student, Employee/Client, Visitor
- Student fields: PC Number, Full Name, Grade, Section, School, Pre-test, Post-test
- Employee/Client fields: Full Name, Office/Department, Position, Pre-test, Post-test
- Visitor fields: Full Name, Office, Position (scores optional)
- Unique participant ID + opaque QR token (no personal data in the QR)
- Duplicate PC Number prevention per category
- Staff login with secure session cookies
- Searchable / filterable records dashboard
- Edit & delete (with confirmation)
- QR generation, print/download, camera scan + manual token lookup
- Scan event logging
- CSV, Excel (.xlsx), and PDF exports
- Responsive UI (desktop / tablet / mobile)
- Parameterized SQL, server-side validation, HttpOnly Secure cookies

## Quick start — Cloudflare Worker + assets

1. **Create the D1 database**

```bash
npx wrangler d1 create nextgen-smart-classroom
```

Copy the returned `database_id` into `wrangler.toml` (replace `REPLACE_WITH_YOUR_D1_DATABASE_ID`).

2. **Apply the schema**

```bash
npx wrangler d1 execute nextgen-smart-classroom --remote --file=worker/schema.sql
```

3. **Set secrets**

```bash
npx wrangler secret put ADMIN_USERNAME
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put SESSION_SECRET
```

Generate a strong session secret:

```bash
openssl rand -base64 48
```

4. **Deploy**

```bash
npx wrangler deploy
```

5. Open the Worker URL, sign in with the admin credentials you set, and register participants.

## Cloudflare Pages setup (alternative)

1. Connect the GitHub repository.
2. Framework preset: **None**
3. Build command: leave empty
4. Build output directory: **public**
5. Create/bind D1 database named `nextgen-smart-classroom` with binding variable **DB**
6. Set Production secrets: `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `SESSION_SECRET`
7. Apply schema (dashboard SQL editor or `wrangler d1 execute … --remote`)
8. Deploy (push to main or manual deploy) — **do not** use `npx wrangler deploy` as the Pages deploy command

## Local development

```bash
cp .dev.vars.example .dev.vars
# edit .dev.vars with test credentials

npx wrangler d1 execute nextgen-smart-classroom --local --file=worker/schema.sql
npx wrangler dev
# or for Pages-style:
# npx wrangler pages dev public --d1=DB=nextgen-smart-classroom
```

## Initial administrator account

There is **no** default public admin password.

- The primary administrator is defined only by the environment secrets `ADMIN_USERNAME` + `ADMIN_PASSWORD`.
- After the primary admin signs in, they can create additional staff accounts via `POST /api/users` (UI for this can be added later; currently API-only).
- Never commit real credentials. Use long, unique passwords.

## Security notes

- Passwords for DB users are hashed with PBKDF2-SHA-256 (100k iterations).
- Session tokens are HMAC-signed and stored in HttpOnly / Secure / SameSite=Strict cookies.
- All protected routes verify the session on the server.
- QR codes contain only a long random token.
- CSV export prefixes formula-like values to reduce spreadsheet injection risk.
- Parameterized queries are used throughout.

## Testing checklist

| # | Test | Expected |
|---|------|----------|
| 1 | `GET /api/health` | `{ ok: true }` |
| 2 | Login with wrong password | 401 |
| 3 | Login with correct secrets | Session cookie set, app loads |
| 4 | Student registration (PC # required) | Record + QR appear |
| 5 | Employee & Visitor registration | Saved without forced scores |
| 6 | Duplicate student PC Number | 409 rejected |
| 7 | Refresh page | Records still present |
| 8 | Edit / delete | Changes persist |
| 9 | QR lookup by token | Correct participant |
| 10 | Camera scan (HTTPS + permission) | Lookup succeeds |
| 11 | CSV / XLSX / PDF export | Valid files with current data |
| 12 | Logout | Session cleared |

## Remaining limitations

- Single primary admin via env secrets; additional staff via API only (no full account-management UI).
- No built-in rate limiting (add Cloudflare Rate Limiting rules for `/api/login` in production).
- Exports run client-side after records are loaded (requires login).
- Camera scanner needs HTTPS and user permission.
- Pagination is client-side; for very large datasets consider server-side paging later.

## Project structure

```
nextgen-online/
├── public/                 # Static frontend
│   ├── index.html
│   ├── app.js
│   ├── styles.css
│   ├── qrcode.min.js
│   └── nextgen.jpg
├── worker/
│   ├── src/index.js        # API + asset serving
│   ├── schema.sql
│   └── wrangler.toml       # optional standalone
├── functions/
│   └── api/[[path]].js     # Pages Functions shim
├── wrangler.toml           # primary Worker + assets config
├── .dev.vars.example
└── README.md
```

## License / usage

Intended for school registration and attendance workflows. Handle participant data according to your institution’s privacy policies.
