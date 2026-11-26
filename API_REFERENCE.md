# 📡 浙杭借书搭子 (LibraryHelper) 服务端与双馆接口文档

本文档完整梳理并记录「浙杭借书搭子」项目中涉及的所有接口，分为四大部分：
1. **本项目内部代理服务接口（`/api/*`）**：前端与本地 Vite 服务 / Vercel Serverless 通信的统一 JSON 接口；
2. **浙江图书馆（ZJLib）官方上游接口**：基于 `/bff-api` 微服务网关的接口协议、国密 SM2 加密与 3D 书架导航规范；
3. **杭州图书馆（HZLib）官方上游接口**：基于图创 Interlib OPAC 系统的接口协议、RSA 加密、算术验证码识别与馆藏解析规范；
4. **第三方公共配套服务接口**：图书封面中心与百度地图 POI 精准定位接口。

---

## 一、本项目内部代理服务接口（`/api/*`）

实现文件：[src/server/libraryProxy.ts](D:/dev/LibraryHelper/src/server/libraryProxy.ts)、[src/server/vercelEntry.ts](D:/dev/LibraryHelper/src/server/vercelEntry.ts) 与 [api/index.js](D:/dev/LibraryHelper/api/index.js)

### 1.0 版本号与部署环境检测接口
- **路径**：`GET /api/version`（以及 `GET /api/health`）
- **数据来源**：项目根目录 [version.json](D:/dev/LibraryHelper/version.json)
- **功能**：返回当前部署的服务端版本号、更新日期、运行环境（`vercel` / `local`）及 Vercel 机房区域代码（`region`，如 `hkg1`），用于验证线上是否已成功更新到最新版本。
- **返回示例**：
  ```json
  {
    "ok": true,
    "version": "1.0.1",
    "updatedAt": "2026-11-26",
    "description": "升级 upstreamFetch 高可用请求引擎、双域名故障切换与版本检测接口",
    "env": "vercel",
    "region": "hkg1",
    "serverTime": "2026-11-26T01:30:00.000Z"
  }
  ```

### 1.1 杭州图书馆验证码会话初始化
- **路径**：`GET /api/hzlib/captcha`
- **功能**：初始化杭州图书馆 OPAC 登录会话，获取 RSA 公钥、`JSESSIONID` Cookie、图形验证码 Base64 图片及服务端自动 OCR 识别出的算术结果。
- **返回示例**：
  ```json
  {
    "ok": true,
    "sessionCookie": "JSESSIONID=...",
    "captchaImage": "data:image/jpeg;base64,...",
    "autoCode": "12"
  }
  ```

### 1.2 杭州图书馆借阅记录直连同步
- **路径**：`POST /api/hzlib/sync`
- **请求参数**：
  ```json
  {
    "rdid": "读者证号/身份证号/市民卡号",
    "password": "明文密码（由代理层使用会话 PEM 公钥执行 RSA 加密）",
    "captchaCode": "验证码（可选，未传时自动走服务端内置算术 OCR 重试）",
    "sessionCookie": "可选，复用已有会话 Cookie",
    "maxPages": 50
  }
  ```
- **核心处理逻辑**：
  1. 登录成功后全量分页拉取 `currentLoanList`（当前在借）与 `renewList`（提取每本在借图书的精确 `renewCount` 续借次数）；
  2. 全量分页拉取 `historyLoanList`（历史操作流水，按 `hasNextPage` 遍历），将「借书」与「还书」两条流水按 `barcode` 与时间轴配对合并为单条完整借阅记录；
  3. 严格保护当前在借状态，防止历史表中的「借书」流水覆盖在借状态。
- **返回示例**：
  ```json
  {
    "ok": true,
    "records": [/* BorrowRecord[] */],
    "summary": {
      "currentCount": 12,
      "historyCount": 328
    }
  }
  ```

### 1.3 读取最近一次杭图同步缓存
- **路径**：`GET /api/hzlib/latest-cache`
- **功能**：返回服务端内存中最近一次成功同步的杭州图书馆记录快照（供调试或快速恢复使用）。

