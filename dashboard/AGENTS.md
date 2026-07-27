<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Next.js MCP (next-devtools)

Use the **next-devtools** MCP whenever you need live Next.js runtime context — do not guess about build/runtime errors, routes, or logs if MCP is available.

## Prerequisites

1. Config is already in the repo: `.cursor/mcp.json` and `.mcp.json` at the monorepo root (runs `npx -y next-devtools-mcp@latest`).
2. Dev server must be running from this app: `npm run dev` in `dashboard/`.
3. In Cursor: Settings → Tools & MCP → enable/refresh **next-devtools**.

## How to use

- Discover the running Next.js MCP endpoint, then call tools via next-devtools.
- Prefer these tools before digging blindly through files when debugging the running app:
  - `get_errors` — build, runtime, and type errors from the current session
  - `get_logs` — path to the development log file (browser + server output)
  - `get_routes` — app/pages router entry points from the filesystem
  - `get_page_metadata` — route/component/render details for a page
  - `get_project_metadata` — project structure, config, and dev server URL
  - `get_server_action_by_id` — map a Server Action id to source file/function

## When to call it

- User reports a UI/runtime bug while `next dev` is up
- Before claiming there are “no errors” or inventing stack traces
- When you need the live route list or which page/layout is rendered

# GitHub Pages — auto commit + push

When you finish work that changes the **dashboard / GitHub Pages** site (anything under `dashboard/`, or related Pages deploy config such as `.github/workflows/nextjs.yml`), **always commit and push** before ending the turn (unless the user says not to):

1. **Check errors first** — do not commit/push until clean:
   - Prefer next-devtools `get_errors` when `next dev` is running.
   - Also check lints/diagnostics for edited files.
   - If errors exist, fix them first; only then proceed.
2. Commit meaningful source changes only (never `__pycache__`, `*.pyc`, secrets, `.env`, large binaries, or `*.tmp`).
3. Push to `origin` on the current branch (`git push -u origin HEAD` if needed).
4. Do **not** invent a local Pages deploy — GitHub Actions deploys after push.
5. Tell the user the commit SHA/URL and that errors were checked.

Do not force-push `main`/`master`. Do not amend unless the usual amend safety rules allow it.
