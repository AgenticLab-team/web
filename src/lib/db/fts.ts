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
 * 代价：索引体积约翻倍。按 PLAN.md §7.3 的测算，文本侧一年不到 500MB，可以接受。
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
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    // FTS5 的语法字符会让表达式解析失败，直接剔除
    .map((term) => term.replace(/["*():^-]/g, " ").trim())
    .filter(Boolean);

  if (terms.length === 0) return null;

  const phrases = terms.map((term) => {
    const segmented = segmentForIndex(term).trim();
    return quotePhrase(segmented);
  });

  // FTS5 中相邻表达式默认是 AND
  return phrases.join(" ");
}

/** 生成检索片段时用，把切开的空格还原掉 */
export function desegment(text: string): string {
  return text.replace(/(?<=[㐀-䶿一-鿿豈-﫿぀-ヿ]) (?=\S)/g, "");
}
