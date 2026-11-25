import type { BorrowRecord } from '../types/library'

/**
 * 浙江图书馆官网 (https://www.zjlib.cn) 浏览器控制台一键导出脚本
 * 用户扫码登录后粘贴到控制台，自动拉取当前借阅+全部历史借阅并复制为 JSON
 */
export const ZJLIB_CONSOLE_EXPORTER_SCRIPT = `(async () => {
  const tokenMatch = document.cookie.match(/(?:userToken|bffUserToken)=([^;]+)/);
  const token = tokenMatch ? decodeURIComponent(tokenMatch[1]) : '';
  if (!token) {
    alert('未检测到浙江图书馆登录态，请先在 www.zjlib.cn 登录（支持微信/支付宝扫码）后再执行！');
    return;
  }
  console.log('⏳ 正在拉取浙江图书馆当前借阅与历史借阅...');
  const headers = { 'Content-Type': 'application/json', 'BFF-ORG-ID': '1916318653650423810', 'BFF-USER-TOKEN': token };
  const curRes = await fetch('/bff-api/portal-admin-service/portal-pc-api/myLoans/current-loan', {
    method: 'POST', headers, body: JSON.stringify({ haveRegister: 1 })
  }).then(r => r.json());
  const records = [];
  for (const item of (curRes.data || [])) {
    records.push({
      library: 'zjlib',
      subLibrary: item.newBook ? '浙图·网借新书' : (item.cirTypeName || '浙江图书馆'),
      status: 'borrowed',
      title: item.title || '',
      author: item.author || '',
      isbn: item.isbn || '',
      callNo: item.callNo || '',
      barcode: item.barcode || '',
      bibId: item.bibId || '',
      loanDate: (item.loanDate || '').slice(0, 10),
      dueDate: (item.dueDate || '').slice(0, 10),
      returnDate: '',
      renewCount: Number(item.renewCount || 0),
      coverUrl: item.coverUrl || ''
    });
  }
  let page = 1;
  while (page <= 30) {
    const hisRes = await fetch('/bff-api/portal-admin-service/portal-pc-api/myLoans/history-loan', {
      method: 'POST', headers,
      body: JSON.stringify({ startDate: '', endDate: '', sortDesc: true, sortColumns: 'loanDate', searchValue: '', newBook: null, size: 100, current: page, haveRegister: 1 })
    }).then(r => r.json());
    const list = hisRes?.data?.records || [];
    for (const item of list) {
      records.push({
        library: 'zjlib',
        subLibrary: item.newBook ? '浙图·网借新书' : (item.cirTypeName || '浙江图书馆'),
        status: 'returned',
        title: item.title || '',
        author: item.author || '',
        isbn: item.isbn || '',
        callNo: item.callNo || '',
        barcode: item.barcode || '',
        bibId: item.bibId || '',
        loanDate: (item.loanDate || '').slice(0, 10),
        dueDate: '',
        returnDate: (item.createTime || '').slice(0, 10),
        renewCount: 0,
        coverUrl: item.coverUrl || ''
      });
    }
    if (list.length < 100) break;
    page++;
  }
  const json = JSON.stringify({ source: 'zjlib-export', exportedAt: new Date().toISOString(), records }, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'zjlib_borrows_' + new Date().toISOString().slice(0,10) + '.json';
  a.click();
  alert('✅ 浙江图书馆导出成功！共导出 ' + records.length + ' 条借阅记录，已自动下载 JSON 文件。');
})();`

/**
 * 杭州图书馆 OPAC (https://my1.zjhzlib.cn/opac) 浏览器控制台一键导出脚本
 */
export const HZLIB_CONSOLE_EXPORTER_SCRIPT = `(async () => {
  const parseDoc = (html, mode) => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const table = doc.querySelector('#contentTable') || doc.querySelector('table');
    if (!table) return { list: [], totalPage: 1 };
    const rows = Array.from(table.querySelectorAll('tr'));
    const headers = Array.from(rows[0]?.querySelectorAll('th,td') || []).map(el => el.textContent.replace(/\\s+/g, '').trim());
    const list = [];
    for (const row of rows.slice(1)) {
      const cells = Array.from(row.querySelectorAll('td'));
      if (cells.length < 3) continue;
      const map = {};
      let bibId = '';
      cells.forEach((c, idx) => {
        map[headers[idx] || ('col_' + idx)] = c.textContent.replace(/\\s+/g, ' ').trim();
        const a = c.querySelector('a[href*="/book/"]');
        if (a) {
          const m = a.getAttribute('href').match(/\\/book\\/([^/?#]+)/);
          if (m) bibId = m[1];
        }
      });
      const title = map['题名'] || map['书名'] || (map['题名/责任者'] || '').split('/')[0].trim();
      if (!title) continue;
      list.push({
        library: 'hzlib',
        subLibrary: map['馆藏地'] || map['所属馆'] || '杭州图书馆',
        status: mode === 'current' ? 'borrowed' : 'returned',
        title,
        author: map['责任者'] || map['著者'] || '',
        isbn: map['ISBN'] || '',
        callNo: map['索书号'] || '',
        barcode: map['条码号'] || '',
        bibId,
        loanDate: (map['借出日期'] || map['借书日期'] || '').slice(0, 10),
        dueDate: (map['应还日期'] || '').slice(0, 10),
        returnDate: mode === 'history' ? (map['归还日期'] || map['操作日期'] || '').slice(0, 10) : '',
        renewCount: Number(map['续借次数'] || 0) || 0,
        coverUrl: ''
      });
    }
    const totalPage = Number(doc.querySelector('input[name="totalPage"]')?.value || 1) || 1;
    return { list, totalPage };
  };
  console.log('⏳ 正在拉取杭州图书馆借阅记录...');
  const curHtml = await fetch('/opac/loan/currentLoanList').then(r => r.text());
  const { list: records } = parseDoc(curHtml, 'current');
  let page = 1, totalPage = 1;
  while (page <= totalPage && page <= 30) {
    const hisHtml = await fetch('/opac/loan/historyLoanList?page=' + page + '&rows=100').then(r => r.text());
    const parsed = parseDoc(hisHtml, 'history');
    records.push(...parsed.list);
    totalPage = parsed.totalPage;
    if (!parsed.list.length) break;
    page++;
  }
  const json = JSON.stringify({ source: 'hzlib-export', exportedAt: new Date().toISOString(), records }, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'hzlib_borrows_' + new Date().toISOString().slice(0,10) + '.json';
  a.click();
  alert('✅ 杭州图书馆导出成功！共导出 ' + records.length + ' 条借阅记录，已自动下载 JSON 文件。');
})();`

