import { handleLibraryApiRequest } from './libraryProxy'

/**
 * Vercel Serverless Function 预打包入口源码
 * 通过 `npm run build:api` (esbuild) 打包生成零外部相对路径依赖的 `api/index.js`
 */
export default async function handler(req: any, res: any) {
  try {
    const rawUrl = String(req.url || '/')
    const parsed = new URL(rawUrl, 'http://localhost')
    const rewrittenPath = parsed.searchParams.get('__path')
    if (rewrittenPath) {
      parsed.searchParams.delete('__path')
      const qs = parsed.searchParams.toString()
      const normalizedPath = rewrittenPath.startsWith('/') ? rewrittenPath : `/${rewrittenPath}`
      req.url = qs ? `${normalizedPath}?${qs}` : normalizedPath
    }
    return await handleLibraryApiRequest(req, res)
  } catch (err: any) {
    res.statusCode = 500
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(
      JSON.stringify({
        ok: false,
        message: err?.message || '服务端函数执行异常',
      })
    )
  }
}
