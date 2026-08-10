import "server-only";

import { and, desc, eq, isNull } from "drizzle-orm";
import type { MetadataRoute } from "next";

import { db } from "@/lib/db";
import { posts } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { isIndexable } from "@/lib/forum/visibility";

/**
 * sitemap。
 *
 * ─────────────────────────────────────────
 * 站里公开的帖子，外面一篇都搜不到
 * ─────────────────────────────────────────
 *
 * 可见性里专门有一档 `unlisted`，意思就是「**不希望被搜索引擎收录**」——
 * 那反过来说明 `public` 是希望被收录的。而没有 sitemap 的话，
 * 一个新站几乎不会被爬到，那一档的区分也就落了空。
 *
 * ─────────────────────────────────────────
 * 判定不在这里写第二遍
 * ─────────────────────────────────────────
 *
 * 「能不能被索引」只有 `isIndexable` 一处实现，这里**逐行过它**。
 *
 * 下面的 SQL 只是**预筛**，不是判定：它的作用是别把整张帖子表
 * 读进内存（这个地址是给爬虫用的，它会反复来）。
 * 预筛可以比真判定松，**绝不能更松地放行** ——
 * 所以最后仍然由 `isIndexable` 说了算。
 *
 * 这不是多此一举。两处各判一遍的话迟早分叉，
 * 而分叉的方向如果是这边更松，就是把私密内容送进了搜索引擎 ——
 * 那种错误没有任何测试会自己报出来，是别人搜到了才发现的。
 *
 * `fromGroupChat` 在库里的形态是 `visibility_locked`（全站都这么读，
 * 见 `admin/posts.ts`）。群聊转帖被审核 + 原作者同意提升之后
 * 这把锁会解开 —— 那时它确实该被收录，因为原作者亲口同意过。
 */
/**
 * **不能让它被烤进构建产物**。
 *
 * `sitemap.js` 是一个「默认被缓存」的特殊 Route Handler ——
 * 它不碰任何请求期 API，于是 Next 会在构建时跑一遍、把结果存下来。
 * 那意味着**新发的帖子要等到下一次部署才会出现在地图里**，
 * 而这个站可能好几天不部署一次。
 *
 * 这种错不会有任何征兆：地图一直在、格式一直对、测试一直绿，
 * 只是内容停在了上一次构建那一刻。
 *
 * 用 revalidate 而不是 `force-dynamic`：爬虫会反复来，
 * 每次都重扫一遍帖子表没有必要 —— 而地图晚一小时更新，
 * 对搜索引擎来说毫无区别。
 */
export const revalidate = 3600;

export default function sitemap(): MetadataRoute.Sitemap {
  const base = env.site.url;

  const pages: MetadataRoute.Sitemap = [
    { url: `${base}/`, changeFrequency: "daily", priority: 1 },
    { url: `${base}/forum`, changeFrequency: "daily", priority: 0.8 },
    { url: `${base}/join`, changeFrequency: "monthly", priority: 0.5 },
  ];

  const rows = db
    .select({
      id: posts.id,
      visibility: posts.visibility,
      status: posts.status,
      authorId: posts.authorId,
      locked: posts.visibilityLocked,
      updatedAt: posts.updatedAt,
      createdAt: posts.createdAt,
    })
    .from(posts)
    .where(
      and(
        eq(posts.visibility, "public"),
        eq(posts.status, "published"),
        isNull(posts.deletedAt),
      ),
    )
    .orderBy(desc(posts.updatedAt))
    .limit(5000)
    .all();

  for (const row of rows) {
    if (
      !isIndexable({
        visibility: row.visibility,
        status: row.status,
        authorId: row.authorId,
        fromGroupChat: row.locked,
      })
    ) {
      continue;
    }

    pages.push({
      url: `${base}/forum/p/${row.id}`,
      lastModified: new Date(row.updatedAt ?? row.createdAt),
      changeFrequency: "weekly",
      priority: 0.6,
    });
  }

  return pages;
}
