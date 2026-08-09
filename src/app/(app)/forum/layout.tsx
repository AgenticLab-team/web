import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/auth/session";
import { canReadForum } from "@/lib/forum/public-access";

/**
 * 论坛的门。
 *
 * ─────────────────────────────────────────
 * 为什么是 layout，不是每页各写一遍
 * ─────────────────────────────────────────
 *
 * `/forum` 下面有 8 条路径（版块、帖子、搜索、历史、编辑、转帖……），
 * 而且还会再长。每页各判一次的话，漏掉的一定是最新加的那条 ——
 * 这个仓库里反复出现的形状就是「规则在一条路上成立、在另一条路上不成立」。
 *
 * layout 在这里是**天然的收口**：新加的页面自动被管住，
 * 不需要谁记得去加。
 *
 * ─────────────────────────────────────────
 * layout 管不到的两处，各自单独接
 * ─────────────────────────────────────────
 *
 *   · `opengraph-image.tsx` —— 卡片图是独立路由，layout 不覆盖它。
 *     它自己那儿要判一次，否则关了门还在往外发带标题的预览图。
 *   · `/p/<code>` 短链 —— 它只跳转，落到 `/forum/p/<id>` 之后
 *     由这里管，不需要重复判（重复判就是两套逻辑，迟早分叉）。
 */
export default async function ForumLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();

  if (!canReadForum(user?.id)) {
    /*
     * 跳登录而不是 404。
     *
     * 论坛存在这件事不是秘密（首页、榜单都提到它），
     * 藏起来只会让人以为网站坏了。**说清楚是要登录**，
     * 人才知道下一步该做什么。
     */
    redirect("/login?next=%2Fforum");
  }

  return children;
}