### 1.4 浙江图书馆微信/支付宝扫码登录
- **路径**：`GET /api/zjlib/qr`
- **查询参数**：
  - 获取二维码：`?type=wechat` 或 `?type=alipay`
  - 轮询扫码状态：`?action=status&uuid={uuid}`
- **返回示例**：
  - 获取二维码：`{ "ok": true, "uuid": "...", "qrUrl": "https://open.weixin.qq.com/..." }`
  - 扫码成功：`{ "ok": true, "scanned": true, "token": "eyJhbGci..." }`

### 1.5 浙江图书馆借阅记录直连同步
- **路径**：`POST /api/zjlib/sync`
- **请求参数**：
  ```json
  {
    "account": "读者证号/手机号/身份证号",
    "password": "明文密码（代理层自动进行 SM2 国密公钥加密）",
    "token": "可选，扫码登录或已缓存的 Bearer Token",
    "maxPages": 30
  }
  ```
- **核心处理逻辑**：
  1. 若未传 `token` 或 `token` 已失效，使用 `sm-crypto` 对密码执行 SM2 加密并调用浙图 SSO 登录获取 `Bearer Token`；
  2. 并发拉取 `myLoans/current-loan`（当前在借，含 `renewCount`）与全量分页 `myLoans/history-loan`（历史借阅）；
  3. 自动过滤浙图默认空白占位封面 URL。

### 1.6 双馆统一在线续借接口
- **路径**：`POST /api/loan/renew`
- **请求参数**：
  ```json
  {
    "library": "zjlib | hzlib",
    "barcode": "图书条码号",
    "account": "浙图账号（可选）",
    "password": "密码（可选，用于会话过期自动重登）",
    "token": "浙图 Bearer Token（可选）",
    "rdid": "杭图读者证号（可选）"
  }
  ```
- **返回示例**：
  ```json
  {
    "ok": true,
    "message": "续借成功！最新应还日期：2026-12-20",
    "dueDate": "2026-12-20",
    "renewCount": 1
  }
  ```

### 1.7 双馆全馆书库在线联查接口
- **路径**：`POST /api/catalog/search`
- **请求参数**：
  ```json
  {
    "keyword": "搜索词（书名/作者/ISBN/同义词如海贼王/卷号如绍宋 卷五）",
    "scope": "all | zjlib | hzlib",
    "branch": "all | zjlib:all | zjlib:{districtId} | hzlib:all | hzlib:{curlibcode} | hzlib:local:{themeName}",
    "onlyAvailable": true,
    "page": 1,
    "rows": 12
  }
  ```
- **核心处理逻辑**：
  1. **智能拆词与同义词映射**：自动识别末尾卷集号（如 `卷5 / 卷五 / 5卷`）拆出主书名扩大召回，并将 `海贼王 / one piece` 映射为图书馆标准正名 `航海王`；
  2. **双馆并发检索与实时在馆预加载**：
     - 浙图：并发调用 `pageList`（书名检索 + 全字段检索），并对命中书目并发拉取 `resourceList` 与之江馆 7 段层架标翻译 `get/shelf/description/map`；
     - 杭图：调用 `/opac/search`（当选择直属主题分馆或卷号过滤时自动自适应翻页扫描最多 5 页以保障召回率），并批量调用 `/opac/book/holdingPreviews` 组装各分馆在馆册数汇总；
  3. **排序规则**：馆藏列表按「在馆优先 > 总馆优先 > 已知地址优先 > 同馆聚合」排序；书目列表按「检索相关性 > 同系列子分类（正篇优先于专题书/总集篇） > 自然卷号顺序」排序。

### 1.8 单本图书实时馆藏状态与架位查询接口
- **路径**：`POST /api/holding/query`
- **请求参数**：
  ```json
  {
    "library": "zjlib | hzlib",
    "bibId": "书目记录号（metaId / workId / bookrecno）",
    "isbn": "ISBN",
    "title": "书名",
    "barcode": "条码号",
    "callNo": "索书号"
  }
  ```