/**
 * 通用智能解析器：支持解析
 * 1. 本工具或一键脚本导出的 JSON
 * 2. 浙江图书馆接口原始返回的 JSON (current-loan / history-loan)
 * 3. 杭州图书馆网页另存为的 HTML (#contentTable)
 */
export function parseUniversalImportContent(
  rawText: string,
  fallbackLibrary: 'zjlib' | 'hzlib' = 'zjlib'
): Array<Partial<BorrowRecord>> {
  const trimmed = rawText.trim()
  if (!trimmed) return []

  // Case 1: JSON
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed)
    const list: any[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.records)
        ? parsed.records
        : Array.isArray(parsed.data?.records)
          ? parsed.data.records
          : Array.isArray(parsed.data)
            ? parsed.data
            : []

    return list
      .map((item) => {
        const isRawZjlib = 'loanDate' in item && ('createTime' in item || 'soonDueDate' in item || 'bibId' in item)
        const library: 'zjlib' | 'hzlib' = item.library || (isRawZjlib ? 'zjlib' : fallbackLibrary)
        const status: 'borrowed' | 'returned' =
          item.status === 'borrowed' || item.status === 'returned'
            ? item.status
            : item.dueDate && !item.createTime && !item.returnDate
              ? 'borrowed'
              : 'returned'
        return {
          library,
          subLibrary:
            item.subLibrary ||
            (item.newBook ? '浙图·网借新书' : item.cirTypeName || (library === 'zjlib' ? '浙江图书馆' : '杭州图书馆')),
          status,
          title: item.title || item.productName || '',
          author: item.author || '',
          isbn: item.isbn || '',
          callNo: item.callNo || '',
          barcode: item.barcode || '',
          bibId: item.bibId || '',
          loanDate: (item.loanDate || '').slice(0, 10),
          dueDate: (item.dueDate || '').slice(0, 10),
          returnDate: (item.returnDate || item.createTime || '').slice(0, 10),
          renewCount: Number(item.renewCount || 0) || 0,
          coverUrl: item.coverUrl || '',
          rating: item.rating,
          verdict: item.verdict,
          tags: item.tags,
          note: item.note,
          progress: item.progress,
        }
      })
      .filter((r) => Boolean(r.title))
  }

  // Case 2: HTML table from Hangzhou Library Interlib OPAC
  if (trimmed.includes('<table') || trimmed.includes('<tr')) {
    const doc = new DOMParser().parseFromString(trimmed, 'text/html')
    const table = doc.querySelector('#contentTable') || doc.querySelector('table')
    if (!table) return []
    const rows = Array.from(table.querySelectorAll('tr'))
    const headers = Array.from(rows[0]?.querySelectorAll('th,td') || []).map((el) =>
      (el.textContent || '').replace(/\s+/g, '').trim()
    )
    const results: Array<Partial<BorrowRecord>> = []
    for (const row of rows.slice(1)) {
      const cells = Array.from(row.querySelectorAll('td'))
      if (cells.length < 3) continue
      const map: Record<string, string> = {}
      let bibId = ''
      cells.forEach((c, idx) => {
        map[headers[idx] || `col_${idx}`] = (c.textContent || '').replace(/\s+/g, ' ').trim()
        const a = c.querySelector('a[href*="/book/"]')
        if (a) {
          const m = (a.getAttribute('href') || '').match(/\/book\/([^/?#]+)/)
          if (m) bibId = m[1]
        }
      })
      const title = map['题名'] || map['书名'] || (map['题名/责任者'] || '').split('/')[0].trim()
      if (!title) continue
      const hasReturnDate = Boolean(map['归还日期'] || map['还书日期'] || map['操作日期'])
      results.push({
        library: 'hzlib',
        subLibrary: map['馆藏地'] || map['所属馆'] || '杭州图书馆',
        status: hasReturnDate ? 'returned' : 'borrowed',
        title,
        author: map['责任者'] || map['著者'] || '',
        isbn: map['ISBN'] || '',
        callNo: map['索书号'] || '',
        barcode: map['条码号'] || '',
        bibId,
        loanDate: (map['借出日期'] || map['借书日期'] || '').slice(0, 10),
        dueDate: (map['应还日期'] || '').slice(0, 10),
        returnDate: (map['归还日期'] || map['还书日期'] || map['操作日期'] || '').slice(0, 10),
        renewCount: Number(map['续借次数'] || 0) || 0,
      })
    }
    return results
  }

  throw new Error('无法识别的数据格式，请提供 JSON 或杭州图书馆网页 HTML')
}
