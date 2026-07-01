# TCC Cloning Guide — Deploy for a New User

This guide walks through deploying a full TCC (Tony's Command Center) instance for a new user (e.g., Ethan, Ramy). Each user gets their own Supabase database (personal data) and Vercel projects, while sharing Tony's business/contacts database.

**Architecture:** Dual-database. Every instance connects to two Postgres databases:
- **Shared DB** (`SHARED_DATABASE_URL`) — Tony's Supabase. Business context, contacts, communication logs, demos, meeting history. Same for all users.
- **Personal DB** (`PERSONAL_DATABASE_URL`) — User's own Supabase. Journals, check-ins, ideas, scratch notes, chat threads, agent training, AI usage. Isolated per user.

---

## Prerequisites

- Node.js 18+ and pnpm installed
- Access to the `Tonys-Command-Center` repo (same branch: `dev-vercel`)
- A Vercel account (or access to the team's Vercel org)
- A Google Cloud project with OAuth configured (see Step 2)
- Tony's `SHARED_DATABASE_URL` connection string

---

## Step 1: Create a Supabase Project (Personal DB)

1. Go to [https://supabase.com/dashboard](https://supabase.com/dashboard)
2. Click **New Project**
3. Name it something like `ethans-command-center` or `ramys-command-center`
4. Choose a strong database password — save it somewhere secure
5. Select region **US West 1 (N. California)** to match Tony's DB for lowest latency
6. Click **Create new project** and wait for it to provision

### Get the Connection Strings

Once the project is ready:

1. Go to **Settings → Database** in the Supabase dashboard
2. Scroll to **Connection string** section
3. Copy **two** URLs:
   - **Transaction (port 6543)** — used at runtime by the app (this is your `PERSONAL_DATABASE_URL`)
   - **Session/Direct (port 5432)** — used by `drizzle-kit push` during provisioning (the script handles this conversion automatically)
4. Replace `[YOUR-PASSWORD]` in the URL with the database password you chose

Your `PERSONAL_DATABASE_URL` will look like:
```
postgresql://postgres.YOURPROJECTREF:PASSWORD@aws-0-us-west-1.pooler.supabase.com:6543/postgres
```

---

## Step 2: Set Up Google Cloud OAuth (Per-User GCP Project)

**Pattern:** Each user creates and owns **their own** Google Cloud project. No shared credentials — no cross-user dependency, no coordinated key rotation, and each user can publish their own app to Production for **permanent refresh tokens** (no 7-day expiry).

Each user needs three values in their `.env`:

- **`GOOGLE_CLIENT_ID`** — identifies the OAuth application (user's own)
- **`GOOGLE_CLIENT_SECRET`** — authenticates the OAuth application (user's own)
- **`GOOGLE_REFRESH_TOKEN`** — grants access to that user's Google account

### 2a. Create a GCP Project + OAuth Client

The user does this **in their own Google account** (once):

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Top bar → project dropdown → **New Project**
3. Name: `<username>-tcc` (e.g., `ethan-tcc`, `ramy-tcc`) → Create → wait ~30s
4. **APIs & Services → Library** — enable each of these APIs:
   - Gmail API
   - Google Calendar API
   - Google Sheets API
   - Google Docs API
   - Google Drive API
   - People API
5. **APIs & Services → OAuth consent screen**:
   - User Type: **External** (unless the user is on a Google Workspace org — then Internal)
   - App name: `<Name> Command Center` (e.g., `Ethan Command Center`)
   - User support email: the user's email
   - Developer contact: the user's email
   - **Save and continue**
   - Scopes step → **Add or Remove Scopes** → paste these one at a time:
     ```
     https://www.googleapis.com/auth/gmail.send
     https://www.googleapis.com/auth/gmail.readonly
     https://www.googleapis.com/auth/gmail.modify
     https://www.googleapis.com/auth/calendar
     https://www.googleapis.com/auth/spreadsheets
     https://www.googleapis.com/auth/documents
     https://www.googleapis.com/auth/drive
     https://www.googleapis.com/auth/contacts.readonly
     ```
   - Save and continue through remaining steps
6. **PUBLISH TO PRODUCTION** ← required for permanent refresh tokens
   - Back on OAuth consent screen main page
   - **Publishing status** section → click **PUBLISH APP** → confirm
   - Status changes from `Testing` → `In production`
   - The user's app is **unverified**, which is fine — they're the only user of their own app. During the OAuth consent flow they'll see a "Google hasn't verified this app" warning; click **Advanced → Go to app (unsafe)**.
7. **APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID**:
   - Application type: **Web application**
   - Name: `TCC Client`
   - Authorized redirect URIs → **Add URI**: `https://developers.google.com/oauthplayground`
   - Create → copy the **Client ID** and **Client Secret** from the popup

> **Why publish to Production?** Google's rule: OAuth apps in `Testing` status issue refresh tokens that **expire after 7 days**. Apps in `In production` status (verified OR unverified) issue refresh tokens that don't expire from timing alone. For a personal tool used by one person in their own GCP project, "Production unverified" is the correct state — you skip Google's weeks-long verification review because the app has only one user (yourself).

### 2b. Generate a Refresh Token

Each user does this **with their own Google account** using the Client ID/Secret from Step 2a:

1. Open [Google OAuth Playground](https://developers.google.com/oauthplayground/)
2. Click the **gear icon** (Settings) in the top right
3. Check **"Use your own OAuth credentials"**
4. Paste the **Client ID** and **Client Secret** from Step 2a → close the settings panel
5. In the left panel, paste these into the "Input your own scopes" box (comma or space separated):
   ```
   https://www.googleapis.com/auth/gmail.send
   https://www.googleapis.com/auth/gmail.readonly
   https://www.googleapis.com/auth/gmail.modify
   https://www.googleapis.com/auth/calendar
   https://www.googleapis.com/auth/spreadsheets
   https://www.googleapis.com/auth/documents
   https://www.googleapis.com/auth/drive
   https://www.googleapis.com/auth/contacts.readonly
   ```
6. Click **"Authorize APIs"**
7. Sign in with the user's Google account (e.g., `ethan@flipiq.com`)
8. On the "Google hasn't verified this app" screen → **Advanced → Go to <App name> (unsafe)** → Continue → grant all permissions
9. Back on the playground, click **"Exchange authorization code for tokens"**
10. Copy the **Refresh Token** from the response — this is `GOOGLE_REFRESH_TOKEN`

> Because the app is published to Production (Step 2a #6), this refresh token **does not expire from timing**. It only becomes invalid if the user manually revokes access, changes their Google password, or the token is unused for 6+ months.

---

## Step 3: Create a User Profile

Create a markdown file for the new user at:

```
lib/db/seed-data/user-profiles/<username>.md
```

Example for Ethan (`lib/db/seed-data/user-profiles/ethan.md`):

```markdown
# User Profile — Ethan Jolly

**Name:** Ethan Jolly
**Email:** ethan@flipiq.com
**Role:** COO, FlipIQ
**Slack ID:** U0991BD321Y

## About
Ethan is COO at FlipIQ, responsible for operations, team coordination,
and ensuring execution on the company's strategic goals.
```

This file gets injected into the agent memory system as `_shared/USER.md` during provisioning, so the AI knows who it's talking to.

---

## Step 4: Provision the Personal Database

Run the provisioning script from the repo root:

```bash
PERSONAL_DATABASE_URL="postgresql://postgres.YOURPROJECTREF:PASSWORD@aws-0-us-west-1.pooler.supabase.com:6543/postgres" \
  node lib/db/scripts/provision-personal-db.mjs --user=ethan
```

What this does (6 steps):
1. **Same-DB guard** — skips if `SHARED_DATABASE_URL` equals `PERSONAL_DATABASE_URL` (Tony's instance)
2. **Schema push** — runs `drizzle-kit push` to create all ~50 tables in the new DB
3. **Seed agent architecture** — populates agent memory entries from `ai-outputs/ai-architecture/`
4. **Seed agent tools** — registers all agent tools in the tool registry
5. **Override USER.md** — injects the user profile from step 3
6. **Verify** — checks table count, agent data, and user profile

**Dry run first** (no changes, just shows what would happen):
```bash
PERSONAL_DATABASE_URL="..." node lib/db/scripts/provision-personal-db.mjs --user=ethan --dry-run
```

Expected output on success:
```
[PROVISION] Tables created: 52
[PROVISION] Agent memory entries: 45
[PROVISION] Agent skills: 12
[PROVISION] Agent tools: 30
[PROVISION] User profile: Applied (# User Profile — Ethan Jolly...)
[PROVISION] Provisioning complete! DB is ready.
```

---

## Step 5: Create Vercel Projects

Each user needs **two Vercel projects** from the same repo:

### 5a. API Server Project

1. Go to [Vercel Dashboard](https://vercel.com/dashboard) → **Add New → Project**
2. Import the `Tonys-Command-Center` repo
3. Name it: `ethans-command-center-api-server`
4. **Framework Preset:** Other
5. **Root Directory:** `artifacts/api-server`
6. **Build Command:** `pnpm run build`
7. **Output Directory:** (leave default)
8. Click **Deploy** (it will fail — that's fine, we need to add env vars first)

### 5b. Frontend Project

1. **Add New → Project** again, same repo
2. Name it: `ethans-command-center`
3. **Framework Preset:** Vite
4. **Root Directory:** `artifacts/tcc`
5. **Build Command:** `pnpm run build`
6. **Output Directory:** `dist`
7. Click **Deploy** (will also fail without env vars)

---

## Step 6: Set Environment Variables on Vercel

### API Server Environment Variables

Go to the API server project → **Settings → Environment Variables** and add:

| Variable | Value | Notes |
|----------|-------|-------|
| Variable | Where to get it | Notes |
|----------|----------------|-------|
| **SHARED_DATABASE_URL** | Get from the shared DB owner | Pooler URL (port 6543) to the shared business database |
| **PERSONAL_DATABASE_URL** | From Step 1 | Pooler URL (port 6543) to user's own Supabase project |
| **TCC_USER_NAME** | User's full name | e.g., `Ethan Jolly` |
| **TCC_USER_EMAIL** | User's email | e.g., `ethan@flipiq.com` |
| **TCC_USER_SLACK_ID** | Slack profile → three dots → Copy member ID | e.g., `U0991BD321Y` |
| **TCC_USER_ROLE** | User's job title | e.g., `COO` |
| **TCC_ACCOUNTABILITY_EMAIL** | Who should receive EOD reports | e.g., `tony@flipiq.com` |
| **TCC_ACCOUNTABILITY_SLACK_ID** | That person's Slack member ID | |
| **TCC_EMAIL_DOMAIN** | Company email domain | e.g., `flipiq.com` |
| **TCC_AUTH_TOKEN** | Pick a unique PIN | Login PIN for this user |
| **SESSION_SECRET** | Generate: `openssl rand -base64 64` | Random string for session signing |
| **AI_INTEGRATIONS_ANTHROPIC_API_KEY** | [platform.anthropic.com](https://platform.anthropic.com) | Anthropic API key |
| **ANTHROPIC_API_KEY** | Same as above | Some modules read this name |
| **AI_INTEGRATIONS_ANTHROPIC_BASE_URL** | `https://api.anthropic.com` | Anthropic API base URL |
| **SETTINGS_ENCRYPTION_KEY** | Generate: `openssl rand -hex 32` | Unique per instance (64 hex chars) |
| **GOOGLE_CLIENT_ID** | From Step 2a | OAuth Client ID |
| **GOOGLE_CLIENT_SECRET** | From Step 2a | OAuth Client Secret |
| **GOOGLE_REFRESH_TOKEN** | From Step 2b | Per-user — generated with user's own Google account |
| **SLACK_TOKEN** | [api.slack.com](https://api.slack.com/apps) → Bot User OAuth Token | Slack bot token |
| **LINEAR_API_KEY** | [linear.app/settings/api](https://linear.app/settings/api) | Linear API key |
| **RESEND_API_KEY** | [resend.com/api-keys](https://resend.com/api-keys) | Resend email API key |
| **BUSINESS_MASTER_SHEET_ID** | Google Sheet ID from URL | Shared business master sheet |
| **FEEDBACK_PIPELINE_ENABLED** | `true` | Enable AI feedback pipeline |
| **AGENT_RUNTIME_ORCHESTRATOR** | `true` | Enable agent runtime |
| **AGENT_RUNTIME_EMAIL** | `true` | Enable email agent |
| **AGENT_RUNTIME_TASKS** | `true` | Enable tasks agent |
| **AGENT_RUNTIME_IDEAS** | `true` | Enable ideas agent |
| **AGENT_RUNTIME_BRIEF** | `true` | Enable brief agent |
| **AGENT_RUNTIME_CONTACTS** | `true` | Enable contacts agent |
| **AGENT_RUNTIME_CALLS** | `true` | Enable calls agent |
| **AGENT_RUNTIME_CHECKIN** | `true` | Enable check-in agent |
| **AGENT_RUNTIME_JOURNAL** | `true` | Enable journal agent |
| **AGENT_RUNTIME_SCHEDULE** | `true` | Enable schedule agent |
| **AGENT_RUNTIME_INGEST** | `true` | Enable ingest agent |
| **CRON_PLAN_INGEST_ENABLED** | `false` | Only the primary instance should run plan-ingest |
| **CRON_EOD_ENABLED** | `true` | Each user runs their own EOD cron |

#### Per-User Google Docs/Sheets (check-ins & journal)

Check-ins and journals are always saved to the user's **personal database**. Optionally, they can also sync to Google Sheets/Docs. If the env var is blank or unset, the Google write is skipped (data is still saved to the DB).

| Variable | Value | Notes |
|----------|-------|-------|
| **CHECKIN_SHEET_ID** | `<google-sheet-id>` | Create a Google Sheet with a "Daily Check-in" tab, paste the Sheet ID. Leave blank to disable. |
| **JOURNAL_DOC_ID** | `<google-doc-id>` | Create a Google Doc for journal entries, paste the Doc ID. Leave blank to disable. |
| **PLAN_90_DAY_ID** | `<google-doc-id>` | **Only set on the primary instance** (Tony's) that runs `CRON_PLAN_INGEST_ENABLED=true`. This is a shared business doc — the ingested content lives in the shared `business_context` table and is visible to all users. Ethan/Ramy leave this blank. |

**How to get the ID:** Open the Google Sheet/Doc in your browser. The ID is the long string in the URL:
- Sheet: `https://docs.google.com/spreadsheets/d/`**`THIS_IS_THE_ID`**`/edit`
- Doc: `https://docs.google.com/document/d/`**`THIS_IS_THE_ID`**`/edit`

**Important:** The Google Sheet/Doc must be accessible by the user's Google account (the one whose refresh token you generated in Step 2b). Either create it with that account or share it with edit access.

### Frontend Environment Variables

Go to the frontend project → **Settings → Environment Variables** and add:

| Variable | Value |
|----------|-------|
| **VITE_API_SERVER_URL** | `https://ethans-command-center-api-server.vercel.app` |
| **VITE_USER_NAME** | `Ethan Jolly` |
| **VITE_USER_EMAIL** | `ethan@flipiq.com` |
| **VITE_ACCOUNTABILITY_EMAIL** | `tony@flipiq.com` |
| **VITE_EMAIL_DOMAIN** | `flipiq.com` |

> **Important:** `VITE_API_SERVER_URL` must point to the API server project's Vercel URL. The frontend's `vercel.json` rewrites `/api/*` to this URL.

---

## Step 7: Generate vercel.json for Frontend

The frontend needs a `vercel.json` that rewrites API calls to the correct API server. Run from the repo root:

```bash
VITE_API_SERVER_URL="https://ethans-command-center-api-server.vercel.app" \
  node artifacts/tcc/scripts/generate-vercel-json.mjs
```

This generates `artifacts/tcc/vercel.json` with the correct rewrite rules. Commit and push.

Alternatively, Vercel's build process may handle this automatically if `VITE_API_SERVER_URL` is set as an env var.

---

## Step 8: Deploy

1. Push any changes to the `dev-vercel` branch
2. Both Vercel projects will auto-deploy (if connected to the repo)
3. Or trigger manual deploys from the Vercel dashboard

---

## Step 9: Verify the Deployment

### Test the API Server

```bash
# Health check
curl https://ethans-command-center-api-server.vercel.app/api/health

# Authenticated request (use the TCC_AUTH_TOKEN you set)
curl -H "X-TCC-Token: <pin>" \
  https://ethans-command-center-api-server.vercel.app/api/checkin/today

# Should return personal data (empty for new user)
curl -H "X-TCC-Token: <pin>" \
  https://ethans-command-center-api-server.vercel.app/api/journal/today

# Should return shared business data (from Tony's DB)
curl -H "X-TCC-Token: <pin>" \
  https://ethans-command-center-api-server.vercel.app/api/business/context
```

### Test the Frontend

1. Open `https://ethans-command-center.vercel.app`
2. Enter the PIN (TCC_AUTH_TOKEN) when prompted
3. Verify:
   - Dashboard loads
   - Business context shows shared data from Tony's DB
   - Personal sections (journal, check-in, ideas) are empty
   - Chat/AI responds correctly (agent memory is seeded)

### Expected Behavior

| Section | Data Source | New User Sees |
|---------|-----------|---------------|
| Business Context | Shared DB | Tony's business goals, team roster |
| Contacts | Shared DB | All contacts from Tony's DB |
| Communication Log | Shared DB | Shared communication history |
| Journal | Personal DB | Empty (user writes their own) |
| Check-in | Personal DB | Empty (user checks in daily) |
| Ideas | Personal DB | Empty (user adds their own) |
| Scratch Notes | Personal DB | Empty |
| Chat | Personal DB | Works (agent memory seeded) |
| AI Feedback | Personal DB | Isolated (doesn't affect Tony) |

---

## Where Data Lives

Each user's data is isolated in their personal database. Shared business data lives in Tony's database and is read-only for other users.

| Data | Database | Google Sync |
|------|----------|-------------|
| Check-ins | Personal DB (`checkinsTable`) | Google Sheet if `CHECKIN_SHEET_ID` is set |
| Journals | Personal DB (`journalsTable`) | Google Doc if `JOURNAL_DOC_ID` is set |
| Ideas | Personal DB | None |
| Scratch Notes | Personal DB | None |
| Chat / AI Threads | Personal DB | None |
| Agent Training / Feedback | Personal DB | None |
| AI Usage Logs | Personal DB | None |
| Business Context | Shared DB (Tony's) | Synced from shared Google Sheet |
| Contacts | Shared DB (Tony's) | None |
| Communication Log | Shared DB (Tony's) | None |
| Meeting History | Shared DB (Tony's) | None |

**Key point:** If `CHECKIN_SHEET_ID` or `JOURNAL_DOC_ID` is not set, the Google Sheet/Doc write is silently skipped. The data is still saved to the personal database — the Google write is purely optional for backup/visibility.

---

## Troubleshooting

### "Google OAuth token expired"
- The refresh token became invalid (user revoked access, password change, etc.)
- Re-do Step 2b to generate a new `GOOGLE_REFRESH_TOKEN`
- Update the env var on Vercel and redeploy

### "PERSONAL_DATABASE_URL must be set"
- The API server can't find its database connection
- Check that `PERSONAL_DATABASE_URL` is set correctly in Vercel env vars
- Make sure the connection string uses port `6543` (pooler), not `5432` (direct)

### Schema push fails during provisioning
- The provisioning script auto-converts port 6543 → 5432 for DDL operations
- Make sure the Supabase project is fully provisioned (takes ~2 minutes after creation)
- Check that the database password is correct and URL-encoded if it contains special characters

### "Agent memory entries: 0" after provisioning
- The `seed-agent-architecture.mjs` script may have failed silently
- Run it manually:
  ```bash
  SUPABASE_DATABASE_URL="<PERSONAL_DATABASE_URL>" node lib/db/scripts/seed-agent-architecture.mjs
  ```

### Frontend shows "Failed to fetch" or CORS errors
- `VITE_API_SERVER_URL` doesn't match the actual API server URL
- Check the frontend's `vercel.json` rewrites
- Regenerate with `generate-vercel-json.mjs` if needed

---

## Quick Reference: Adding Another User

Once the infrastructure is set up, adding a new user is straightforward:

1. **Supabase:** Create new project → copy connection string
2. **Google OAuth:** Generate refresh token for their Google account (Step 2b)
3. **User profile:** Create `lib/db/seed-data/user-profiles/<name>.md`
4. **Provision DB:**
   ```bash
   PERSONAL_DATABASE_URL="..." node lib/db/scripts/provision-personal-db.mjs --user=<name>
   ```
5. **Vercel:** Create 2 projects (API + frontend), set env vars (copy from template, change user-specific values)
6. **Deploy** and verify

No code changes required.

---

## Appendix A: Browser-Agent Prompts (Ethan)

Copy-paste these into a browser-driving agent (e.g., Claude Computer Use, Playwright agent). Ethan must be **signed into his own Google account** (`ethan@flipiq.com`) in the browser session before running these.

### A.1 — GCP Project + OAuth Setup

```
You are helping me set up a Google Cloud Project for a personal tool called TCC (Tony's Command Center). I am Ethan Jolly, signed in as ethan@flipiq.com. Do the following in order and stop for confirmation before any destructive step.

1. Open https://console.cloud.google.com/
2. In the top project selector, click "New Project". Name it "ethan-tcc". Leave organization/location defaults. Create it and wait until it becomes the active project.
3. Go to "APIs & Services" → "Library". Enable each of these APIs (search by name, click Enable, wait for confirmation, then back to Library):
   - Gmail API
   - Google Calendar API
   - Google Sheets API
   - Google Docs API
   - Google Drive API
   - People API
4. Go to "APIs & Services" → "OAuth consent screen". If it asks for User Type, choose "External" and click Create. Fill in:
   - App name: Ethan Command Center
   - User support email: ethan@flipiq.com
   - Developer contact information email: ethan@flipiq.com
   Click Save and Continue.
5. On the Scopes step, click "Add or Remove Scopes". In the filter box, paste each of the following one at a time, check the matching row, then repeat until all eight are checked:
   - https://www.googleapis.com/auth/gmail.send
   - https://www.googleapis.com/auth/gmail.readonly
   - https://www.googleapis.com/auth/gmail.modify
   - https://www.googleapis.com/auth/calendar
   - https://www.googleapis.com/auth/spreadsheets
   - https://www.googleapis.com/auth/documents
   - https://www.googleapis.com/auth/drive
   - https://www.googleapis.com/auth/contacts.readonly
   Click Update, then Save and Continue through the remaining steps until you're back at the OAuth consent screen summary page.
6. On the OAuth consent screen summary, find the "Publishing status" section. It should say "Testing". Click "PUBLISH APP" and confirm in the dialog. The status must change to "In production". This step is REQUIRED — refresh tokens issued in Testing status expire after 7 days; Production tokens are permanent.
7. Go to "APIs & Services" → "Credentials". Click "Create Credentials" → "OAuth 2.0 Client ID". Choose:
   - Application type: Web application
   - Name: TCC Client
   - Authorized redirect URIs → Add URI: https://developers.google.com/oauthplayground
   Click Create.
8. In the popup that appears, copy the Client ID and Client Secret. Report both values back to me as:
   GOOGLE_CLIENT_ID=<value>
   GOOGLE_CLIENT_SECRET=<value>

Do NOT proceed to generate a refresh token in this task — that's a separate prompt.
```

### A.2 — Generate Refresh Token

```
You are helping me generate a permanent Google OAuth refresh token for ethan@flipiq.com. I already have my own Client ID and Client Secret from my GCP project (which is published to Production status).

My Client ID: <PASTE_ETHAN_CLIENT_ID_HERE>
My Client Secret: <PASTE_ETHAN_CLIENT_SECRET_HERE>

Do the following:

1. Open https://developers.google.com/oauthplayground/
2. Click the gear icon (Settings) in the top right corner.
3. Check the checkbox "Use your own OAuth credentials".
4. Paste my Client ID into the "OAuth Client ID" field.
5. Paste my Client Secret into the "OAuth Client secret" field.
6. Click "Close" to dismiss the settings panel.
7. On the left panel, find "Step 1: Select & authorize APIs". In the "Input your own scopes" text box near the top of that panel, paste this exact list (space-separated):
   https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/contacts.readonly
8. Click "Authorize APIs".
9. In the Google sign-in popup, choose the account ethan@flipiq.com (or sign in with that email if not already listed).
10. You will see a warning: "Google hasn't verified this app". Click "Advanced", then click "Go to Ethan Command Center (unsafe)".
11. On the consent screen, check ALL boxes to grant every requested permission. Click "Continue" or "Allow".
12. You'll be redirected back to the OAuth Playground with an authorization code in Step 2.
13. On the left panel under Step 2, click the blue "Exchange authorization code for tokens" button.
14. The response will show an access_token and a refresh_token. Copy the refresh_token value and report it back to me as:
    GOOGLE_REFRESH_TOKEN=<value>

Do NOT close the browser tab until I confirm I've saved the token.
```

### A.3 — Create Sheets and Docs

```
You are helping me create the Google Sheet and Google Doc that TCC will write to for Ethan Jolly (ethan@flipiq.com). Both must be created in Ethan's Google Drive while signed in as ethan@flipiq.com.

Task 1 — Create the Daily Check-in Sheet

1. Open https://sheets.google.com/ and click "Blank" to create a new spreadsheet.
2. Rename the file (top-left) to: Ethan — Daily Check-in
3. At the bottom of the sheet, the default tab is called "Sheet1". Double-click that tab name and rename it to exactly: Daily Check-in
   (This tab name is required — the app queries this exact string.)
4. In row 1 of the "Daily Check-in" tab, paste these 12 header cells across columns A through L (one per column):
   A1: Date
   B1: Bedtime
   C1: Waketime
   D1: Sleep Hours
   E1: Bible
   F1: Workout
   G1: Journal
   H1: Nutrition
   I1: Unplug
   J1: Alert Summary
   K1: Spiritual Anchor
   L1: Notes
5. Bold row 1 (select row → Format → Bold or Ctrl+B).
6. Freeze row 1 (View → Freeze → 1 row).
7. Copy the Sheet ID from the URL. The URL looks like:
   https://docs.google.com/spreadsheets/d/AAAA_LONG_ID_BBBB/edit
   The ID is the segment between "/d/" and "/edit". Report it back as:
   CHECKIN_SHEET_ID=<value>

Task 2 — Create the Journal Doc

1. Open https://docs.google.com/ and click "Blank" to create a new document.
2. Rename the file (top-left) to: Ethan — Daily Journal
3. Leave the body empty. TCC appends each day's entry with a horizontal separator line — no headers or template needed.
4. Copy the Doc ID from the URL. The URL looks like:
   https://docs.google.com/document/d/AAAA_LONG_ID_BBBB/edit
   The ID is the segment between "/d/" and "/edit". Report it back as:
   JOURNAL_DOC_ID=<value>

Note: The 90-Day Plan doc is a **shared business document** owned by Tony. Ethan does NOT create a personal 90-day plan doc — Ethan reads the ingested plan data from the shared business_context database table.

Both the sheet and the journal doc must be owned by ethan@flipiq.com (they will be, since you created them while signed in as that account). Do not share them with anyone else — the app accesses them via Ethan's own OAuth refresh token.
```

---

## Appendix B: Browser-Agent Prompts (Ramy)

Same structure as Appendix A but with Ramy's identity. Ramy must be **signed into his own Google account** in the browser session before running these.

### B.1 — GCP Project + OAuth Setup

```
You are helping me set up a Google Cloud Project for a personal tool called TCC (Tony's Command Center). I am Ramy, signed in as ramy@flipiq.com. Do the following in order and stop for confirmation before any destructive step.

1. Open https://console.cloud.google.com/
2. In the top project selector, click "New Project". Name it "ramy-tcc". Leave organization/location defaults. Create it and wait until it becomes the active project.
3. Go to "APIs & Services" → "Library". Enable each of these APIs (search by name, click Enable, wait for confirmation, then back to Library):
   - Gmail API
   - Google Calendar API
   - Google Sheets API
   - Google Docs API
   - Google Drive API
   - People API
4. Go to "APIs & Services" → "OAuth consent screen". If it asks for User Type, choose "External" and click Create. Fill in:
   - App name: Ramy Command Center
   - User support email: ramy@flipiq.com
   - Developer contact information email: ramy@flipiq.com
   Click Save and Continue.
5. On the Scopes step, click "Add or Remove Scopes". In the filter box, paste each of the following one at a time, check the matching row, then repeat until all eight are checked:
   - https://www.googleapis.com/auth/gmail.send
   - https://www.googleapis.com/auth/gmail.readonly
   - https://www.googleapis.com/auth/gmail.modify
   - https://www.googleapis.com/auth/calendar
   - https://www.googleapis.com/auth/spreadsheets
   - https://www.googleapis.com/auth/documents
   - https://www.googleapis.com/auth/drive
   - https://www.googleapis.com/auth/contacts.readonly
   Click Update, then Save and Continue through the remaining steps until you're back at the OAuth consent screen summary page.
6. On the OAuth consent screen summary, find the "Publishing status" section. It should say "Testing". Click "PUBLISH APP" and confirm in the dialog. The status must change to "In production". This step is REQUIRED — refresh tokens issued in Testing status expire after 7 days; Production tokens are permanent.
7. Go to "APIs & Services" → "Credentials". Click "Create Credentials" → "OAuth 2.0 Client ID". Choose:
   - Application type: Web application
   - Name: TCC Client
   - Authorized redirect URIs → Add URI: https://developers.google.com/oauthplayground
   Click Create.
8. In the popup that appears, copy the Client ID and Client Secret. Report both values back to me as:
   GOOGLE_CLIENT_ID=<value>
   GOOGLE_CLIENT_SECRET=<value>

Do NOT proceed to generate a refresh token in this task — that's a separate prompt.
```

### B.2 — Generate Refresh Token

```
You are helping me generate a permanent Google OAuth refresh token for ramy@flipiq.com. I already have my own Client ID and Client Secret from my GCP project (which is published to Production status).

My Client ID: <PASTE_RAMY_CLIENT_ID_HERE>
My Client Secret: <PASTE_RAMY_CLIENT_SECRET_HERE>

Do the following:

1. Open https://developers.google.com/oauthplayground/
2. Click the gear icon (Settings) in the top right corner.
3. Check the checkbox "Use your own OAuth credentials".
4. Paste my Client ID into the "OAuth Client ID" field.
5. Paste my Client Secret into the "OAuth Client secret" field.
6. Click "Close" to dismiss the settings panel.
7. On the left panel, find "Step 1: Select & authorize APIs". In the "Input your own scopes" text box near the top of that panel, paste this exact list (space-separated):
   https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/contacts.readonly
8. Click "Authorize APIs".
9. In the Google sign-in popup, choose the account ramy@flipiq.com (or sign in with that email if not already listed).
10. You will see a warning: "Google hasn't verified this app". Click "Advanced", then click "Go to Ramy Command Center (unsafe)".
11. On the consent screen, check ALL boxes to grant every requested permission. Click "Continue" or "Allow".
12. You'll be redirected back to the OAuth Playground with an authorization code in Step 2.
13. On the left panel under Step 2, click the blue "Exchange authorization code for tokens" button.
14. The response will show an access_token and a refresh_token. Copy the refresh_token value and report it back to me as:
    GOOGLE_REFRESH_TOKEN=<value>

Do NOT close the browser tab until I confirm I've saved the token.
```

### B.3 — Create Sheets and Docs

```
You are helping me create the Google Sheet and Google Doc that TCC will write to for Ramy (ramy@flipiq.com). Both must be created in Ramy's Google Drive while signed in as ramy@flipiq.com.

Task 1 — Create the Daily Check-in Sheet

1. Open https://sheets.google.com/ and click "Blank" to create a new spreadsheet.
2. Rename the file (top-left) to: Ramy — Daily Check-in
3. At the bottom of the sheet, the default tab is called "Sheet1". Double-click that tab name and rename it to exactly: Daily Check-in
   (This tab name is required — the app queries this exact string.)
4. In row 1 of the "Daily Check-in" tab, paste these 12 header cells across columns A through L (one per column):
   A1: Date
   B1: Bedtime
   C1: Waketime
   D1: Sleep Hours
   E1: Bible
   F1: Workout
   G1: Journal
   H1: Nutrition
   I1: Unplug
   J1: Alert Summary
   K1: Spiritual Anchor
   L1: Notes
5. Bold row 1 (select row → Format → Bold or Ctrl+B).
6. Freeze row 1 (View → Freeze → 1 row).
7. Copy the Sheet ID from the URL. The URL looks like:
   https://docs.google.com/spreadsheets/d/AAAA_LONG_ID_BBBB/edit
   The ID is the segment between "/d/" and "/edit". Report it back as:
   CHECKIN_SHEET_ID=<value>

Task 2 — Create the Journal Doc

1. Open https://docs.google.com/ and click "Blank" to create a new document.
2. Rename the file (top-left) to: Ramy — Daily Journal
3. Leave the body empty. TCC appends each day's entry with a horizontal separator line — no headers or template needed.
4. Copy the Doc ID from the URL. The URL looks like:
   https://docs.google.com/document/d/AAAA_LONG_ID_BBBB/edit
   The ID is the segment between "/d/" and "/edit". Report it back as:
   JOURNAL_DOC_ID=<value>

Note: The 90-Day Plan doc is a **shared business document** owned by Tony. Ramy does NOT create a personal 90-day plan doc — Ramy reads the ingested plan data from the shared business_context database table.

Both the sheet and the journal doc must be owned by ramy@flipiq.com (they will be, since you created them while signed in as that account). Do not share them with anyone else — the app accesses them via Ramy's own OAuth refresh token.
```
