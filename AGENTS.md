# LibraryHelper Architecture & Development Guide

本文件规范「浙杭借书搭子（LibraryHelper）」项目的架构设计与开发流程，适用于所有 AI 编码助手和团队成员。

## 开发规则

### 1. Git 暂存区保护

- 开始修改前必须检查 `git status --short` 和 `git diff --cached`，识别已暂存文件及内容。
- 默认禁止修改 Git 暂存区：不得执行 `git add`、`git reset`、`git restore --staged` 或其他会更新 index 的操作，除非用户明确要求。
- 文件已有暂存改动时，后续修订只写入工作区并保持为未暂存改动；不得把修订重新加入暂存区，也不得覆盖、回退或重排原有暂存内容。
- 同一文件同时存在暂存和未暂存改动时，保留 `MM` 状态：使用 `git diff --cached` 检查原暂存内容，使用 `git diff` 检查本次未暂存修改。
- 完成修改后再次检查 Git 状态，确保本次修改留在未暂存区，原暂存区内容保持不变。

### 2. 问题定位与修改流程

- 针对修改和定位问题类请求，必须先定位问题根因并给出解决方案，禁止直接修改代码。
- 仅在用户确认方案或明确要求执行代码修改后，才落盘修改代码。

### 3. 双馆借阅数据防错与用户本地资产保护规范

- **借阅记录只增改、禁删除红线**：用户的借阅记录属于客观历史账本，UI 与业务层严禁提供单条借阅记录删除入口。
- **用户本地标记零丢失保障**：用户在本地设置的「借阅结论标记（值得重借/推荐/未读完/踩雷）」「星级评分」「个人分类标签」「读书笔记」「阅读进度」属于核心个人数据资产：
  1. 写入 IndexedDB 前必须剥离 Vue 响应式 `Proxy`（如将数组浅拷贝为纯数组 `[...tags]`），严禁直接将响应式对象传入 `IDBObjectStore.put` 导致 `DataCloneError`；
  2. 必须采用 **「IndexedDB 主存储 + localStorage 书名归一化键值备份」** 双重持久化机制，确保重新全量同步浙图/杭图数据或同名书多次借阅时，历史标记、标签与笔记 100% 自动关联恢复。
- **双馆异构数据清洗与配对规范**：
  1. **杭州图书馆（Interlib OPAC）**：必须全量分页拉取 `currentLoanList` 与 `historyLoanList`（基于 `hasNextPage`），将历史表中的「借书」与「还书」操作流水按条码号与时间轴配对合并为单条借阅记录，且严禁让历史表中的「借书」流水覆盖当前在借图书的 `borrowed` 状态；
  2. **浙江图书馆（BFF API）**：所有请求须携带 `/bff-api` 网关前缀与 `BFF-ORG-ID` 请求头，支持读者证密码（SM2 加密）、微信/支付宝扫码及 Token 同步。

### 4. UI 主线程防阻塞与缓存优先规范（浏览器 60fps 渲染保护）

- **检索与排序索引内存缓存**：
  - 书名与作者的特殊符号剥离、全拼/拼音首字母转换（`pinyinPartsCache`）及中文/阿拉伯数字混合卷号自然排序键（`naturalSortKeyCache`）必须建立内存 `Map` 缓存，严禁在 Vue 渲染周期或每次按键过滤时重复调用高开销分词计算。
- **渐进式异步 I/O 与持久化缓存**：
  - 图书封面补全（`/api/covers/resolve`）必须遵循「优先首屏可见项、后台分批并发、结果持久化写入 IndexedDB 与本地 `.cover-cache.json`」原则，杜绝阻塞首屏列表渲染；
  - 实时馆藏状态与架位查询（`/api/holding/query`）遵循「点击详情按钮按需加载」原则，严禁在列表首屏对所有图书并发发起馆藏请求。

### 5. 架构与功能方案文档沉淀规范

