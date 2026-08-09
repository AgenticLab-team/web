/**
 * 中文全文检索方案。
 *
 * 实测（SQLite 3.53.4）：
 *   trigram   分词器对 2 字中文查询（「鉴权」「部署」这类最常见的词）**完全查不到**，
 *             因为 trigram 要求匹配串至少 3 字符。
 *   unicode61 直接用会把整段中文当成一个 token，同样查不到子串。
 *
 * 采用的方案：写入时把 CJK 逐字用空格切开，用 unicode61 建索引，
 * 查询时把关键词同样切开并作为**短语**匹配。
 * 这样 2 字、多字、中英混合全部命中，且纯 SQL 实现、无外部依赖。
 *
 * 代价：索引体积约翻倍。按 docs/archive/PLAN-2026-08-08.md §7.3 的测算，文本侧一年不到 500MB，可以接受。
 */

// CJK 统一表意文字 + 扩展 A + 兼容表意 + 日文假名
const CJK_PATTERN = /[㐀-䶿一-鿿豈-﫿぀-ヿ]/g;

/** 写入索引前调用：逐字切开 CJK，ASCII 部分保持原样 */
export function segmentForIndex(text: string): string {
  return text.replace(CJK_PATTERN, (char) => `${char} `);
}

/** FTS5 短语里的双引号需要成对转义 */
function quotePhrase(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * 把用户输入的搜索词转成 FTS5 MATCH 表达式。
 * 返回 null 表示查询词为空或只剩噪音，调用方应跳过检索。
 */
export function buildMatchExpression(query: string): string | null {
  const terms = query
    // 先剔除 FTS5 语法字符**再**切分。顺序反过来会把 `鉴权"OR"1` 拼成
    // 单个短语 `"鉴 权  OR 1"`，永远匹配不到任何东西。
    .replace(/["*():^-]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (terms.length === 0) return null;

  const phrases = terms.map((term) => {
    const segmented = segmentForIndex(term).trim();
    return quotePhrase(segmented);
  });

  // FTS5 中相邻表达式默认是 AND
  return phrases.join(" ");
}

/**
 * 把切开的空格还原掉，用于展示检索片段。
 *
 * 必须能**跨过高亮标签**：FTS5 的 snippet 会插入 `<mark>`，
 * 于是「鉴权</mark> 这个」里那个空格前面是 `>` 而不是汉字，
 * 只看相邻字符的话还原不掉，页面上会看到多余空格。
 */
const CJK_CLASS = "\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff";
const TAG = "(?:</?[a-zA-Z][a-zA-Z0-9]*>)*";
const DESEGMENT = new RegExp(`(?<=[${CJK_CLASS}]${TAG}) (?=${TAG}\\S)`, "g");

export function desegment(text: string): string {
  return text.replace(DESEGMENT, "");
}
