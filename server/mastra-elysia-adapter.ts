/**
 * Custom Mastra server adapter for Elysia v2.
 *
 * The official `@mastra/elysia` adapter still targets Elysia v1 (`elysia/cookies`
 * was removed in v2), so this implements the same `MastraServer` contract using
 * Elysia v2's routing API (`app[method](path, options, handler)`).
 */
import type { ToolsInput } from '@mastra/core/agent'
import type { Mastra } from '@mastra/core'
import type { RequestContext } from '@mastra/core/request-context'
import {
  MastraServer,
  checkRouteFGA,
  getCustomHTTPExceptionResponse,
  getHTTPErrorResponse,
  isZodError,
  normalizeQueryParams,
  redactStreamChunk,
  serializeStreamChunk,
  type ParsedRequestParams,
  type ServerRoute,
} from '@mastra/server/server-adapter'
import type { Elysia } from 'elysia'

type ElysiaContext = {
  request: Request
  params: Record<string, string>
  query: Record<string, unknown>
  body: unknown
  requestContext?: RequestContext
  mastra?: Mastra
  registeredTools?: ToolsInput
  taskStore?: unknown
  customRouteAuthConfig?: Map<string, boolean>
  abortSignal?: AbortSignal
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseRequestContext(encoded: string): Record<string, unknown> | undefined {
  for (const candidate of [encoded, Buffer.from(encoded, 'base64').toString('utf-8')]) {
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (isRecord(parsed)) return parsed
    } catch {
      /* try the next representation */
    }
  }
  return undefined
}

function hasFullStream(value: unknown): value is { fullStream: ReadableStream } {
  return (
    isRecord(value) &&
    'fullStream' in value &&
    value.fullStream instanceof ReadableStream
  )
}

/** Elysia uses `:name` params; normalize to `:p0` to avoid router conflicts between Mastra routes. */
function normalizeRouteParams(path: string): { normalizedPath: string; paramNames: string[] } {
  const paramNames: string[] = []
  return {
    normalizedPath: path.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_match, name: string) => {
      paramNames.push(name)
      return `:p${paramNames.length - 1}`
    }),
    paramNames,
  }
}

function searchParamsToQuery(searchParams: URLSearchParams): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {}
  for (const key of new Set(searchParams.keys())) {
    const values = searchParams.getAll(key)
    query[key] = values.length === 1 ? values[0] : values
  }
  return query
}

function remapParams(raw: Record<string, string>, paramNames: string[]): Record<string, string> {
  if (paramNames.length === 0) return raw
  const result: Record<string, string> = {}
  paramNames.forEach((name, i) => {
    const key = `p${i}`
    if (key in raw) result[name] = raw[key]!
  })
  return result
}

function cancelOnAbort(reader: ReadableStreamDefaultReader<Uint8Array>, signal?: AbortSignal) {
  let cancelled = false
  const cancel = (reason: unknown) => {
    if (cancelled) return
    cancelled = true
    signal?.removeEventListener('abort', onAbort)
    void reader.cancel(reason).catch(() => {})
  }
  const onAbort = () => cancel('request aborted')
  if (signal?.aborted) onAbort()
  else signal?.addEventListener('abort', onAbort, { once: true })
  return {
    cancel,
    dispose: () => signal?.removeEventListener('abort', onAbort),
  }
}

export class MastraElysiaServer extends MastraServer<Elysia, ElysiaContext, ElysiaContext> {
  registerContextMiddleware(): void {
    this.app.derive(async (ctx) => {
      let paramsRequestContext: Record<string, unknown> | undefined
      let bodyRequestContext: Record<string, unknown> | undefined

      if (ctx.request.method === 'GET') {
        const encoded = ctx.query.requestContext
        if (typeof encoded === 'string') paramsRequestContext = parseRequestContext(encoded)
      } else if (['POST', 'PUT', 'PATCH'].includes(ctx.request.method)) {
        const body: unknown = ctx.body
        if (isRecord(body) && 'requestContext' in body && isRecord(body.requestContext)) {
          bodyRequestContext = body.requestContext
        }
      }

      const requestContext = this.mergeRequestContext({ paramsRequestContext, bodyRequestContext })
      this.applyRequestMetadataToContext({
        requestContext,
        getHeader: (name) => ctx.request.headers.get(name) ?? undefined,
      })

      return {
        requestContext,
        mastra: this.mastra,
        registeredTools: this.tools ?? {},
        taskStore: this.taskStore,
        abortSignal: ctx.request.signal,
        customRouteAuthConfig: this.customRouteAuthConfig,
      }
    })
  }