- 每当新增核心功能模块（如个人借阅检索引擎、现场借书查重雷达、馆藏位置与 3D 导航联动、拍书架 AI 识书等）或调整核心数据模型时，须在项目根目录下同步建立或更新对应的本地设计文档（如 `ARCHITECTURE_AND_DESIGN.md`），保持代码实现与文档一致。

### 6. 工程目录分层与设计模式规范

- **目录职责隔离与单文件规模控制**：
  - **Model / 数据与存储层（`src/types/`、`src/services/db.ts`）**：封装纯领域数据结构与本地 IndexedDB 持久化逻辑，严禁耦合视图层 DOM 或 Vue 组件实例；
  - **Utility / 算法引擎层（`src/utils/`）**：封装纯函数形式的拼音转换、符号过滤、相关性权重打分、自然卷号排序与导入脚本解析；
  - **Config / 静态配置数据层（`addr/`）**：存放浙江图书馆（`addr/zjlib_branches.json`）与杭州图书馆（`addr/hzlib_branches.json`）的分馆分类、下拉筛选项、详细门牌地址与百度地图坐标配置；
  - **View / 视图组件层（`src/components/`、`src/App.vue`）**：专注于 PC 端与移动端响应式双排版渲染及用户交互事件派发；
  - **Server / 多馆源代理层（`src/server/libraryProxy.ts`、`src/server/vercelEntry.ts`、`api/index.js`）**：采用策略模式隔离浙江图书馆与杭州图书馆的登录、借阅同步、封面解析与实时馆藏查询接口；
  - **Test / 自动化脚本与测试结果层（`test/automation/`、`test/results/`）**：统一归档自动化测试脚本与测试运行结果产物；
  - 单个源码文件建议控制在 **150 ~ 600 行**以内，上限不超过 **800 行**。

### 7. UI 设计风格与信息展示规范

- **整体气质：整洁、简约、去冗余**：
  - 保持青绿（`teal-700 / emerald-700`）与浅灰白卡片（`bg-white` + `slate-50`）为主的清爽色调；
  - 坚决移除装饰性营销标语、重复图标、引导示例文案及冗余分割线，只保留核心操作入口与关键信息。
- **文案精简与信息零重复红线**：
  - **禁止界面信息重复**：同一字段或含义在同一卡片/区域内只展示一次（如馆藏架位信息与索书号重复时省略重复前缀；开关按钮用颜色直接表达状态，不额外拼接 `(已开启)/(已关闭)`；下拉框去掉多余的 `(含分馆)` 尾缀）；
  - **短标签与单行不换行**：顶部统计按钮、状态徽标、登录方式切换等紧凑控件统一用简短文案并保持单行显示（`whitespace-nowrap`），数量单位统一（如统一显示 `X 册`）。
- **双端响应式布局规范（PC 宽屏 + 移动端/手机预览框）**：
  - 手机预览框模式与真机小屏统一使用移动端专属排版：
    1. **封面与核心信息齐平**：左放大封面 + 右侧核心字段（书名、所属馆与状态、索书号/条码、著者），避免右侧过长导致左侧留白；
    2. **次级信息全宽通栏**：地址（含快捷「地图」「地址」按钮）、出版社、ISBN、借还时间等放在卡片中下部全宽区域展示，充分利用屏幕宽度；
    3. **操作入口与细节默认折叠**：在线书目各分馆实时馆藏列表默认收缩隐藏，点击底部触发栏直接在卡片下方内联展开，不再额外跳转详情抽屉。
- **交互友好与内容可复制**：
  - 所有书目信息、索书号、ISBN、地址与馆藏明细文案均须支持用户自由划选与复制（`select-text`），禁止整卡绑定误触跳转；
  - 地图与地址等辅助动作优先提供直达体验（如「地址」按钮点击即浮层展示并自动复制到剪贴板）；切换搜索模式或筛选保持高度稳定，防止界面跳动与闪烁。
