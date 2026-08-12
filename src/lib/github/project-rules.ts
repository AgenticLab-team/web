import type { RepoFact } from "./repo-rules";

/**
 * 项目目录怎么挑、怎么排、怎么分档。纯规则，不碰数据库、不碰网络。
 *
 * ═════════════════════════════════════════
 * 这一页要回答的问题是「这个社区在做什么」
 * ═════════════════════════════════════════
 *
 * 不是「谁 star 最多」。那个问题 GitHub 自己答得比我们好，
 * 而且答案永远是那几个外面来的大项目。
 */

/** 目录上最多摆几个。再多就没人往下翻了，而下面那些正是没人看过的 */
export const MAX_PROJECTS = 60;

export const PROJECT_SORTS = ["active", "stars", "new"] as const;
export type ProjectSort = (typeof PROJECT_SORTS)[number];

export function resolveProjectSort(value: string | undefined): ProjectSort {
  return (PROJECT_SORTS as readonly string[]).includes(value ?? "")
    ? (value as ProjectSort)
    : "active";
}

/**
 * 这个仓库该不该出现在目录里。
 *
 * ─────────────────────────────────────────
 * 三条，每一条都在挡「不是作品的东西」
 * ─────────────────────────────────────────
 *
 * 私有的一律不要 —— 抓取用的接口按定义只返回公开仓库，
 * 这一层是**写在我们自己代码里、被测试盯着的**那一道，
 * 理由和 repo-rules.dropNonPublic 完全一样。
 *
 * 没有 star 的 fork 不要：那多半是「点了一下 fork 按钮」。
 * 一个人 fork 过三十个仓库的话，目录会被他一个人占满，
 * 而那三十个里没有一个是他做的东西。
 *
 * 从来没推过代码的不要（`pushedAt` 为 0）：建完就没动过的空仓库
 * 在目录上和一个真项目长得一模一样，而它什么都不是。
 */
export function isShowcaseWorthy(repo: RepoFact): boolean {
  if (repo.isPrivate) return false;
  if (repo.isFork && repo.stars === 0) return false;
  if (repo.pushedAt === 0) return false;
  return true;
}

export interface ProjectRow {
  key: string;
  language: string | null;
  stars: number;
  pushedAt: number;
  createdAt: number;
  archived: boolean;
}

/**
 * 排序。
 *
 * ─────────────────────────────────────────
 * 归档的一律沉底，不管哪种排法
 * ─────────────────────────────────────────
 *
 * 一个归档了的仓库按 star 排可能是第一名 —— 而「这个社区在做什么」
 * 这个问题的答案里，不该是一个作者自己宣布不再维护的东西。
 * 它仍然在列表里（那是他做过的），只是不占最前面那几行。
 *
 * 每一档里都有次级键：只按一个键排的话，同分的那些在 SQLite 里
 * 顺序不保证，翻页时同一个项目会在两页各出现一次
 * （见 LESSONS「排序要有次级键」）。这里虽然不翻页，
 * 但「每次刷新换个排列」同样是让人觉得页面坏了的表现。
 */
export function rankProjects<T extends ProjectRow>(rows: T[], sort: ProjectSort): T[] {
  const key = (r: T): number =>
    sort === "stars" ? r.stars : sort === "new" ? r.createdAt : r.pushedAt;

  return [...rows].sort((a, b) => {
    if (a.archived !== b.archived) return a.archived ? 1 : -1;
    const diff = key(b) - key(a);
    if (diff !== 0) return diff;
    // 次级键：先比 star，再比仓库名 —— 名字是唯一一个绝不会打平的
    if (a.stars !== b.stars) return b.stars - a.stars;
    return a.key.localeCompare(b.key);
  });
}

export interface LanguageFacet {
  language: string;
  count: number;
}

/**
 * 语言筛选条。
 *
 * **按项目数排，不按字母排。** 字母序的话第一个永远是 Assembly
 * 或者 C，而这个社区实际写的是 Python 和 TypeScript ——
 * 一排要横着划三屏才找得到自己想点的那个筛选条，等于没有筛选条。
 *
 * 语言为空的不进来：GitHub 对纯文档 / 纯配置的仓库返回 null，
 * 造一个「其他」档出来的话，它多半会是最大的一档，
 * 而点进去看到的是一堆互相没关系的东西。
 */
export function languageFacets(rows: { language: string | null }[]): LanguageFacet[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!row.language) continue;
    counts.set(row.language, (counts.get(row.language) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([language, count]) => ({ language, count }))
    .sort((a, b) => b.count - a.count || a.language.localeCompare(b.language));
}
