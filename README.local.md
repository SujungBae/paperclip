# Paperclip Local Run Guide

This file documents the commands that work in this local checkout on Windows PowerShell.

## Repo Location

```powershell
cd d:\Programs\paperclip
```

## Recommended Way To Start The Server

Use the local wrapper we created for this repository:

```powershell
.\.paperclip-local\run.cmd
```

What this does:

- runs the Paperclip CLI from this repo
- auto-onboards if needed
- runs doctor checks
- starts the server

## Dev Server

If you want the development server flow instead:

```powershell
.\.paperclip-local\dev.cmd
```

## First-Time Install Or Reinstall

If dependencies were deleted or the repo was freshly cloned:

```powershell
.\.paperclip-local\install.cmd
```

## One-Time Workspace Build Fix

This repo may need the plugin SDK workspace package to be built once before the server starts correctly.

Run this if you see an error like:

```text
Cannot find module ... @paperclipai/plugin-sdk/dist/index.js
```

Command:

```powershell
.\.paperclip-local\pnpm.cmd --filter @paperclipai/plugin-sdk build
```

## Environment File

For local embedded PostgreSQL, keep `.env` minimal:

```env
PORT=3100
```

Important:

- do not set `DATABASE_URL` unless you intentionally want to use an external PostgreSQL server
- if `DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip` is present, Paperclip will try to connect to a local Postgres server instead of using embedded PostgreSQL

## Open In Browser

After startup, open:

```text
http://localhost:3100
```

## Why Not `npx paperclipai ...`?

In this PowerShell environment, `npx` may fail because `npx.ps1` is blocked by execution policy.

That is why this repo uses:

- `.\.paperclip-local\run.cmd`
- `.\.paperclip-local\dev.cmd`
- `.\.paperclip-local\pnpm.cmd ...`

instead of plain `npx ...`.

## Useful Commands

Run onboard only:

```powershell
.\.paperclip-local\pnpm.cmd paperclipai onboard --yes
```

Show CLI help:

```powershell
.\.paperclip-local\pnpm.cmd paperclipai --help
```

## Common Problems

### 1. `npx` PowerShell execution policy error

Use:

```powershell
npx.cmd paperclipai onboard --yes
```

or prefer the local wrapper commands in this repo.

### 2. `Cannot find module @paperclipai/plugin-sdk/dist/index.js`

Run:

```powershell
.\.paperclip-local\pnpm.cmd --filter @paperclipai/plugin-sdk build
```

### 3. `connect ECONNREFUSED ::1:5432`

This usually means `.env` contains `DATABASE_URL` for an external Postgres instance.

Fix `.env` so it does not contain `DATABASE_URL` for local embedded DB mode:

```env
PORT=3100
```

## Current Local Setup

- repo path: `d:\Programs\paperclip`
- local wrapper path: `d:\Programs\paperclip\.paperclip-local`
- current `.env` uses embedded PostgreSQL mode
- default URL: `http://localhost:3100`

## Mac Mini Setup

If you want to run Paperclip for real on a Mac mini instead of this Windows dev PC, the cleanest path is:

1. clone your fork
2. switch to the `feat/telegram-bridge` branch
3. install dependencies
4. start Paperclip locally
5. start the Telegram bridge in a second terminal

Example:

```bash
git clone https://github.com/SujungBae/paperclip.git
cd paperclip
git switch feat/telegram-bridge
pnpm install
pnpm dev
```

After startup, open:

```text
http://localhost:3100
```

Mac notes:

- keep `DATABASE_URL` unset if you want embedded PostgreSQL
- `pnpm dev` is better than a one-shot run while you are still changing code
- keep the Paperclip server terminal open

## Telegram Bridge

The Telegram bridge lets you send commands from Telegram to your local Paperclip CEO without exposing Paperclip publicly.

Flow:

```text
Telegram -> bridge script -> local Paperclip API -> CEO issue creation
```

Files:

- `scripts/telegram-paperclip-bridge.ts`
- `package.json` scripts:
  - `telegram:bridge`
  - `telegram:bridge:once`