- **详情页按需展示**：
  - 未借阅过的在线检索书目不展示无意义的借还日期、续借、评分/标签/笔记编辑区，状态直接显示为 `未借阅过`。

### 8. 自动化测试与测试结果目录管理规范

- **根目录整洁红线**：严禁在项目根目录或 `public/` 目录下直接生成、存放临时测试脚本、抓包数据或 UI 预览验收截图（如 `.preview-*.png`、`*-verified.png`）。
- **目录分离存放规范**：
  1. **自动化脚本目录（`test/automation/`）**：所有自动化测试脚本、接口联调脚本、浏览器自动化验收脚本统一放置在 `test/automation/` 目录下；
  2. **测试结果目录（`test/results/`）**：所有自动化运行结果、UI 预览截图（如 `.preview-*.png`）、验收对比图与测试报告统一输出并存放在 `test/results/` 目录下（并在 `.gitignore` 中忽略，避免污染代码仓库）。

### 9. Vercel Serverless 在线部署与本地环境一致性规范（防线上 404 / 500 崩溃红线）

本地 `npm run dev` 由 Vite 内置 `esbuild` 在内存中自动打包并运行中间件，而 Vercel 线上环境将前端静态构建与 `api/` Serverless 函数分离运行（Node.js 原生 ESM 环境）。为杜绝「本地正常、线上报错」，必须遵守以下规范：

- **1. 路由与入口文件规范（防 `404 The page could not be found`）**：
  - 在非 Next.js 的 Vite 项目（`framework: "vite"`）中，**严禁**使用 `api/[...path].ts` 动态文件名配合自指重写（`/api/(.*) -> /api/$1`）；
  - 必须使用固定单入口 **`api/index.js`**，并在 `vercel.json` 中通过 `"source": "/api/(.*)" -> "destination": "/api/index?__path=/api/$1"` 转发，在入口函数中解析 `__path` 还原完整 `/api/...` 路径并保留原查询参数。
- **2. 服务端代码预打包规范（防 `500 FUNCTION_INVOCATION_FAILED` 与 ESM/TS/JSON 崩溃）**：
  - **根因背景**：当 `package.json` 含 `"type": "module"` 时，Vercel `@vercel/node` 在原生 Node ESM 下直接编译源码会触发三大致命问题：
    1. `tsconfig.json` 若开启 `"allowImportingTsExtensions": true`，在 `@vercel/node` 强制输出 JS 时会直接报 `TS5096` 编译错误（故 `tsconfig.json` 中严禁开启该项）；
    2. 无后缀的跨目录相对导入（如 `from '../src/server/libraryProxy'`）在原生 Node ESM 下会触发 `ERR_MODULE_NOT_FOUND`；
    3. 无 `with { type: 'json' }` 的 JSON 静态导入（如 `import ... from '../../addr/*.json'`）及 CommonJS 依赖（如 `sm-crypto`）在原生 Node ESM 下会触发 `ERR_IMPORT_ATTRIBUTE_MISSING` 或默认导出兼容报错。
  - **强制预打包要求**：任何对 `src/server/*` 或 `addr/*.json` 的修改，必须通过 `npm run build:api`（已集成在 `npm run build` 中）使用 `esbuild` 将 `src/server/vercelEntry.ts` 及其所有本地依赖、JSON 配置与第三方库预打包为单文件自包含的 **`api/index.js`**（注入 `createRequire(import.meta.url)` 兼容 CJS 模块），并在本地通过 `node --input-type=module` 实测验证。
