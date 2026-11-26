/**
 * 浙杭借书搭子 (LibraryHelper) 核心功能自动化回归与验收测试套件
 * 运行方式: npm test (或 node test/automation/regressionSuite.mjs)
 * 测试报告输出目录: test/results/regression-report.json & test/results/regression-report.md
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(__dirname, '../..')
const RESULTS_DIR = path.join(ROOT_DIR, 'test', 'results')

async function loadTsModule(relPath) {
  const entry = path.join(ROOT_DIR, relPath)
  const res = await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    write: false,
  })
  const code = res.outputFiles[0].text
  const dataUrl = `data:text/javascript;base64,${Buffer.from(code, 'utf8').toString('base64')}`
  return import(dataUrl)
}

function invokeApi(handler, { method = 'GET', url = '/api/version', headers = {}, body = undefined }) {
  return new Promise((resolve, reject) => {
    const reqHeaders = {
      host: 'localhost:5173',
      origin: 'http://localhost:5173',
      'content-type': 'application/json',
      'x-forwarded-for': '127.0.0.1',
      ...headers,
    }
    const req = {
      method,
      url,
      headers: reqHeaders,
      body,
      socket: { remoteAddress: '127.0.0.1' },
      on(event, cb) {
        if (event === 'end') cb()
      },
    }
    const resHeaders = {}
    const res = {
      statusCode: 200,
      setHeader(k, v) {
        resHeaders[String(k).toLowerCase()] = v
      },
      getHeader(k) {
        return resHeaders[String(k).toLowerCase()]
      },
      end(payload = '') {
        let json = null
        try {
          json = payload ? JSON.parse(payload) : null
        } catch {
          json = null
        }
        resolve({
          status: this.statusCode,
          headers: resHeaders,
          text: String(payload || ''),
          json,
        })
      },
    }
    Promise.resolve(handler(req, res)).catch(reject)
  })
}

async function runSuite() {
  const startedAt = Date.now()
  await fs.mkdir(RESULTS_DIR, { recursive: true })

  const versionJson = JSON.parse(await fs.readFile(path.join(ROOT_DIR, 'version.json'), 'utf8'))
  const searchMod = await loadTsModule('src/utils/search.ts')
  const mapMod = await loadTsModule('src/utils/mapLink.ts')
  const cryptoMod = await loadTsModule('src/utils/cryptoAuth.ts')
  const demoMod = await loadTsModule('src/data/demoRecords.ts')
  const apiMod = await import(pathToFileURL(path.join(ROOT_DIR, 'api', 'index.js')).href)
  const apiHandler = apiMod.default

  const results = []
  async function testCase(suite, name, fn) {
    const t0 = Date.now()
    try {
      const detail = await fn()
      const elapsedMs = Date.now() - t0
      results.push({ suite, name, status: 'PASS', elapsedMs, detail: detail || '' })
      console.log(`✅ [PASS] [${suite}] ${name} (${elapsedMs}ms)`)
    } catch (err) {
      const elapsedMs = Date.now() - t0
      results.push({
        suite,
        name,
        status: 'FAIL',
        elapsedMs,
        error: err?.message || String(err),
      })
      console.error(`❌ [FAIL] [${suite}] ${name}: ${err?.message || err}`)
    }
  }

  // ==================== Suite 1: 检索引擎、拼音容错与自然卷号排序 ====================
  await testCase('Search & Sort', '特殊符号剥离与拼音/首字母检索 (halibote / hlbt -> 哈利·波特)', () => {
    const sample = [
      {
        id: '1',
        library: 'hzlib',
        subLibrary: '杭州图书馆',
        status: 'borrowed',
        title: '哈利·波特魔法图鉴',
        author: 'J. K. 罗琳',
        isbn: '9787020192281',
        callNo: 'I561/1',
        barcode: 'HZ001',
        loanDate: '2026-11-01',
        dueDate: '2026-12-10',
        returnDate: '',
        rating: 5,
        verdict: 'liked',
        tags: ['科幻'],
        note: '',
        progress: 50,
        updatedAt: Date.now(),
      },
    ]
    for (const q of ['哈利波特', 'halibote', 'hlbt', 'hlbtmf']) {
      const matched = searchMod.filterAndSortRecords(sample, {
        query: q,
        library: 'all',
        status: 'all',
        verdict: 'all',
        tag: '',
        year: '',
        onlyMultiBorrowed: false,
        sortField: 'title',
        sortOrder: 'asc',
      })
      assert.equal(matched.length, 1, `搜索词 "${q}" 应命中《哈利·波特魔法图鉴》`)
    }
    return '支持符号穿透与全拼/首字母匹配'
  })

  await testCase('Search & Sort', '同义译名检索 (海贼王 / hzw -> 航海王) 及子系列隔离排序', () => {
    const titles = [
      '航海王．幽灵岛．卷五十一，11名超新星',
      '航海王：专题书．第1卷',
      '航海王．砂之国．卷十三，不要紧',
      '航海王．总集篇．第8卷，空中圣地',
      '航海王．卷三，不须隐瞒的事',
      '航海王．卷一，冒险的序幕',
    ]
    const sorted = [...titles].sort(searchMod.compareTitlesNaturally)
    assert.deepEqual(sorted, [
      '航海王．卷一，冒险的序幕',
      '航海王．卷三，不须隐瞒的事',
      '航海王．砂之国．卷十三，不要紧',
      '航海王．幽灵岛．卷五十一，11名超新星',
      '航海王：专题书．第1卷',
      '航海王．总集篇．第8卷，空中圣地',
    ])
    return '正传卷号严格递增且专题书/总集篇独立聚合'
  })

  await testCase('Search & Sort', '无显式卷号副标题视同第1本 + 中文大写数字卷号自然排序', () => {
    const sailei = [
      '赛雷三分钟漫画西游记．15，玉兔精 第八十一难 五圣成真',
      '赛雷三分钟漫画西游记．石猴出世 齐天大圣 搅乱蟠桃会',
      '赛雷三分钟漫画西游记．2，大闹天宫',
    ].sort(searchMod.compareTitlesNaturally)
    assert.equal(sailei[0], '赛雷三分钟漫画西游记．石猴出世 齐天大圣 搅乱蟠桃会')
    assert.equal(sailei[1], '赛雷三分钟漫画西游记．2，大闹天宫')
    assert.equal(sailei[2], '赛雷三分钟漫画西游记．15，玉兔精 第八十一难 五圣成真')

    const shaosong = ['绍宋．拾', '绍宋．叁', '绍宋．壹', '绍宋．贰', '绍宋．4'].sort(
      searchMod.compareTitlesNaturally
    )
    assert.deepEqual(shaosong, ['绍宋．壹', '绍宋．贰', '绍宋．叁', '绍宋．4', '绍宋．拾'])
    return '无集数首册排第1 & 壹/贰/叁/4/拾自然序通过'
  })

  await testCase('Search & Sort', '查重雷达跨馆去重聚合与续借次数计算规则', () => {
    const demoRecords = demoMod.DEMO_BORROW_RECORDS.map((r, i) => ({
      ...r,
      id: `demo_${i}`,
      tags: r.tags || [],
    }))
    const dedup = searchMod.checkBookDuplicate(demoRecords, '猜猜我有多爱你')
    assert.equal(dedup.state, 'previously_borrowed')
    const caicai = dedup.matchedGroups[0]
    assert.ok(caicai && caicai.totalBorrows === 2 && caicai.libraries.length === 2)

    assert.equal(
      searchMod.getEffectiveRenewCount({
        library: 'hzlib',
        status: 'borrowed',
        loanDate: '2026-11-07',
        dueDate: '2027-01-16',
      }),
      2
    )
    assert.equal(searchMod.getMaxRenewLimit({ library: 'hzlib' }), 2)
    assert.equal(searchMod.getMaxRenewLimit({ library: 'zjlib' }), 1)
    return '跨馆聚合与浙图(1次)/杭图(2次)续借计算准确'
  })

  // ==================== Suite 2: 双分辨率封面 URL 转换引擎 ====================
  await testCase('Cover URL Engine', '列表轻量小图 (toThumbnailCoverUrl) 与点击高清大图 (toHighResCoverUrl)', () => {
    const jdUrl =
      'https://img13.360buyimg.com/n0/jfs/t1/123456/3/34451/183919/6381d991Ec0065099/9ffc7475cfcb8f27.jpg'
    const thumbJd = searchMod.toThumbnailCoverUrl(jdUrl, 180, 250)
    const hdJd = searchMod.toHighResCoverUrl(jdUrl)
    assert.ok(
      thumbJd.includes('/n1/jfs/') && !thumbJd.includes('s180x250'),
      '京东列表缩略图应使用 /n1/ 保持 1:1 比例，避免放大时与 /n0/ 发生比例错位'
    )
    assert.ok(hdJd.includes('/n0/jfs/'), '点击放大应使用 /n0/jfs/ 800x800 高清原图')

    const legacyStitched =
      'https://book-resource.dataesb.com/cover/kaicai/20241108/5a722c8cbfc84f8d82994eeea45e735d.jpeg#hd=' +
      encodeURIComponent('https://img1.baidu.com/it/u=1,2&fm=253&fmt=auto')
    assert.equal(
      searchMod.toThumbnailCoverUrl(legacyStitched),
      searchMod.toHighResCoverUrl(legacyStitched),
      '禁止跨源拼接 #hd= 导致缩略图与放大图出现两张不同图片'
    )

    const bdUrl = 'https://img0.baidu.com/it/u=3288716445,1382667420&fm=253&fmt=auto&app=120&f=JPEG?w=800&h=1070'
    assert.equal(
      searchMod.toThumbnailCoverUrl(bdUrl),
      searchMod.toHighResCoverUrl(bdUrl),
      '百度图源应保持参数一致以 100% 命中浏览器 Memory Cache'
    )
    return '单一封面源同源缩放（1:1比例一致、零跨源错图）验证通过'
  })

  // ==================== Suite 3: 分馆地址配置与加密模块校验 ====================
  await testCase('Config & Crypto', '双馆分馆 JSON 配置、总馆排序优先级与未知地址回退', () => {
    const zjMain = mapMod.getLibraryBranchPriority('zjlib', '浙图·之江馆区', '外借区')
    const zjSub = mapMod.getLibraryBranchPriority('zjlib', '浙图·其他馆区', '仙居县朱溪镇分馆')
    assert.ok(zjMain < zjSub, '之江馆总馆优先级应高于县级分馆')

    const unknownInfo = mapMod.getLibraryAddressInfo({
      library: 'zjlib',
      libName: '浙图·其他馆区',
      location: '仙居县朱溪镇分馆',
    })
    assert.equal(unknownInfo.address, '未知地址')
    assert.ok(unknownInfo.query.includes('浙图 仙居县朱溪镇分馆'))

    const sm2Cipher = cryptoMod.encryptZjlibPasswordClient('TestPass123')
    assert.ok(sm2Cipher && sm2Cipher.length > 40 && !sm2Cipher.includes('TestPass123'))
    return '双馆地址优先级与 SM2 浏览器端加密验证通过'
  })

  // ==================== Suite 4: 后端 API 网关、安全防护与真实封面/馆藏验收测试 ====================
  await testCase('API & Security', 'GET /api/version 与 /api/health 版本一致性及安全响应头校验', async () => {
    const verRes = await invokeApi(apiHandler, { method: 'GET', url: '/api/version' })
    assert.equal(verRes.status, 200)
    assert.equal(verRes.json?.version, versionJson.version)
    assert.ok(verRes.headers['cache-control']?.includes('no-store'))
    assert.equal(verRes.headers['x-content-type-options'], 'nosniff')
    assert.ok(verRes.headers['x-request-id'])

    const csrfRes = await invokeApi(apiHandler, {
      method: 'POST',
      url: '/api/covers/resolve',
      headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example.com' },
      body: { items: [] },
    })
    assert.equal(csrfRes.status, 403, '跨站 POST 请求必须被拦截 (403)')
    return `v${versionJson.version} 网关防缓存与 CSRF 拦截验证通过`
  })

  await testCase(
    'Live Cover Acceptance',
    '典型疑难图书与套书分卷封面验收：《白帝城之夜》《鬼吹灯．3》《航海王．幽灵岛 51/52/53》《总集篇．第15卷》等13本',
    async () => {
      const res = await invokeApi(apiHandler, {
        method: 'POST',
        url: '/api/covers/resolve',
        body: {
          items: [
            {
              id: 'baidicheng',
              title: '白帝城之夜',
              author: '马伯庸',
              isbn: '978-7-5217-4704-1',
            },
            {
              id: 'harry',
              title: '哈利·波特魔法图鉴',
              author: '(英)J. K. 罗琳',
              isbn: '978-7-02-019228-1',
            },
            {
              id: 'daomu2',
              title: '盗墓笔记．2',
              author: '南派三叔[著',
              publisher: '浙江人民出版社 (2015)',
              isbn: '978-7-213-06415-9',
            },
            {
              id: 'daomu3',
              title: '盗墓笔记．叁',
              author: '南派三叔著',
              publisher: '中国友谊出版公司 (2007)',
              isbn: '978-7-5057-2385-6',
            },
            {
              id: 'nezha_full',
              title: '哪吒：全集',
              author: '周楞伽原著',
              publisher: '中国电影出版社 1994.8',
              isbn: '7-106-00826-5',
            },
            {
              id: 'guichuideng3',
              title: '鬼吹灯．3，云南虫谷',
              author: '天下霸唱著',
              isbn: '',
            },
            {
              id: 'sanguopian',
              title: '透过地理看历史．三国篇．Three Kingdoms',
              author: '李不白著',
              isbn: '',
            },
            {
              id: 'hp3_ii',
              title: '哈利·波特与阿兹卡班囚徒．II',
              author: '(英) J. K. 罗琳著',
              isbn: '',
            },
            {
              id: 'hp5',
              title: '哈利·波特与凤凰社',
              author: '(英) J. K. 罗琳著',
              isbn: '978-7-02-016437-0',
            },
            {
              id: 'op51',
              title: '航海王．幽灵岛．卷五十一，11名超新星',
              author: '(日)尾田荣一郎著',
              isbn: '978-7-5751-0768-6',
            },
            {
              id: 'op52',
              title: '航海王．幽灵岛．卷五十二，罗杰和雷利',
              author: '(日)尾田荣一郎著',
              isbn: '978-7-5751-0768-6',
            },
            {
              id: 'op53',
              title: '航海王．幽灵岛．卷五十三，王者资质',
              author: '(日)尾田荣一郎著',
              isbn: '978-7-5751-0768-6',
            },
            {
              id: 'op_zj15',
              title: '航海王．总集篇．第15卷，恐怖之船',
              author: '(日)尾田荣一郎著',
              isbn: '978-7-5729-1759-2',
            },
          ],
        },
      })
      assert.equal(res.status, 200)
      const covers = res.json?.covers || {}
      for (const [k, url] of Object.entries(covers)) {
        assert.ok(!String(url).includes('#hd='), `${k} 不应包含跨源拼接 #hd=: ${url}`)
      }
      assert.ok(
        covers.baidicheng?.includes('360buyimg.com/n0/jfs/'),
        `《白帝城之夜》应直连京东 800x800 高清图，实际: ${covers.baidicheng}`
      )
      assert.ok(
        covers.harry?.includes('360buyimg.com/n0/jfs/'),
        `《哈利·波特魔法图鉴》应直连京东 800x800 高清图，实际: ${covers.harry}`
      )
      assert.ok(
        covers.daomu2?.includes('360buyimg.com/n0/jfs/'),
        `《盗墓笔记．2》应直连京东官方 RGB 图源规避 dataesb CMYK 偏色，实际: ${covers.daomu2}`
      )
      assert.ok(
        covers.daomu3 &&
          !covers.daomu3.includes('1237204830,1874844875') &&
          !covers.daomu3.includes('1823738206,267546753'),
        `《盗墓笔记．叁》应命中单册封面并排除4本合售书脊图，实际: ${covers.daomu3}`
      )
      assert.ok(
        covers.nezha_full && !covers.nezha_full.includes('d9fa61ec5b294296a2a53bfe5a167c91'),
        `《哪吒：全集》应剔除当当网暂无图片占位符，实际: ${covers.nezha_full}`
      )
      assert.ok(
        covers.guichuideng3?.includes('book-resource.dataesb.com/cover/p/') &&
          !covers.guichuideng3.includes('30cefdc1d9c04eafa4e4c97342305c63'),
        `《鬼吹灯．3，云南虫谷》(无ISBN)应补全ISBN并命中单册竖版官方封面(排除8册并排横图)，实际: ${covers.guichuideng3}`
      )
      assert.ok(
        covers.sanguopian?.includes('book-resource.dataesb.com/cover/p/'),
        `《透过地理看历史．三国篇》(无ISBN)应补全ISBN并命中官方封面，实际: ${covers.sanguopian}`
      )
      assert.ok(
        covers.hp3_ii?.includes('book-resource.dataesb.com/cover/p/'),
        `《哈利·波特与阿兹卡班囚徒．II》(无ISBN)应命中第II册官方竖版封面，实际: ${covers.hp3_ii}`
      )
      assert.ok(
        covers.hp5 &&
          searchMod.toThumbnailCoverUrl(covers.hp5) === searchMod.toHighResCoverUrl(covers.hp5),
        `《哈利·波特与凤凰社》列表小图与放大图必须为同一张封面，实际: ${covers.hp5}`
      )
      assert.ok(
        covers.op51?.includes('winxuancdn.com') &&
          covers.op52?.includes('winxuancdn.com') &&
          covers.op53?.includes('winxuancdn.com') &&
          covers.op51 !== covers.op52 &&
          covers.op52 !== covers.op53,
        `《航海王．幽灵岛．卷五十一/五十二/五十三》应分别命中各自独立的 800x800 文轩单行本高清封面，实际: ${covers.op51} | ${covers.op52} | ${covers.op53}`
      )
      assert.ok(
        covers.op_zj15 && !covers.op_zj15.includes('1809027890,2934023687'),
        `《航海王．总集篇．第15卷，恐怖之船》应剔除同人彩图并命中第15卷真实封面，实际: ${covers.op_zj15}`
      )
      return '13本典型疑难图书与分卷套书封面（单册ISBN精准反查、子系列总集篇匹配、大小图同源一致）全部通过'
    }
  )

  await testCase(
    'Live Catalog Search',
    '双馆全量书目在线检索与卷号智能拆词验收 (POST /api/catalog/search)',
    async () => {
      const res = await invokeApi(apiHandler, {
        method: 'POST',
        url: '/api/catalog/search',
        body: {
          keyword: '绍宋 叁',
          branch: 'all',
          onlyAvailable: false,
          page: 1,
          rows: 8,
        },
      })
      assert.equal(res.status, 200)
      assert.equal(res.json?.ok, true)
      const items = res.json?.items || []
      assert.ok(items.length > 0, '在线检索《绍宋 叁》应返回匹配书目')
      assert.ok(
        items.some((x) => x.title.includes('绍宋') && (x.title.includes('叁') || x.title.includes('3'))),
        '应精准命中《绍宋．叁》卷次'
      )
      return `命中 ${items.length} 条结果 (浙图 ${res.json.zjTotal} / 杭图 ${res.json.hzTotal})`
    }
  )

  const totalMs = Date.now() - startedAt
  const passed = results.filter((r) => r.status === 'PASS').length
  const failed = results.filter((r) => r.status === 'FAIL').length
  const report = {
    version: versionJson.version,
    timestamp: new Date().toISOString(),
    totalMs,
    total: results.length,
    passed,
    failed,
    results,
  }

  await fs.writeFile(
    path.join(RESULTS_DIR, 'regression-report.json'),
    JSON.stringify(report, null, 2),
    'utf8'
  )
  const mdLines = [
    `# LibraryHelper 自动化回归与验收测试报告 (v${versionJson.version})`,
    ``,
    `- **运行时间**: ${report.timestamp}`,
    `- **总耗时**: ${totalMs} ms`,
    `- **测试结果**: **${passed} 通过** / **${failed} 失败**（共 ${results.length} 项）`,
    ``,
    `| 模块 | 测试用例 | 状态 | 耗时 | 说明 |`,
    `| :--- | :--- | :--- | :--- | :--- |`,
    ...results.map(
      (r) =>
        `| ${r.suite} | ${r.name} | ${r.status === 'PASS' ? '✅ PASS' : '❌ FAIL'} | ${r.elapsedMs}ms | ${r.detail || r.error || ''} |`
    ),
    ``,
  ]
  await fs.writeFile(path.join(RESULTS_DIR, 'regression-report.md'), mdLines.join('\n'), 'utf8')

  console.log(`\n📊 自动化回归汇总: ${passed}/${results.length} 通过 (耗时 ${totalMs}ms)`)
  console.log(`📁 测试报告已输出至: test/results/regression-report.md`)
  if (failed > 0) {
    process.exitCode = 1
  }
}

runSuite()