- **功能**：用于「我的借阅详情抽屉」查询实时全馆在馆状态，以及在「在线搜索」中按需点击 **「加载已借阅图书应还时间」** 时拉取杭州图书馆单册级条码、借出日期与应还日期。

### 1.9 批量图书封面解析接口
- **路径**：`POST /api/covers/resolve`
- **请求参数**：
  ```json
  {
    "forceInternet": false,
    "items": [
      { "id": "记录ID", "isbn": "978...", "title": "书名", "author": "作者" }
    ]
  }
  ```
- **三级解析管线**：
  1. 本地持久化缓存（`.cover-cache.json` / 内存缓存）；
  2. 图创官方元数据中心（`book-resource.dataesb.com`），通过 `HEAD` 校验 `content-length` 过滤无封面占位假图（排除长度 `13498`、`37458` 及 `< 2500` 字节图片）；
  3. 百度图片图书封面检索兜底。

### 1.10 百度地图基层分馆 POI 动态定位跳转接口
- **路径**：`GET /api/map/go?q={关键词}&c={城市代码}`
- **功能**：针对未在 `addr/*.json` 中预置固定坐标的基层街道/社区分馆、杭州书房，实时请求百度地图搜索接口解析首个匹配 POI 的 `uid` 与墨卡托坐标 `(x, y)`，并 `302` 重定向至百度地图 17 级比例尺建筑锁定页面。

---

## 二、浙江图书馆（ZJLib）上游官方接口文档

- **网关基准地址**：`https://www.zjlib.cn/bff-api`
- **必传公共请求头**：
  ```http
  Content-Type: application/json
  BFF-ORG-ID: 1916318653650423810
  Authorization: Bearer <token>   # 需登录接口必传
  ```
- **馆区 `districtId` 字典**（维护于 `addr/zjlib_branches.json`）：
  - `1916325141324353538`：之江馆区
  - `1916325244624236545`：曙光路馆区
  - `1960228014308634625`：大学路馆区
  - `1960237529544437762`：孤山路馆区
  - `1960238282716921857`：嘉业堂藏书楼
  - `1953763801877389313`：其他馆区