- **3. Serverless 运行时环境与网络规范**：
  - **只读文件系统兜底**：Serverless 环境除 `/tmp`（`os.tmpdir()`）外均为只读文件系统，任何缓存文件读写（如 `.cover-cache.json`）必须具备 `os.tmpdir()` 与内存缓存双重降级兜底，严禁因文件写入失败抛未捕获异常；
  - **请求体兼容读取**：Vercel 函数中 `req.body` 可能已被平台预解析为对象或字符串，`readJsonBody(req)` 必须优先读取已解析的 `req.body`，再回退到流式 `req.on('data')`；
  - **亚太近邻节点与免费版单区域限制**：由于上游浙图/杭图服务器位于杭州，`vercel.json` 必须指定 `"regions": ["hkg1"]`（香港节点）以降低跨国请求延迟；注意 Vercel Hobby（免费版）仅允许配置 **1 个** 区域，严禁在 `regions` 数组中配置多个区域导致部署被拒；
  - **前后端异常 JSON 兜底**：服务端入口必须包含全局 `try / catch` 并返回标准 JSON 错误结构，前端 `fetch('/api/*')` 必须使用安全的 `parseJsonSafe` 解析响应文本，避免非 JSON 报错信息掩盖真实 HTTP 状态码。

### 10. 公网多用户隔离与安全防护规范（防串号、防明文泄漏、防盗刷红线）

当项目部署于公网服务器或 Vercel 多人共用实例时，必须严格遵守以下安全与隔离红线：

- **1. 服务端用户状态零驻留（严禁进程级用户会话/数据全局变量）**：
  - 严禁在 `src/server/*` 模块顶层定义任何缓存用户借阅列表、读者证号、Cookie（如 `JSESSIONID`）或登录 Token 的全局变量，防止 Serverless 热容器或多用户并发请求时发生跨用户串号与隐私泄漏；
  - 所有用户会话凭证（如浙图 `lh_zjlib_token`、杭图 `lh_hzlib_cookie`）必须 100% 由用户各自浏览器本地持有，并在同步/续借请求时按次随请求体传入，退出或清空本地数据时同步清除。
- **2. 密码浏览器端前置加密与本地混淆存储（后端零明文密码接触）**：
  - 用户密码必须在浏览器本地通过 `src/utils/cryptoAuth.ts` 完成加密（浙江图书馆使用 `encryptZjlibPasswordClient` SM2 公钥加密；杭州图书馆通过 `/api/hzlib/captcha?mode=init` 获取当次会话公钥后使用 `encryptHzlibPasswordClient` RSA PKCS#1 v1.5 公钥加密）；
  - 前端发往 `/api/*` 的网络请求只允许传输加密后的密文 `encryptedPassword`，严禁在请求体中传输明文 `password`；
  - 浏览器 `localStorage` 保存读者证凭证时必须通过 `saveCredentialToStorage` / `encodeLocalSecret` 进行混淆编码，严禁在 `localStorage` 中直接暴露明文 `password` 字段。
- **3. 统一 API 安全网关防护（防 CDN 误缓存、CSRF、SSRF 与恶意刷量）**：
  - **强防缓存与安全响应头**：所有 `/api/*` 响应必须统一设置 `Cache-Control: no-store, no-cache, must-revalidate, private`、`Pragma: no-cache`、`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`，严禁任何 CDN 或正向代理缓存接口响应；
  - **跨站请求拦截（CSRF）与请求体大小硬限制**：所有 `POST /api/*` 必须校验 `Sec-Fetch-Site`（拒绝 `cross-site`）与 `Origin/Host` 同源性；`readJsonBody` 必须限制最大请求体不超过 **256 KB**（超限返回 `413`）；
  - **按客户端 IP 滑动窗口限流**：认证/同步/续借/验证码类接口单 IP 限制 **25 次/分钟**，检索/馆藏/封面类接口单 IP 限制 **80 次/分钟**（超限返回 `429`）；
  - **公共封面缓存安全与 SSRF 拦截**：服务端 `coverMemoryCache` 必须使用 `Object.create(null)` 防原型链污染并限制最大容量（**3000 条**），持久化写入 `.cover-cache.json` 必须使用异步串行锁 + `.tmp` 原子替换；任何外部封面 URL 必须经过 `isSafePublicHttpUrl` 校验，拦截非 `http(s):` 协议及本地/内网/云元数据 IP；
  - **线上可观测性与严格脱敏日志红线（Zero-PII Logging）**：
    1. 每个 `/api/*` 请求必须生成唯一短追踪号 `reqId`（写入 `X-Request-Id` 响应头与报错消息尾标 `[vX.Y.Z · region#reqId]`）；
    2. 服务端错误日志（`console.error`）与内存诊断环形缓存（`/api/health?probe=1` 返回的 `recentErrors`）**只允许记录脱敏后的系统级诊断元数据**（`reqId`、`route`、`version`、`region`、`upstreamHost`、`errorCode`、`durationMs` 及经 `sanitizeDiagnosticText` 脱敏的错误摘要），**严禁打印客户端 IP、读者证号、身份证号、密码/密文、Token、Cookie、条码或 `req.body`**。

