import { handleLibraryApiRequest } from '../src/server/libraryProxy'

/**
 * Vercel Serverless Function 统一入口（方案 B 全功能在线部署）
 * 配合 vercel.json rewrite 规则，统一接收所有 `/api/*` 请求并转发至 handleLibraryApiRequest
 */
export default async function handler(req: any, res: any) {
  const rawUrl = String(req.url || '/')
  const parsed = new URL(rawUrl, 'http://localhost')
  const rewrittenPath = parsed.searchParams.get('__path')
  if (rewrittenPath) {
    parsed.searchParams.delete('__path')
    const qs = parsed.searchParams.toString()
    const normalizedPath = rewrittenPath.startsWith('/') ? rewrittenPath : `/${rewrittenPath}`
    req.url = qs ? `${normalizedPath}?${qs}` : normalizedPath
  }
  return handleLibraryApiRequest(req, res)
}
