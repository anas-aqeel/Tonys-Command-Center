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

## Step 2: Set Up Google Cloud OAuth (Per-User Email/Calendar Access)

Each user needs their own Google OAuth refresh token so TCC can access their Gmail, Google Calendar, Google Drive, Sheets, and Docs.

### 2a. Create OAuth Credentials (one-time, shared across users)

If the Google Cloud project already has OAuth credentials set up (it does for Tony), you can reuse the same Client ID and Client Secret. Skip to **2b**.

If setting up from scratch:

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Select or create a project (e.g., `FlipIQ TCC`)
3. Go to **APIs & Services → Library** and enable these APIs:
   - Gmail API
   - Google Calendar API
   - Google Sheets API
   - Google Docs API
   - Google Drive API
   - People API
4. Go to **APIs & Services → OAuth consent screen**
   - Choose **Internal** (if using Google Workspace) or **External**
   - Fill in app name: `TCC Command Center`
   - Add scopes:
     - `https://www.googleapis.com/auth/gmail.send`
     - `https://www.googleapis.com/auth/gmail.readonly`
     - `https://www.googleapis.com/auth/gmail.modify`
     - `https://www.googleapis.com/auth/calendar`
     - `https://www.googleapis.com/auth/spreadsheets`
     - `https://www.googleapis.com/auth/documents`
     - `https://www.googleapis.com/auth/drive`
     - `https://www.googleapis.com/auth/contacts.readonly`
   - Add the new user's email as a **test user** (required if consent screen is External and not verified)
5. Go to **APIs & Services → Credentials**
6. Click **Create Credentials → OAuth 2.0 Client ID**
   - Application type: **Web application**
   - Name: `TCC Server`
   - Authorized redirect URIs: add `https://developers.google.com/oauthplayground`
7. Copy the **Client ID** and **Client Secret**

### 2b. Generate a Refresh Token for the New User

This is the per-user step. Each person (Ethan, Ramy, etc.) must do this with their own Google account.

1. Open [Google OAuth Playground](https://developers.google.com/oauthplayground/)
2. Click the **gear icon** (Settings) in the top right
3. Check **"Use your own OAuth credentials"**
4. Enter the **Client ID** and **Client Secret** from step 2a
5. In the left panel, select these scopes (or paste them manually):
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
7. Sign in with the **new user's Google account** (e.g., `ethan@flipiq.com`)
8. Grant all requested permissions
9. Back on the playground, click **"Exchange authorization code for tokens"**
10. Copy the **Refresh Token** from the response — this is your `GOOGLE_REFRESH_TOKEN`

> **Important:** The refresh token does not expire unless the user revokes access or the OAuth app's consent screen changes. Store it securely.

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
| **SHARED_DATABASE_URL** | `postgresql://postgres.TONYS_REF:PASS@...pooler.supabase.com:6543/postgres` | Tony's DB — get from Tony |
| **PERSONAL_DATABASE_URL** | `postgresql://postgres.YOURS:PASS@...pooler.supabase.com:6543/postgres` | From Step 1 |
| **TCC_USER_NAME** | `Ethan Jolly` | Full name |
| **TCC_USER_EMAIL** | `ethan@flipiq.com` | User's email |
| **TCC_USER_SLACK_ID** | `U0991BD321Y` | Slack member ID |
| **TCC_USER_ROLE** | `COO` | Job title / role |
| **TCC_ACCOUNTABILITY_EMAIL** | `tony@flipiq.com` | Who gets EOD reports |
| **TCC_ACCOUNTABILITY_SLACK_ID** | `U0991BAS0TC` | Accountability person's Slack ID |
| **TCC_EMAIL_DOMAIN** | `flipiq.com` | Company email domain |
| **TCC_AUTH_TOKEN** | `<unique-pin>` | Login PIN for this user (pick something unique) |
| **SESSION_SECRET** | `<random-string>` | Any random string for session signing |
| **AI_INTEGRATIONS_ANTHROPIC_API_KEY** | `sk-ant-...` | Anthropic API key |
| **ANTHROPIC_API_KEY** | `sk-ant-...` | Same key (some modules read this name) |
| **AI_INTEGRATIONS_ANTHROPIC_BASE_URL** | `https://api.anthropic.com` | Anthropic API base URL |
| **SETTINGS_ENCRYPTION_KEY** | `<64-hex-chars>` | Unique per instance. Generate with: `openssl rand -hex 32` |
| **GOOGLE_CLIENT_ID** | `...apps.googleusercontent.com` | From Step 2a |
| **GOOGLE_CLIENT_SECRET** | `GOCSPX-...` | From Step 2a |
| **GOOGLE_REFRESH_TOKEN** | `1//0...` | From Step 2b (per-user) |
| **SLACK_TOKEN** | `xoxb-...` | Slack bot token (shared or per-workspace) |
| **LINEAR_API_KEY** | `lin_api_...` | Linear API key |
| **RESEND_API_KEY** | `re_...` | Resend email API key |
| **BUSINESS_MASTER_SHEET_ID** | `1WGuJwCoWbwyFamXXP79yxnPmYhdFPgOGhOR8_V-EQyw` | Shared Google Sheet (same for all users) |
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
| **CRON_PLAN_INGEST_ENABLED** | `false` | Only Tony's instance runs plan ingest cron |
| **CRON_EOD_ENABLED** | `true` | Each user runs their own EOD cron |

#### Per-User Google Docs/Sheets (check-ins & journal)

Check-ins and journals are always saved to the user's **personal database**. Optionally, they can also sync to Google Sheets/Docs. If the env var is blank or unset, the Google write is skipped (data is still saved to the DB).

| Variable | Value | Notes |
|----------|-------|-------|
| **CHECKIN_SHEET_ID** | `<google-sheet-id>` | Create a Google Sheet with a "Daily Check-in" tab, paste the Sheet ID. Leave blank to disable. |
| **JOURNAL_DOC_ID** | `<google-doc-id>` | Create a Google Doc for journal entries, paste the Doc ID. Leave blank to disable. |
| **PLAN_90_DAY_ID** | `<google-doc-id>` | User's 90-day plan doc. Leave blank to disable. |

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