### 11. 流量节约、图片压缩与构建拆包规范（防流量浪费与大包重下红线）

- **1. 封面图片缩略图降采样与按需高清加载**：
  - 列表卡片、抽屉小图、查重列表中的所有图书封面 `<img>` 必须调用 `toThumbnailCoverUrl(url, width, height)` 转换为轻量缩略图（如将百度图源限制为 `w=220&h=300&fmt=auto` 自动启用 WebP 压缩），并统一声明 `loading="lazy" decoding="async" referrerpolicy="no-referrer"`；
  - 仅在用户主动点击封面触发全屏放大预览时，才加载原始高清大图 URL。
- **2. 列表渐进式定额渲染与可见范围封面补全**：
  - 本地借阅列表首屏默认定额渲染前 **36 条**（通过「加载更多」按批追加，搜索与筛选仍实时匹配全量数据），严禁一次性将数百条记录的 DOM 与图片节点全量挂载；
  - 后台封面补全（`resolveMissingBookCovers`）只允许针对**当前已渲染在页面可见列表中的缺失封面记录**发起 `/api/covers/resolve`，严禁在首屏加载时一次性轮询全表所有历史记录；
  - 公开无状态的书目检索（`/api/catalog/search`）与馆藏查询（`/api/holding/query`）启用 **45 秒 TTL** 的服务端公共只读微缓存，减少多用户重复查询同一热门书目时的上游请求与流量。
- **3. Vite 依赖拆包持久化缓存与静态目录瘦身**：
  - `vite.config.ts` 必须通过 `manualChunks` 将体积较大的第三方库（`pinyin-pro`、`sm-crypto`、`vue` + `lucide-vue-next`）拆分为独立的 vendor chunk，确保日常修改业务代码发版时用户浏览器直接复用 vendor 缓存，主业务包 gzip 体积控制在 **60 KB** 以内；
  - `public/` 目录只允许存放前端页面实际引用的必要静态资源并保持压缩精简，严禁将测试截图或未引用图片留在 `public/` 中随 `dist/` 发布。

### 12. 版本号管理与前后端一致性核验规范（`version.json`）

- **单一版本真理源（`version.json`）**：项目根目录的 `version.json`（含 `version`、`updatedAt`、`description`）是前端顶部导航栏版本徽标（`vX.Y.Z`）与后端 `/api/version`、`/api/health` 接口的唯一数据源。
- **修改必更版本号红线**：
  1. 每次完成功能迭代、Bug 修复、安全加固或性能优化准备提交/部署前，必须同步递增 `version.json` 中的 `version`（遵循语义化版本号 `MAJOR.MINOR.PATCH`），并更新 `updatedAt` 日期与简明的 `description` 变更说明；
  2. 修改 `version.json` 后必须执行 `npm run build`（或 `npm run build:api`），确保最新版本号同步编译进 `api/index.js` 与前端 `dist/` 产物，从而可通过页面顶部版本号和 `/api/version` 接口直观确认线上部署是否已生效。
