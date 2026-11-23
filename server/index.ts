/**
 * Production runtime: Elysia on Bun hosting the TanStack Start server entry.
 *
 * `bun run build` is unchanged and still emits:
 *   - dist/client            -> static assets (served by Elysia below)
 *   - dist/server/server.js  -> default export with a Web-standard `fetch(request)`
 *
 * Run with: bun run start   (bun server/index.ts)
 */
import { statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import { Elysia } from 'elysia'

import { mastra } from '../src/mastra/index.ts'
import { MastraElysiaServer } from './mastra-elysia-adapter.ts'

const PORT = Number(process.env.PORT ?? 3000)
const CLIENT_DIR = resolve(process.cwd(), 'dist/client')
const SERVER_ENTRY = resolve(process.cwd(), process.env.SERVER_ENTRY ?? 'dist/server/server.js')

type FetchHandler = { fetch: (request: Request) => Response | Promise<Response> }

function isFetchHandler(value: unknown): value is FetchHandler {
  return (
    typeof value === 'object' &&
    value !== null &&
    'fetch' in value &&
    typeof value.fetch === 'function'
  )
}

const entry: Record<string, unknown> = await import(pathToFileURL(SERVER_ENTRY).href)
const startHandler: unknown = entry.default

if (!isFetchHandler(startHandler)) {
  throw new Error(
    `${SERVER_ENTRY} must default-export an object with a fetch(request) method. Did you run \`bun run build\`?`,
  )
}
const fetchHandler = startHandler.fetch

/** Resolve a URL path to a file inside dist/client, or null if it is not a static asset. */
function assetPath(pathname: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }

  // Block traversal (`..`) and null bytes before touching the filesystem.
  if (decoded.includes('\0') || decoded.split('/').includes('..')) return null

  const candidate = join(CLIENT_DIR, decoded)
  if (candidate !== CLIENT_DIR && !candidate.startsWith(CLIENT_DIR + sep)) return null

  try {
    return statSync(candidate).isFile() ? candidate : null
  } catch {
    return null
  }
}

function serve(request: Request, path: string): Response | Promise<Response> {
  if (request.method === 'GET' || request.method === 'HEAD') {
    const file = assetPath(path)
    if (file) {
      const asset = Bun.file(file)
      return new Response(request.method === 'HEAD' ? null : asset, {
        headers: { 'content-type': asset.type || 'application/octet-stream' },
      })
    }
  }

  // `parse: 'none'` on the routes keeps the request body untouched for Payload's
  // POST handlers (server functions, REST/GraphQL API, auth, uploads, ...).
  return fetchHandler(request)
}

const app = new Elysia()
  .all('/', { parse: 'none' }, ({ request, path }) => serve(request, path))
  .all('/*', { parse: 'none' }, ({ request, path }) => serve(request, path))

// Mastra routes live under their own prefix so they don't collide with Payload's /api routes.
const mastraServer = new MastraElysiaServer({ app, mastra, prefix: '/api/mastra' })
await mastraServer.init()

app.listen({ port: PORT, hostname: '0.0.0.0' })

console.log(`Elysia (Bun) listening on http://localhost:${app.server?.port ?? PORT}`)
console.log(`Mastra Studio API: http://localhost:${app.server?.port ?? PORT}/api/mastra`)
