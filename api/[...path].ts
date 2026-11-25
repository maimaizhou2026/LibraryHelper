import { handleLibraryApiRequest } from '../src/server/libraryProxy'

/**
 * Vercel Serverless Function 统一入口（方案 B 全功能在线部署）
 * 自动转发所有 `/api/*` 请求（浙图/杭图全馆在线检索、账号直连同步、续借、3D导航、百度地图跳转与封面补全）
 */
export default async function handler(req: any, res: any) {
  return handleLibraryApiRequest(req, res)
}
