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