  registerAuthMiddleware(): void {
    // Auth is enforced per-route inside registerRoute via checkRouteAuth().
  }

  registerHttpLoggingMiddleware(): void {
    // Request logging can be added via Elysia hooks if `server.apiReqLogs` is enabled.
  }

  async getParams(_route: ServerRoute, request: ElysiaContext): Promise<ParsedRequestParams> {
    const url = new URL(request.request.url)
    const { paramNames } = normalizeRouteParams(_route.path)
    const raw = request.params
    return {
      urlParams: paramNames.length > 0 ? remapParams(raw, paramNames) : raw,
      queryParams: normalizeQueryParams(searchParamsToQuery(url.searchParams)),
      body: request.body,
    }
  }

  async stream(route: ServerRoute, ctx: ElysiaContext, result: unknown): Promise<Response> {
    const streamFormat = route.streamFormat ?? 'stream'
    const encoder = new TextEncoder()
    if (!(result instanceof ReadableStream) && !hasFullStream(result)) {
      throw new Error('Expected a ReadableStream or a stream result with fullStream')
    }
    const source = result instanceof ReadableStream ? result : result.fullStream
    const reader = source.getReader()
    const upstream = cancelOnAbort(reader, ctx.abortSignal ?? ctx.request.signal)
    let finished = false

    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        if (streamFormat === 'sse' && route.sseFlushOnConnect) controller.enqueue(encoder.encode(': connected\n\n'))
      },
      pull: async (controller) => {
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (finished) return
            if (done) {
              finished = true
              upstream.dispose()
              if (streamFormat === 'sse') controller.enqueue(encoder.encode('data: [DONE]\n\n'))
              controller.close()
              return
            }
            if (!value) continue
            const output = this.streamOptions.redact ?? true ? redactStreamChunk(value) : value
            const serialized = serializeStreamChunk(output)
            if (!serialized.ok) continue
            controller.enqueue(
              encoder.encode(streamFormat === 'sse' ? `data: ${serialized.json}\n\n` : `${serialized.json}\x1e`),
            )
            return
          }
        } catch {
          if (finished) return
          finished = true
          upstream.dispose()
          controller.close()
        }
      },
      cancel: (reason) => {
        finished = true
        upstream.cancel(reason)
      },
    })

    return new Response(body, {
      headers:
        streamFormat === 'sse'
          ? { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' }
          : { 'content-type': 'text/plain' },
    })
  }

  async sendResponse(route: ServerRoute, ctx: ElysiaContext, result: unknown): Promise<Response> {
    if (route.responseType === 'stream') return this.stream(route, ctx, result)
    if (route.responseType === 'datastream-response') {
      if (result instanceof Response) return result
      return new Response(null, { status: 500 })
    }

    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (isRecord(result) && '__refreshHeaders' in result && isRecord(result.__refreshHeaders)) {
      for (const [key, value] of Object.entries(result.__refreshHeaders)) {
        if (typeof value === 'string') headers[key] = value
      }
      delete result.__refreshHeaders
    }
    return new Response(JSON.stringify(result), { headers })
  }

  async registerRoute(_app: Elysia, route: ServerRoute, { prefix: prefixParam }: { prefix?: string }): Promise<void> {
    const prefix = prefixParam ?? this.prefix ?? ''
    const { normalizedPath } = normalizeRouteParams(`${prefix}${route.path}`)

    const handler = async (rawCtx: ElysiaContext): Promise<Response> => {
      const ctx = rawCtx
      const authError = await this.checkRouteAuth(route, {
        path: new URL(ctx.request.url).pathname,
        method: ctx.request.method,
        getHeader: (name) => ctx.request.headers.get(name) ?? undefined,
        getQuery: (name) => {
          const value = ctx.query[name]
          return Array.isArray(value) ? value[0] : typeof value === 'string' ? value : undefined
        },
        requestContext: ctx.requestContext!,
        request: ctx.request,
        buildAuthorizeContext: () => ctx,
      })
      if (authError) {
        return new Response(JSON.stringify({ error: authError.error }), {
          status: authError.status,
          headers: { 'content-type': 'application/json', ...authError.headers },
        })
      }

      const permissionError = this.checkRouteRBAC(route, ctx.requestContext!)
      if (permissionError) {
        return new Response(JSON.stringify({ error: permissionError.error, message: permissionError.message }), {
          status: permissionError.status,
          headers: { 'content-type': 'application/json' },
        })
      }

      const { urlParams, queryParams, body } = await this.getParams(route, ctx)
      let params: ParsedRequestParams = { urlParams, queryParams, body }

      try {
        params.queryParams = await this.parseQueryParams(route, params.queryParams)
        if (params.body !== undefined || route.bodySchema) params.body = await this.parseBody(route, params.body)
        params.urlParams = await this.parsePathParams(route, params.urlParams)
      } catch (error) {
        if (isZodError(error)) {
          const context = error instanceof Error && 'path' in error ? 'body' : 'query'
          const { status, body: errorBody } = this.resolveValidationError(route, error, context)
          return new Response(JSON.stringify(errorBody), { status, headers: { 'content-type': 'application/json' } })
        }
        return new Response(
          JSON.stringify({ error: 'Invalid request', issues: [{ field: 'unknown', message: String(error) }] }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        )
      }

      const fgaError = await checkRouteFGA(this.mastra, route, ctx.requestContext!, {
        ...params.urlParams,
        ...params.queryParams,
        ...(typeof params.body === 'object' && params.body !== null ? params.body : {}),
      })
      if (fgaError) {
        return new Response(JSON.stringify({ error: fgaError.error, message: fgaError.message }), {
          status: fgaError.status,
          headers: { 'content-type': 'application/json' },
        })
      }

      try {
        const handlerParams: Parameters<typeof route.handler>[0] = {
          ...params.urlParams,
          ...params.queryParams,
          ...(typeof params.body === 'object' && params.body !== null ? params.body : {}),
          requestContext: ctx.requestContext!,
          mastra: ctx.mastra!,
          registeredTools: ctx.registeredTools,
          abortSignal: ctx.abortSignal ?? ctx.request.signal,
          routePrefix: prefix,
          request: ctx.request,
        }
        const result = await route.handler(handlerParams)
        return this.sendResponse(route, ctx, result)
      } catch (error) {
        const custom = getCustomHTTPExceptionResponse(error)
        if (custom) return custom
        const { status, body: errorBody } = getHTTPErrorResponse(error)
        return new Response(JSON.stringify(errorBody), { status, headers: { 'content-type': 'application/json' } })
      }
    }

    switch (route.method) {
      case 'GET':
        this.app.get(normalizedPath, (ctx) => handler(ctx))
        break
      case 'POST':
        this.app.post(normalizedPath, (ctx) => handler(ctx))
        break
      case 'PUT':
        this.app.put(normalizedPath, (ctx) => handler(ctx))
        break
      case 'PATCH':
        this.app.patch(normalizedPath, (ctx) => handler(ctx))
        break
      case 'DELETE':
        this.app.delete(normalizedPath, (ctx) => handler(ctx))
        break
      case 'HEAD':
        this.app.head(normalizedPath, (ctx) => handler(ctx))
        break
      case 'OPTIONS':
        this.app.options(normalizedPath, (ctx) => handler(ctx))
        break
    }
  }
}
