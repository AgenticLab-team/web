/**
 * 标签的归一化与清洗。纯函数，不碰数据库。
 *
 * ─────────────────────────────────────────
 * 为什么必须是纯的
 * ─────────────────────────────────────────
 *
 * 这套归一化有**三个**使用者：写库时、按 slug 查时、
 * 以及发帖框在本地判「这个标签是不是已经加过了」。
 *
 * 原来它住在 `tags-queries.ts` 里，而那个文件是 `server-only` ——
 * 于是发帖框只能自己再写一份「转小写比一比」。两份归一化迟早分叉，
 * 而分叉的表现是：界面上看着是两个不同的标签，存进去变成同一个
 * （或者反过来）。用户会觉得这个输入框有鬼。
 */

/** 一篇帖子最多几个标签 */
export const MAX_TAGS_PER_POST = 5;
/** 一个标签最长多少字。再长的不是标签，是一句话 */
export const MAX_TAG_LENGTH = 24;

/**
 * 归一化成键。
 *
 * 大小写、空格、斜杠都抹平 —— 不然「RAG」「rag」「Rag」会变成
 * 三个标签，一年后标签墙上全是同义词，筛选功能等于废了。
 *
 * `\p{L}` 含中日韩，所以中文标签原样保留 —— 这是个中文社区，
 * 用 `[a-z0-9]` 那种写法会把所有中文标签洗成空。
 */
export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s_/\\]+/g, "-")
    .replace(/[^\p{L}\p{N}-]/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export interface CleanTag {
  /** 归一化之后的键 */
  slug: string;
  /** 人写的那个形态，用来显示 */
  name: string;
}

/**
 * 把用户输入的一串标签洗干净。
 *
 * **保留人写的形态当 name，归一化之后的当 slug。**
 * 原来写库时存的是 `name: slug` —— 于是输入「RAG」显示成 `rag`、
 * 「Rag 检索」显示成 `rag-检索`。schema 里 `name` 和 `slug`
 * 分成两列，正是为了不丢掉人写的那个形态。
 *
 * 太长的**截断而不是拒绝**：一个标签打长了，不该让整篇帖子发不出去。
 */
export function cleanTags(names: readonly string[]): CleanTag[] {
  const out: CleanTag[] = [];
  const seen = new Set<string>();

  for (const raw of names) {
    const name = String(raw ?? "").trim().slice(0, MAX_TAG_LENGTH);
    const slug = slugify(name);
    // slug 洗空的（纯 emoji、纯符号）直接丢 —— 它没法当键
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push({ slug, name });
    if (out.length >= MAX_TAGS_PER_POST) break;
  }

  return out;
}
