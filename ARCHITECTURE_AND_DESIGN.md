# 浙杭借书搭子（LibraryHelper）系统架构与技术设计文档

## 1. 系统定位与核心痛点解决

针对**浙江图书馆**与**杭州图书馆（含各区县通借通还体系）**个人借阅记录分散、杭图历史借阅无搜索、书名含特殊符号难以检索、跨馆重复借阅易踩坑等痛点，提供一套 **PC 端与移动端自适应（支持离线 IndexedDB 存储）** 的个人借阅管理与检索引擎。

## 2. 目录分层结构（MVC + 多源策略模式）

- `src/types/library.ts`：领域模型定义（`BorrowRecord`、`BookAggregatedGroup`、`VerdictType`、`SyncMeta`）。
- `src/services/db.ts`：本地持久化层（`LibraryHelperDB` IndexedDB + `localStorage` 书名归一化键值双备份 + `toPlainRecord` 剥离 Vue Proxy 防 `DataCloneError`）。
- `src/utils/search.ts`：检索引擎与排序核心（特殊符号剥离、全拼/首字母索引缓存、相关性分层权重打分、中文/阿拉伯数字卷号自然序排序、跨馆同名图书聚合）。
- `addr/zjlib_branches.json` & `addr/hzlib_branches.json`：独立外置的浙江图书馆与杭州图书馆分馆配置文件（包含分馆分类、下拉筛选项 `dropdownOptions`、别名匹配词 `aliases`、详细门牌地址 `address`、百度地图核验 `uid/x/y` 墨卡托坐标与馆区排序优先级 `priority`），支持直接人工编辑扩展。
- `src/utils/mapLink.ts`：读取 `addr/*.json` 配置，提供分馆地址解析、下拉选项匹配、馆区优先级排序及百度地图/手机地图精准跳转。
- `src/utils/browserScripts.ts`：双馆网页端一键导出脚本与通用 JSON/HTML 解析器。
- `src/components/BorrowBookCard.vue`：PC 宽屏横向卡片与移动端（左大图 + 右侧结构化字段环绕 + 底部浅灰时间与详情导航栏）双排版组件。
- `src/components/RecordDetailDrawer.vue`：图书详情、封面全屏预览、页内实时馆藏架位查询与个人标记/标签/笔记编辑抽屉。
- `src/components/DedupCheckModal.vue`：现场借书查重防坑雷达（支持 ISBN 扫码与拼音/书名秒查）。
- `src/components/SyncImportModal.vue`：双馆在线同步（杭图 RSA + 验证码会话、浙图 SM2 密码 / 微信支付宝扫码 / Token）与文件导入备份中心。
- `src/server/libraryProxy.ts` & `api/[...path].ts`：本地 Vite 开发/预览中间件（`configureServer` + `configurePreviewServer`）与 Vercel Serverless Functions（`handleLibraryApiRequest`）双模适配代理层，封装杭图 OPAC、浙图 BFF API、三级图书封面解析管线与实时馆藏架位查询接口。

## 3. 核心算法与机制

### 3.1 特殊符号过滤与相关性优先检索
1. **符号剥离（`stripSpecialSymbols`）**：索引与查询时自动剔除 `·`、`：`、`．`、`“”`、`《》`、`——` 等特殊符号，使 `hlbt`、`halibote`、`哈利波特` 均可精准命中《哈利·波特...》。
2. **相关性权重分层（`getSearchRelevanceScore`）**：
   - Tier 0 (`0~99`)：书名完全精确匹配（含全拼/首字母完全一致）；
   - Tier 1 (`100~199`)：书名首字/前缀匹配（名称首字对应上的优先排在最前）；
   - Tier 2 (`200~299`)：书名包含匹配（匹配位置越靠前越优先）；
   - Tier 3 (`300~399`)：作者匹配；
   - Tier 4 (`400+`)：索书号、分馆、标签、笔记匹配。

### 3.2 同系列聚拢与自然卷号排序（`getTitleNaturalSortKey`）
- 自动将中文卷号（`一~十`、`壹~拾`、`上/中/下`）与阿拉伯数字统一转换为 6 位零填充数字（如 `000001` ~ `000090`），提取系列主书名拼音前缀，确保《盗墓笔记．壹~捌》《航海王．卷一~卷九十》严格按自然卷序排列。

### 3.3 三级图书封面自动补全（`/api/covers/resolve`）
1. **Tier 1**：图创/杭图官方元数据封面中心（`book-resource.dataesb.com` 批量接口）；
2. **Tier 2**：浙江图书馆官方封面接口（`getCoverImageByIsbn`，自动过滤默认无图占位 Hash）；
3. **Tier 3**：互联网图书封面检索兜底（针对未收录封面的新书与漫画），结果持久化写入本地 `.cover-cache.json` 与浏览器 `IndexedDB`。

### 3.4 双馆在线续借与续借次数同步机制（`/api/loan/renew`）
1. **浙江图书馆（最多续借 1 次）**：
   - 同步时直接读取 `myLoans/current-loan` 中的 `renewCount`；
   - 续借时调用 `POST /bff-api/portal-admin-service/portal-pc-api/myOrder/batch/renew`，自动复用本地 Token 或已保存的 SM2 加密读者证密码并在续借后回写最新 `dueDate` 与 `renewCount`。
