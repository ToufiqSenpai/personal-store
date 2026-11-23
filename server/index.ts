/**
 * Single server entry for both dev and production.
 *
 * One Elysia instance hosts Mastra's API (/api/mastra) and the app:
 *  - dev  : Vite in middlewareMode serves SSR + HMR (no build required)
 *  - prod : static dist/client + the built TanStack Start fetch handler
 *
 * Run with: bun run dev   |   bun run start
 */
import { statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import { cors } from '@elysia/cors'
import { Elysia } from 'elysia'

import { mastra } from '../src/mastra/index.ts'
import { MastraElysiaServer } from './mastra-elysia-adapter.ts'

const PORT = Number(process.env.PORT ?? 3000)
const isDev = process.env.NODE_ENV !== 'production'
const CLIENT_DIR = resolve(process.cwd(), 'dist/client')
const SERVER_ENTRY = resolve(process.cwd(), process.env.SERVER_ENTRY ?? 'dist/server/server.js')

type FetchHandler = { fetch: (request: Request) => Response | Promise<Response> }
type Ctx = { request: Request; path: string }

function isFetchHandler(value: unknown): value is FetchHandler {
  return (
    typeof value === 'object' &&
    value !== null &&
    'fetch' in value &&
    typeof value.fetch === 'function'
  )
}

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

// --- App handler: Vite middleware in dev, built handler + static files in prod.
let handleApp: (ctx: Ctx) => Response | Promise<Response>

if (isDev) {
  const [{ createServer }, { callViteMiddleware }] = await Promise.all([
    import('vite'),
    import('./vite-bridge.ts'),
  ])
  const vite = await createServer({
    appType: 'custom',
    server: { middlewareMode: true },
  })
  handleApp = async ({ request }) =>
    (await callViteMiddleware(vite.middlewares, request)) ?? new Response('Not found', { status: 404 })
} else {
  const entry: Record<string, unknown> = await import(pathToFileURL(SERVER_ENTRY).href)
  const startHandler: unknown = entry.default

  if (!isFetchHandler(startHandler)) {
    throw new Error(
      `${SERVER_ENTRY} must default-export an object with a fetch(request) method. Did you run \`bun run build\`?`,
    )
  }
  const fetchHandler = startHandler.fetch

  handleApp = ({ request, path }) => {
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
}

// --- One Elysia instance for the app and Mastra.
const isLocalOrigin = (request: Request): boolean => {
  const origin = request.headers.get('origin')
  return origin !== null && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
}

const app = new Elysia()
  .use(
    cors({
      origin: isLocalOrigin,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: true,
      preflight: true,
    }),
  )
  .all('/', { parse: 'none' }, (ctx) => handleApp(ctx))
  .all('/*', { parse: 'none' }, (ctx) => handleApp(ctx))

const mastraServer = new MastraElysiaServer({ app, mastra, prefix: '/api/mastra' })
await mastraServer.init()

// Create Mastra's tables at boot so the first Studio request isn't stuck
// waiting for schema creation (Bun times out idle requests after 10s by default).
await mastra.getStorage()?.init()

app.listen({ port: PORT, hostname: '0.0.0.0', idleTimeout: 120 })

console.log(`${isDev ? 'Dev' : 'Production'} server (Elysia + Mastra) on http://localhost:${app.server?.port ?? PORT}`)
console.log(`Mastra Studio API: http://localhost:${app.server?.port ?? PORT}/api/mastra`)
