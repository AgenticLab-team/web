import type { Metadata } from "next";

import { ArchiveList, DeepList } from "@/components/forum/PostList";
import { PageHeader } from "@/components/shell/PageHeader";
import { BackLink, PageNote, Section } from "@/components/ui/primitives";
import { getCurrentUser } from "@/lib/auth/session";
import { requireFeature } from "@/lib/flags/server";
import { buildViewerContext } from "@/lib/forum/context";
import { LONGFORM_CHARS } from "@/lib/forum/longform";
import { listPosts } from "@/lib/forum/queries";

export const metadata: Metadata = { title: "坐下来读" };
export const dynamic = "force-dynamic";

/**
 * 坐下来读 —— 长文和精华的落脚点。
 *
 * ═════════════════════════════════════════
 * 它不是一个版块，是一条横穿所有版块的路
 * ═════════════════════════════════════════
 *
 * 做成版块的话，一篇讲部署的长文就得在「折腾与教程」和这里之间选一个 ——
 * 而它两边都属于。所以这里按**内容形态**取，不按作者选的分类：
 * 站长标过精华的，或者正文够长的，不管它发在哪个版块。
 *
 * 这一页存在的理由是数出来的：全站长文平均 2.3 次浏览，
 * 短帖平均 8.2 次。写一天的东西不该比写四秒的东西少人看。
 */
export default async function DeepPage() {
  const user = await getCurrentUser();
  requireFeature("forum", user);
  const viewer = buildViewerContext(user);

  /*
   * 两条列表，取的是同一批帖子的两种看法。
   *
   * 「近期」按 deep 排（衰减按天，见 queries.ts），
   * 「更早的」按 created 排 —— 后者是给那些错过了的人准备的：
   * 一篇三个月前的好文在任何按热度排的列表里都不会再出现，
   * 而它并没有过期。
   *
   * 近期取 11 篇：一张通栏的头条 + 五行各两张，最后一行不会剩半张。
   */
  const featured = listPosts(viewer, { sort: "deep", longformOnly: true, limit: 11 });
  const archive = listPosts(viewer, {
    sort: "created",
    longformOnly: true,
    limit: 30,
    offset: 0,
  });

  /* 已经在上面露过面的不再重复一遍 */
  const seen = new Set(featured.map((p) => p.id));
  const older = archive
    .filter((p) => !seen.has(p.id))
    /*
     * 再按时间排一次。
     *
     * listPosts 的每种排法都把「还置顶着的」提到最前面 —— 对一条流是对的，
     * 对一份**按月分堆的索引**是错的：一篇置顶的新帖会出现在
     * 「2025 年 11 月」那个小标题底下，看起来就是分组算错了。
     * 这里只动顺序，不动取哪些。
     */
    .sort((a, b) => b.createdAt - a.createdAt);

  return (
    <>
      <BackLink href="/forum">论坛</BackLink>
      <PageHeader title="坐下来读" subtitle="长文与精华，横穿所有版块" />

      <Section title="近期">
        <DeepList posts={featured} />
      </Section>

      {older.length > 0 && (
        <Section title="更早的">
          {/*
            * 按时间倒序，不按热度。
            *
            * 一篇三个月前的好文在任何按热度排的列表里都不会再出现，
            * 而它并没有过期 —— 这一栏就是给它留的。
            *
            * 长相也换成一行一篇的索引：人到这一栏来是**找**东西，
            * 不是逛。找的时候摘要和头像都是干扰。
            */}
          <ArchiveList posts={older} />
        </Section>
      )}

      <PageNote>
        这里收两种帖子：站长标过<strong>精华</strong>的，和正文超过 {LONGFORM_CHARS} 字的。
        不挑版块 —— 一篇讲部署的长文既属于「折腾与教程」，也属于这里。
      </PageNote>
    </>
  );
}