| 序号 | 接口用途 | 方法与路径 | 关键请求参数 / 说明 |
| :--- | :--- | :--- | :--- |
| 1 | **读者证密码登录** | `POST /reader-sso-service/portal-pc-api/login` | `{ "account": "...", "password": "04 + sm2Encrypt(pwd, pubKey, 1)" }`。SM2 公钥：`0482ddef5f3839bc...`，C1C3C2 模式前补 `04`。返回 `data.token`。 |
| 2 | **微信扫码二维码** | `GET /reader-sso-service/portal-pc-api/login/wechat-qr` | 返回 `{ "data": { "uuid": "...", "qrUrl": "..." } }`。 |
| 3 | **支付宝扫码二维码** | `GET /reader-sso-service/portal-pc-api/login/alipay-qr` | 返回 `{ "data": { "uuid": "...", "qrUrl": "..." } }`。 |
| 4 | **扫码状态轮询** | `GET /reader-sso-service/portal-pc-api/qr/status?uuid={uuid}` | 返回 `data.token` 表示用户已在手机端确认授权。 |
| 5 | **获取当前读者信息** | `GET /reader-sso-service/portal-pc-api/enc/user-info` | 返回 `data.readerId`（续借接口必填参数）。 |
| 6 | **当前在借列表** | `POST /portal-admin-service/portal-pc-api/myLoans/current-loan` | Body: `{}`。返回 `data[]`，含 `title`、`author`、`isbn`、`barcode`、`callNo`、`loanDate`、`dueDate`、`renewCount`、`subLibraryName`、`metaId`。 |
| 7 | **历史借阅分页列表** | `POST /portal-admin-service/portal-pc-api/myLoans/history-loan` | Body: `{ "current": 1, "size": 50 }`。返回 `data.records[]` 与 `data.pages`。 |
| 8 | **图书在线续借** | `POST /portal-admin-service/portal-pc-api/myOrder/batch/renew` | Body: `{ "readerId": "...", "barCodes": ["条码号"] }`。每本书最多可续借 1 次。 |
| 9 | **全馆书目检索** | `POST /search-admin-service/open-api/search/pageList` | Body: `{ "pageNo": 1, "pageSize": 15, "searchList": [{ "key": "title", "value": "关键词" }], "districtIdList": ["馆区ID"] }`。返回 `data.hitList[]`（主键 `id` 即 `workId`）与 `data.AggResult`。 |
| 10 | **书目详情查询** | `POST /portal-admin-service/portal-pc-api/search/getWorkById` | Body: `{ "id": "{workId}", "isSearch": 0 }`。返回题名、责任者、出版社、ISBN 等。 |
| 11 | **单册馆藏状态列表** | `POST /portal-admin-service/portal-pc-api/search/resourceList` | Body: `{ "workId": "{workId}", "pageNo": 1, "pageSize": 200 }`。返回 `data.list[]`：`state === 2`（在馆可借）、`state === 16`（馆内阅览）、`districtId`、`local_name`、`callno`、`barcode`、`duedate`、`shelf_mark`。 |
| 12 | **之江馆层架标翻译** | `POST /portal-admin-service/portal-pc-api/search/get/shelf/description/map` | Body: `{ "shelfMarkList": ["7段层架标前缀"] }`。将 `01-01-01-...` 转换为中文位置（如 `1F综合借阅区第29架B面14列2层`）。 |
| 13 | **之江馆 3D 书架导航** | `GET https://map.zjlib.cn/#/pc` | Query 参数：`callno`、`title`、`subLibraryName=之江馆区`、`locationName`、`shelfMark`（完整原始层架标）、`barcode`、`status`、`creator`、`publisher`。仅当 `districtId === '1916325141324353538'` 且在馆且存在 `shelf_mark` 时有效。 |

---

## 三、杭州图书馆（HZLib）上游官方接口文档

- **OPAC 基准地址**：`https://my1.zjhzlib.cn/opac`
- **会话机制**：基于标准 Servlet `JSESSIONID` Cookie。

