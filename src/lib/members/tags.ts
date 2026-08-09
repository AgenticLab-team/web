/**
 * 技能标签。纯函数。
 *
 * ─────────────────────────────────────────
 * 标签目录只有一个失败方式：碎掉
 * ─────────────────────────────────────────
 *
 * 「RAG」「rag」「Rag」「 RAG 」被当成四个标签的话，
 * 每个下面都只有一个人，而一个每项都只有一个人的目录**等于没有目录** ——
 * 没人能靠它找到人，于是没人再填标签，于是它更空。
 *
 * 所以每个标签存两份：
 *   · slug  —— 归一化后的匹配键，大小写、空格、全角半角都抹平
 *   · label —— 第一次被写下来的样子，用来显示
 *
 * 显示用人写的那个形态（「RAG」比「rag」体面），匹配用 slug。
 */

export const MAX_TAGS_PER_USER = 8;
export const MAX_TAG_LENGTH = 20;

/**
 * 归一化成匹配键。
 *
 * 做的事情按「不这么做会怎样」排：
 *   · 大小写 → RAG / rag 分裂
 *   · 首尾与内部空白 → 「大 模 型」和「大模型」分裂
 *   · 全角字符 → 输入法带出来的 Ａ 和 A 分裂
 *   · 分隔符（/ - _ ·）→ 「前端/React」和「前端 React」分裂
 */
export function tagSlug(raw: string): string {
  return raw
    .normalize("NFKC") // 全角转半角、兼容字符归一
    .toLowerCase()
    .replace(/[\s　]+/g, "")
    .replace(/[/\-_·・.,，、]+/g, "")
    .trim();
}

/** 清理显示用的形态：收掉多余空白，但不动大小写 */
export function tagLabel(raw: string): string {
  return raw.normalize("NFKC").replace(/[\s　]+/g, " ").trim();
}

export interface TagIssue {
  input: string;
  reason: string;
}

export interface ParsedTags {
  tags: { slug: string; label: string }[];
  issues: TagIssue[];
}

/**
 * 解析用户提交的标签。
 *
 * **不静默丢弃**：填了但没存上的那些必须回报出来。
 * 悄悄少存一个的表现是用户填了「大模型 / RAG / Agent」，
 * 保存后只剩两个，而他不知道是哪个没了、为什么没了。
 */
export function parseTags(input: string[] | string): ParsedTags {
  const raw = Array.isArray(input)
    ? input
    : input.split(/[,，\n;；]/); // 逗号、换行、分号都当分隔符 —— 别让人猜该用哪个

  const tags: { slug: string; label: string }[] = [];
  const issues: TagIssue[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    const label = tagLabel(item);
    if (!label) continue; // 空的直接跳过，不算错误

    const slug = tagSlug(item);
    if (!slug) {
      issues.push({ input: label, reason: "只有符号，不构成一个标签" });
      continue;
    }
    if (label.length > MAX_TAG_LENGTH) {
      issues.push({ input: label, reason: `超过 ${MAX_TAG_LENGTH} 个字` });
      continue;
    }
    if (seen.has(slug)) {
      // 重复不报错但也要说一声 —— 用户填了两个「RAG」是想要两个位置
      issues.push({ input: label, reason: "和前面的重复了" });
      continue;
    }
    if (tags.length >= MAX_TAGS_PER_USER) {
      issues.push({ input: label, reason: `最多 ${MAX_TAGS_PER_USER} 个，这个没存上` });
      continue;
    }

    seen.add(slug);
    tags.push({ slug, label });
  }

  return { tags, issues };
}

/**
 * 一个标签值不值得出现在目录的筛选栏里。
 *
 * 只有一个人的标签放进筛选栏是噪音 —— 点进去看到一个人，
 * 而那个人本来在总列表里也看得到。等到第二个人也填了它，
 * 它才第一次真的能用来「找到一类人」。
 */
export const FACET_MIN_HOLDERS = 2;

export interface TagFacet {
  slug: string;
  label: string;
  count: number;
}

export function visibleFacets(facets: TagFacet[], min = FACET_MIN_HOLDERS): TagFacet[] {
  return facets
    .filter((f) => f.count >= min)
    .sort((a, b) => b.count - a.count || a.slug.localeCompare(b.slug));
}

/**
 * 同一个 slug 下大家写法不一样时，用哪个显示。
 *
 * 取**最多人用的那个写法**，并列时取更早出现的 ——
 * 不是取第一个人的写法：第一个填「rag」的人不该让后面
 * 十个写「RAG」的人都跟着变成小写。
 */
export function preferredLabel(labels: { label: string; count: number }[]): string {
  if (labels.length === 0) return "";
  return [...labels].sort((a, b) => b.count - a.count)[0].label;
}

/** 目录搜索：人名和标签一起搜 */
export function matchesQuery(
  member: { name: string; bio: string | null; tags: { slug: string; label: string }[] },
  query: string,
): boolean {
  const q = tagSlug(query);
  if (!q) return true;
  if (tagSlug(member.name).includes(q)) return true;
  if (member.bio && tagSlug(member.bio).includes(q)) return true;
  return member.tags.some((t) => t.slug.includes(q));
}
