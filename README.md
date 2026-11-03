# NextGen Smart Classroom — Online Registration & Records System

A complete Cloudflare Pages + Functions + D1 system for student, employee/client, and visitor registration, assessment scoring, QR identification, and records management.

## Architecture (Worker + static assets)

Because the Cloudflare dashboard requires a Deploy command, the project is configured as a **Cloudflare Worker with static assets**:

- **Entry point**: `worker/src/index.js` (handles `/api/*` and serves everything else from assets)
- **Static files**: `public/` directory bound as the `ASSETS` binding
- **Database**: Cloudflare D1 (binding name: `DB`)
- **Auth**: Single admin account via environment secrets + signed HttpOnly cookie session
- Deploy command that works: `npx wrangler deploy`

## Why the original build failed

The Cloudflare project was configured with **Deploy command: `npx wrangler deploy`**.  
That command expects a **Workers** project with a `main` entry-point script (or assets configuration).  

This repository is set up as a **Pages** project (`pages_build_output_dir = "./public"` in the root `wrangler.toml`). There is no root Worker entry point, so Wrangler reported:

> Missing entry-point to Worker script or to assets directory.

**Correct approach**: Treat it as a Cloudflare **Pages** project. Leave the Build command empty and set the Build output directory to `public`. Do **not** use `npx wrangler deploy` as the deploy command for the Pages Git integration.

## Exact Cloudflare Pages settings

- Framework preset: **None**
- Build command: *(leave empty)*
- Build output directory: **public**
- Root directory: **/** (repository root)

After connecting the GitHub repository, Pages will automatically deploy the contents of `public/` and pick up the `functions/` directory.

## Database

Database ID (already filled in the `wrangler.toml` files):  
`a7b82648-3af2-4a67-8125-c7edadedada8`

### Apply the schema (run once)

```bash
npx wrangler d1 execute nextgen-smart-classroom --remote --file=worker/schema.sql
```

(Or use the Cloudflare dashboard SQL editor and paste the contents of `worker/schema.sql`.)

## Required secrets / environment variables

In the Cloudflare Pages project → Settings → Environment variables (or Secrets):

| Name              | Purpose                                      |
|-------------------|----------------------------------------------|
| `ADMIN_USERNAME`  | Staff login username                         |
| `ADMIN_PASSWORD`  | Staff login password (long & unique)         |
| `SESSION_SECRET`  | Random string ≥ 32 characters for signing sessions |

Generate a strong session secret:

```bash
openssl rand -base64 48
```

Set these for Production (and Preview if desired). Never commit them to the repository.

## D1 Binding

In the Pages project → Settings → Functions → D1 database bindings:

- Variable name: **DB**
- D1 database: **nextgen-smart-classroom** (the one matching the ID above)

## Features

- Three registration categories (Student, Employee/Client, Visitor)
- Required field validation (frontend + backend)
- Duplicate PC Number prevention per category
- Searchable / filterable records table
- Edit existing records
- Delete records (with confirmation)
- QR codes containing only a random token (no personal data)
- QR lookup by pasting token or using camera scanner
- Scan event logging
- CSV, Excel (.xlsx), and PDF exports
- Responsive design
- Secure session cookies (HttpOnly, Secure, SameSite=Strict)
- Parameterized SQL queries

## Local development

```bash
npx wrangler pages dev public --d1=DB=nextgen-smart-classroom
```

You will still need to supply the secrets locally (or use `.dev.vars`).

## Testing checklist

1. `/api/health` returns `{ ok: true }`
2. Login with wrong credentials fails; correct credentials succeed and set cookie
3. Create a Student record (PC Number required) → appears in records and has QR
4. Create Employee and Visitor records
5. Try duplicate PC Number in same category → rejected
6. Edit a record → changes persist
7. Delete a record → removed from list
8. QR lookup by token works (authenticated)
9. Camera scan works on a device with camera permission
10. CSV / Excel / PDF exports contain the current records
11. Logout clears the session

## Remaining manual steps

1. Confirm the D1 database `nextgen-smart-classroom` exists and the ID matches.
2. Run the schema SQL (command above).
3. Set the three secrets in the Pages project.
4. Confirm the `DB` binding is attached.
5. Push this code to the `main` branch of the GitHub repository.
6. In Cloudflare, ensure the Pages project uses the settings listed above (no `wrangler deploy` command).
7. Deploy and test with a non-production admin password first.

## Known limitations

- Single administrator account (no multi-user staff management or password reset).
- No built-in rate limiting (add Cloudflare Rate Limiting rules for `/api/login` in production).
- Exports are generated client-side from the currently loaded records.
- Camera scanning depends on browser support and HTTPS.
- Scan events are logged but do not automatically mark attendance unless you extend the workflow.

Do not store real student data until backups, access control, and retention policies are reviewed.


## Multiple staff accounts

The primary admin (the one set in `ADMIN_USERNAME` / `ADMIN_PASSWORD`) can create additional staff accounts.

After logging in as the primary admin, send a POST request to `/api/users` with:

```json
{"username":"teacher1","password":"a-strong-password-here"}
```

Or use the browser console while logged in:

```javascript
fetch("/api/users", {
  method: "POST",
  headers: {"Content-Type":"application/json"},
  credentials: "same-origin",
  body: JSON.stringify({username:"teacher1", password:"StrongPass123!"})
}).then(r => r.json()).then(console.log)
```

The new account can then log in normally. Passwords are stored hashed in the `users` table.

You still need to apply the updated schema so the `users` table exists:

```bash
npx wrangler d1 execute nextgen-smart-classroom --remote --file=worker/schema.sql
```