2. **杭州图书馆（最多续借 2 次，15天/次）**：
   - 同步与续借前请求 `GET /opac/loan/renewList?page=1&rows=100`，精确提取每本在借书的官方「续借次数」列及一次性防重放令牌 `pdsToken`；
   - 续借时携带 `pdsToken`、`barcodeList`、`furl=/opac/loan/renewList` 请求 `POST /opac/loan/doRenew`，从 `#page_content #content` 提取杭图官方操作提示，并重新读取 `renewList` 更新本地 `dueDate` 与 `renewCount`。

### 3.5 浙江图书馆 2D/3D 书架精准定位（`/api/holding/query` + `map.zjlib.cn`）
- 严格对齐浙图官方校验逻辑：仅当分册当前所属馆区为 **「之江馆区」**（`districtId === '1916325141324353538'`）且状态为在馆（`state` 为 `2` 或 `16`）且含智能书架层架标（`shelf_mark`）时，才提取 7 段前缀调用 `POST /bff-api/portal-admin-service/portal-pc-api/search/get/shelf/description/map` 转换为中文精确位置（如 `1F综合借阅区第29架B面14列2层第19位`），自动过滤异地归还到曙光路等馆区的残留旧架标；
- 自动拼接包含 `callno`、`title`、`shelfMark`、`barcode`、`creator`、`publisher` 的直达 URL，仅在存在有效之江馆架位时显示 **`打开之江馆3D书架导航(xxxx具体位置)`** 按钮，点击后直接在之江馆 3D 导览图中高亮目标书架并定位到具体列、层、位。

### 3.6 图书馆地理位置地图一键导航（`src/utils/mapLink.ts`）
- 内置经全网与百度地图官方 POI 核实的 **「浙江图书馆 5 大馆区 + 杭州图书馆市民中心总馆 + 16 个专业主题分馆 + 13 个区县（市）总馆」** 精确门牌地址、百度地图 `uid` 与墨卡托坐标字典；
- **PC 宽屏端**：
  - 已知总馆/专业分馆直接生成带完整初始化指令（`poiShareUid` + `querytype=s`）的百度地图 **17 级街道比例尺** 精准建筑详情页 URL（`https://map.baidu.com/poi/{name}/@{x},{y},17z?uid={uid}&poiShareUid={uid}&querytype=s&da_src=shareurl&wd={name}&c={cityCode}`），打开即触发百度地图 `revertPoiShareUid` 锁定目标场馆建筑并展开详细地址与路线导航卡片；
  - 针对基层街道/社区分馆、杭州书房及邻里阅读空间（如 `网易蜗牛读书馆`、`望江街道杭州书房` 等），通过本地代理 `/api/map/go` 实时调用百度地图 POI 接口解析首个匹配点位坐标并 302 直达 17 级建筑定位页；
- **移动端**：真机环境通过 `geo:0,0?q=...` 唤起系统默认地图软件（高德/百度/腾讯地图），移动预览环境下打开移动端地图导航页。

### 3.7 首页双馆全量书目在线联查（`/api/catalog/search` + `OnlineCatalogSection.vue`）
- 在首页搜索区支持一键切换 **「📚 搜我的借阅」** 与 **「🌐 在线搜浙图/杭图全馆书库」**（支持双馆联查、仅浙江图书馆、仅杭州图书馆）；
- **匹配度与自然卷号排序**：浙图检索并发请求 `key: "title"`（书名优先）与全字段检索，双馆结果按「书名完全匹配 > 书名首字前缀匹配 > 书名包含 > 作者/ISBN匹配 + 同系列自然卷号排序（卷1, 2, 3 / 壹, 贰, 叁）」统一聚合；
- **卷/集/数字模糊搜索与智能拆词召回**：同时在本地检索引擎（`src/utils/search.ts`）与在线全馆检索（`src/server/libraryProxy.ts`）中支持「中文数字 ↔ 阿拉伯数字」与「卷/集/册/部等前后语序」归一化（如 `卷5`、`卷五`、`5卷`、`五卷`、`5集`、`五集` 互通匹配）；在线检索遇到此类查询时自动拆出主书名向图书馆扩大召回，并在本地二次过滤保留目标卷号；
- **默认只看有书 + 按分馆下拉过滤**：批量核验浙图 `resourceList` 与杭图 `/opac/book/holdingPreviews` 实时在馆册数，默认开启 `🟢 只看有书` 过滤掉无在馆可借册数的书目，并提供与本地借阅排版一致的分馆下拉框（支持指定浙图各馆区及杭图全部馆区/直属分馆/13区县馆）；
- **在线书目卡片改版与内联展开馆藏**：卡片采用左封面大图 + 右侧结构化字段（书名、所属图书馆与在馆/借阅状态、图书馆地址与地图/地址复制按钮、索书号、著者、出版社、ISBN），全文案支持自由划选复制；搜索接口直接返回按「在馆优先 + 总馆优先（浙图曙光路/之江优先、杭图市民中心总馆优先）」排序的 `holdings` 数据，卡片主地址自动对应第一个在馆有书的馆区，点击底部「查看各分馆在馆状态 / 地图位置 / 3D书架导航」即可 0 等待秒开展开（杭图汇总模式下支持按需点击加载单册条码与应还日期），点击「地址」按钮可弹出详细地址浮层并自动复制到剪贴板。