| 序号 | 接口用途 | 方法与路径 | 关键请求参数 / 解析说明 |
| :--- | :--- | :--- | :--- |
| 1 | **登录页会话初始化** | `GET /opac/reader/login` | 响应头 `Set-Cookie` 返回 `JSESSIONID`，页面内提取验证码字段名（默认 `returnCode`）。 |
| 2 | **获取 RSA 加密公钥** | `GET /opac/certificate/pem?checkCode={timestamp}opac` | 需携带 `JSESSIONID`。返回 Base64 编码的 RSA 公钥体，包装为 PEM 后采用 `RSA_PKCS1_PADDING` 加密明文密码并转 Base64。 |
| 3 | **获取算术验证码图片** | `GET /opac/validateCodeImage?r={random}` | 需携带 `JSESSIONID`。返回 JPEG 格式算术题图片（如 `7 + 5 = ?`），本项目内置像素连通域与模板特征识别器自动计算结果。 |
| 4 | **提交读者登录** | `POST /opac/reader/doLogin` | `application/x-www-form-urlencoded`：`rdid`、`rdPasswd`（RSA 密文）、`returnUrl=`、`password=`、`returnCode`（算术验证码结果）。当响应 `status === 302` 且 `Location` 包含 `/opac/reader/space` 时表示登录成功。 |
| 5 | **当前在借列表** | `GET /opac/loan/currentLoanList?page={page}&rows=100` | 解析 HTML 表格行，提取 `barcode`、`title`、`author`、`callNo`、`libName`、`location`、`loanDate`、`dueDate` 及 `bookrecno`。 |
| 6 | **历史借还操作流水** | `GET /opac/loan/historyLoanList?page={page}&rows=100` | 解析 HTML 表格行與 `hasNextPage` 分页标志。注意：杭图历史表按「借书」「还书」拆分为两条独立操作流水，须按 `barcode` 与时间先后配对合并。 |
| 7 | **续借列表与令牌获取** | `GET /opac/loan/renewList?page=1&rows=100` | 解析 HTML 中隐藏域 `input[name="pdsToken"]`（一次性防重放令牌）及每本书的官方「续借次数」列。 |
| 8 | **提交图书续借** | `POST /opac/loan/doRenew` | `application/x-www-form-urlencoded`：`pdsToken`、`barcodeList={barcode}`、`furl=/opac/loan/renewList`、`renewAll=`。从响应 HTML `#page_content #content` 提取续借结果文案（每本书最多续借 2 次，每次延长 15 天）。 |
| 9 | **全馆/分馆书目检索** | `GET /opac/search` | Query 参数：`q={关键词}`、`scWay=dim`、`rows=20`、`page={page}`、`sortWay=score`、`sortOrder=desc`、`hasholding=1`、`curlibcode={分馆代码，如 0000 市民中心总馆、1900 上城、1100 西湖等}`。解析 HTML `tr.book_list_row` 提取 `bookrecno`、书名、作者、出版社、ISBN、索书号。 |
| 10 | **批量馆藏在馆预览** | `GET /opac/book/holdingPreviews` | Query 参数：`bookrecnos={逗号分隔的bookrecno列表}`、`curLibcodes=`、`return_fmt=json`。返回 `previews` 字典，包含每个 `bookrecno` 在各分馆（`curlibName`）与借阅室（`curlocalName`）的总册数 `copycount` 与在馆可借册数 `loanableCount`。 |
| 11 | **单书全量单册馆藏明细** | `GET /opac/api/holding/{bookrecno}?limitLibcodes=&isCluster=false` | 返回 JSON：`holdingList[]`（含每本实体书 `barcode`、`callno`、`state`、`curlibName`、`curlocalName`、`shelfno`）、`loanDateMap`（借出日期映射）与 `dueDateMap`（应还日期映射）。 |

---

## 四、第三方公共配套接口

| 序号 | 服务名称 | 接口地址 / URL 格式 | 说明 |
| :--- | :--- | :--- | :--- |
| 1 | **图创图书封面元数据中心** | `GET https://book-resource.dataesb.com/websearch/metares?glc=P1ZJ0571001&cmdACT=getImages&type=0&isbns={isbns}&callback=cb` | JSONP 格式返回对应 ISBN 的官方高清封面 URL `result[].link`。 |
| 2 | **百度图片图书封面检索** | `GET https://image.baidu.com/search/acjson?tn=resultjson_com&ipn=rj&word={书名+作者+图书封面}&pn=0&rn=5` | 当官方封面缺失或为默认占位图时，自动检索互联网封面 `thumbURL / middleURL` 并持久化缓存。 |
| 3 | **百度地图 17 级建筑直达链接** | `https://map.baidu.com/poi/{name}/@{coordX},{coordY},17z?uid={uid}&poiShareUid={uid}&querytype=s&da_src=shareurl&wd={name}&c={cityCode}&info_merge=1&isBizPoi=false` | 使用 `addr/zjlib_branches.json` 与 `addr/hzlib_branches.json` 中核验的 `uid` 与墨卡托坐标（`x/100`, `y/100`），在 PC 端直接锁定 17 级比例尺建筑点位。 |
| 4 | **百度地图 POI 搜索接口** | `GET https://map.baidu.com/?newmap=1&reqflag=pcmap&biz=1&from=webmap&qt=s&wd={关键词}&c={cityCode}` | 供 `/api/map/go` 实时解析未知地址基层分馆/杭州书房的百度地图 `uid` 与 `(x, y)` 坐标。 |
