# NextGen Smart Classroom — Online Upgrade Starter

A redesigned, responsive version of the uploaded offline registration / QR project, prepared for Cloudflare Pages Functions + D1.

## Included

- Responsive dashboard and registration forms for Student, Employee / Client, and Visitor
- Student PC Number, full name, grade, section, school, assessment scores, and feedback
- Employee/client office and position fields, plus optional assessment scores
- Visitor office and position fields
- Staff login using Cloudflare Pages secrets
- D1-backed record creation, listing, editing, QR-token lookup, and scan-event logging
- CSV export built in; Excel (.xlsx) and PDF exports use CDN-hosted libraries
- QR codes contain a random token only, not a participant's personal details
- SQL schema and Cloudflare configuration included

## Important limitations before real deployment

This is a deployable starter, not a live deployed service. It has not been connected to your Cloudflare account or tested against a provisioned D1 database. Do not upload real participant data until you have configured secrets, reviewed access policies with the classroom owner, and tested backups/recovery.

The starter uses one administrator account supplied as Cloudflare secrets. It does not yet include multi-user staff management, password reset, rate limiting, CSV import, or an in-browser camera scanner. QR lookup accepts the scanned token or pasted QR content. A camera scanner can be added after confirming the target device/browser.

## Deploy with Cloudflare Pages + D1

### 1. Create the D1 database

From the project root, install/use Wrangler and run:

```bash
npx wrangler d1 create nextgen-smart-classroom
```

Copy the returned database ID into the root `wrangler.toml`, replacing `REPLACE_WITH_YOUR_D1_DATABASE_ID`.

Apply the schema:

```bash
npx wrangler d1 execute nextgen-smart-classroom --remote --file=worker/schema.sql
```

### 2. Create a Pages project

Push this folder to a private GitHub repository (recommended while it is under development), then create a Cloudflare Pages project connected to that repository.

- Build command: leave empty
- Build output directory: `public`
- Keep `functions/`, `worker/`, and `wrangler.toml` at the repository root

The `functions/api/[[path]].js` file routes `/api/*` requests to the included API handler.

### 3. Bind D1 to Pages

In Cloudflare Dashboard → Workers & Pages → your Pages project → Settings → Functions → D1 database bindings, add:

- Variable name: `DB`
- D1 database: `nextgen-smart-classroom`

The root Wrangler configuration also declares this binding for Wrangler-based workflows.

### 4. Add required secrets

In the Pages project settings, add these as **encrypted secrets/environment variables** for both Production and Preview only as appropriate:

- `ADMIN_USERNAME`: a non-obvious staff username
- `ADMIN_PASSWORD`: a long, unique password (never put it in HTML/JavaScript or Git)
- `SESSION_SECRET`: a cryptographically random secret of at least 32 characters

Generate a secret locally, for example:

```bash
openssl rand -base64 48
```

Do not use the example command output as a fixed shared password. Set secrets through Cloudflare's dashboard or Wrangler Pages secret commands, not in source files.

### 5. Deploy and test

Deploy the Pages project. Then verify:

1. `/api/health` returns service status.
2. Login rejects incorrect credentials and accepts the configured staff account.
3. Student records require PC Number and full name.
4. Employee/client and visitor forms work with their own fields.
5. Duplicate student PC Numbers are rejected within the same category.
6. Records persist after refreshing and opening another authorized device.
7. QR token lookup requires staff authentication.
8. CSV, Excel, and PDF exports contain the expected columns.
9. The D1 database can be backed up and restored.

Add Cloudflare rate limiting or another suitable protection for `/api/login` before production use. Limit staff access to the people authorized by the classroom owner, and define a retention/deletion process for participant data.

## Local development

With Wrangler installed and the D1 binding configured, try:

```bash
npx wrangler pages dev public
```

Depending on your local setup, you may need to use the Pages project root and explicitly configure the local D1 database binding. Do not use real student data in local test fixtures.

## Data model

`worker/schema.sql` defines:

- `records`: participant and assessment information, QR token, created/updated timestamps, and staff identity
- `scan_events`: audit entries for staff QR lookups

The original upload's student form used Grade and School. The redesign retains those fields and adds Section as a separate field based on the requested online workflow.
