/**
 * Bridge a Web Standard Request into Vite's Connect middlewares and back.
 *
 * Elysia (Bun.serve) speaks Request/Response, while Vite's dev middlewares
 * expect Node's IncomingMessage/ServerResponse. This lets Vite run in
 * middlewareMode inside the same Elysia instance as Mastra — one process, one
 * port, with HMR intact.
 */
import { toFetchResponse, toReqRes } from 'fetch-to-node'

type ConnectMiddleware = (req: any, res: any, next: (error?: unknown) => void) => void

export async function callViteMiddleware(
  middleware: ConnectMiddleware,
  request: Request,
): Promise<Response | undefined> {
  const { req, res } = toReqRes(request)
  ;(req as any).originalUrl = request.url

  const unhandled = new Promise<undefined>((resolve, reject) => {
    middleware(req, res, (error) => {
      if (error) {
        reject(error)
      } else if (!res.writableEnded && !res.headersSent) {
        resolve(undefined)
      }
    })
  })

  return Promise.race([toFetchResponse(res), unhandled])
}