## Telegram Bridge Env

Required:

```bash
export TELEGRAM_BOT_TOKEN="your_bot_token"
export PAPERCLIP_COMPANY_ID="your_company_uuid"
```

Optional:

```bash
export PAPERCLIP_API_URL="http://127.0.0.1:3100"
export PAPERCLIP_API_KEY=""
export PAPERCLIP_CEO_AGENT_ID=""
export TELEGRAM_ALLOWED_CHAT_ID=""
export TELEGRAM_BRIDGE_OFFSET_FILE="$PWD/.paperclip-local/telegram-bridge-offset.json"
```

Important:

- `PAPERCLIP_COMPANY_ID` must be the company UUID, not the company name
- if `PAPERCLIP_CEO_AGENT_ID` is empty, the bridge auto-finds the active CEO for that company
- `TELEGRAM_ALLOWED_CHAT_ID` is recommended once testing is done

## Start The Telegram Bridge

Run this in a second terminal after Paperclip is already up:

```bash
cd ~/paperclip
export TELEGRAM_BOT_TOKEN="your_bot_token"
export PAPERCLIP_COMPANY_ID="your_company_uuid"
npm run telegram:bridge
```

For this repo's current local test company, the UUID was:

```text
4c03274c-5b2c-4610-9c90-e59c1fd0c69c
```

Use your real company UUID on the Mac mini if it differs.

## Telegram Commands

Supported commands:

```text
/task <title or multi-line task>
/issue <title or multi-line task>
/status
/issues
/approvals
/ping
/help
```

Examples:

```text
/task Hire a founding engineer
write a hiring plan
break the roadmap into concrete tasks
```

```text
/status
```

```text
/approvals
```

## Recommended Next Bridge Commands

These are the next commands worth adding if you want to operate Paperclip from Telegram with less reliance on the browser UI.

Highest priority:

```text
/issue COM-1
/comment COM-1 <message>
/agents
/approve <approval-id>
```

What each one would do:

- `/issue COM-1`
  - show one issue in detail
  - useful fields: status, assignee, description summary, latest comments, linked approvals
- `/comment COM-1 <message>`
  - add a comment to an existing issue
  - useful for nudging the CEO or clarifying a task without opening the UI
- `/agents`
  - list current agents and their statuses
  - useful when `/status` says there is work in progress but you do not know who is active
- `/approve <approval-id>`
  - approve a pending approval directly from Telegram
  - useful when the inbox or approvals page is not open

Good follow-ups after that:

```text
/reject <approval-id> <reason>
/runs
```

- `/reject <approval-id> <reason>`
  - reject a pending approval with a short explanation
- `/runs`
  - show recent runs, especially failures or currently active runs

Suggested implementation order:

1. `/issue`
2. `/comment`
3. `/agents`
4. `/approve`

That set would cover the most common "screen is not open but I still need to operate the company" use cases.

## Operating Pattern On Mac Mini

Recommended day-to-day setup:

1. Terminal A: `pnpm dev`
2. Terminal B: `npm run telegram:bridge`
3. Telegram on your phone or work PC
4. browser open on the Mac mini when you need the full UI

This gives you:

- local-only Paperclip hosting on the Mac mini
- remote task submission through Telegram
- lightweight status checks through `/status`, `/issues`, and `/approvals`

## Troubleshooting The Bridge

### `Failed: Internal server error`

Usually means `PAPERCLIP_COMPANY_ID` is wrong.

Wrong:

```bash
export PAPERCLIP_COMPANY_ID="compare-models"
```

Correct:

```bash
export PAPERCLIP_COMPANY_ID="4c03274c-5b2c-4610-9c90-e59c1fd0c69c"
```

### Telegram bot does not answer

Check:

- the bridge terminal is still running
- `TELEGRAM_BOT_TOKEN` is set in that terminal
- the bot is not already being consumed by another webhook/poller

### `/task` works but assignee shows `unknown`

This means the issue exists, but the bridge could not map the assignee ID to a currently listed agent name.
It is a display limitation, not a task creation failure.