### 3.8 双模式独立搜索状态与历史记录管理（`lh_search_history_local_v1` / `lh_search_history_online_v1`）
- 「📚 搜我的借阅」与「🌐 在线搜浙图/杭图全馆书库」拥有各自独立的搜索框状态（`localSearchQuery` / `onlineSearchQuery`）与独立的最近 **10 条** 搜索历史记录，切换 Tab 使用 `v-show` 保留已加载列表与展开状态，互不干扰、不重复触发请求；
- 点击或聚焦搜索框自动展开下拉历史面板，支持点击历史词一键回填并触发检索、单条删除及一键清空全部历史。

### 3.9 同账号超期历史永久保留与本地备份账号核对机制（`src/services/db.ts` + `SyncImportModal.vue`）
- **超期历史永久保留（永不丢失早期账本）**：
  - 针对浙图/杭图服务器仅保留近期（如近 2 年）历史借阅的限制，`upsertRecords` 按记录 ID 增量合并并绑定读者账号 `account`；
  - 同账号下的本地早期历史记录（不在服务器本次返回列表内的数据）**100% 永久保留在本地 IndexedDB**，并在本地曾为 `borrowed` 但服务器最新在借列表已无该条码时自动闭合为 `returned`；
- **本地导入/导出与账号一致性校验**：
  - 同步弹窗提供第 3 个 Tab **「💾 本地导入/导出」**，导出 JSON 备份时自动写入 `accounts: { hzlibAccount, zjlibAccount }` 与每条记录的 `account` 标识；
  - 导入本地 JSON 备份时强制比对备份文件中的账号与当前本地绑定账号：若账号不一致则直接拒绝导入并提示冲突账号，防止不同读者的借阅数据混入。

### 3.9 多用户无状态会话隔离与浏览器端密码前置加密（`src/utils/cryptoAuth.ts`）
- **服务端零用户全局状态**：移除服务端进程级共享的杭图同步结果缓存与 `JSESSIONID` 会话变量，每个用户的浙图 `BFF-USER-TOKEN` 与杭图 `sessionCookie`（`lh_hzlib_cookie`）100% 由各自浏览器本地持有并按次随请求携带，彻底杜绝 Vercel Serverless 热实例在多用户并发使用时的串号与数据泄漏；
- **密码加密前移至浏览器端**：浙江图书馆密码在浏览器本地通过 `encryptZjlibPasswordClient`（SM2 公钥加密）转为密文，杭州图书馆密码在浏览器本地通过 `/api/hzlib/captcha?mode=init` 预获取当次会话公钥后由 `encryptHzlibPasswordClient`（纯 `BigInt` 实现的标准 RSA PKCS#1 v1.5 公钥加密）转为密文，发往 `/api/*` 后端的网络请求仅传输 `encryptedPassword` 密文，且本地 `localStorage` 凭证通过 `encodeLocalSecret` 混淆存储，避免明文密码在网络请求与本地存储中裸露。
- **公网部署与多用户高并发安全加固（`src/server/libraryProxy.ts`）**：
  1. **API 安全响应头与防 CDN 误缓存**：所有 `/api/*` 统一注入 `Cache-Control: no-store, no-cache, must-revalidate, private`、`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`，防止 CDN 或反向代理缓存 `JSESSIONID` 或二维码状态；
  2. **跨站请求防护（CSRF）与请求体大小上限**：对 `POST /api/*` 校验 `Sec-Fetch-Site` 与 `Origin/Host` 同源性（拦截跨站 `403`），并对 `readJsonBody` 实施 **256 KB** 硬上限（超限返回 `413`）；
  3. **基于客户端 IP 的滑动窗口限流**：认证/同步/续借/验证码类接口限制单 IP **25 次/分钟**，检索/馆藏/封面类接口限制单 IP **80 次/分钟**（超限返回 `429`）；
  4. **封面缓存并发原子写与 SSRF 防护**：`coverMemoryCache` 采用无原型对象（防原型链污染）并限制最大 **3000 条** 容量，写入 `.cover-cache.json` 采用异步串行锁 + `.tmp` 原子替换；上游 TLS 证书仅对特定旧系统域名放宽，并对封面 URL 实施公网 `http(s)` 与内网 IP 黑名单过滤；
  5. **零敏感信息脱敏诊断日志与 `/api/health?probe=1` 上游连通探测**：每个请求生成 `reqId`（`X-Request-Id`），异常经 `sanitizeDiagnosticText` 严格剥离任何凭证/证号/Token/长串字符后写入最近 30 条内存环形缓冲区与 `console.error`，支持通过 `/api/health?probe=1` 实时探测浙图/杭图双域名延迟与查看最近脱敏错误列表；公开无状态检索/馆藏查询启用 **45 秒** 微缓存。
