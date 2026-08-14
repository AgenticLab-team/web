import { NextResponse } from "next/server";

import { eq } from "drizzle-orm";

import { apiError, authenticate } from "@/lib/api-tokens/auth";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { buildViewerContext } from "@/lib/forum/context";
import { listPosts } from "@/lib/forum/queries";
import { publicConnectionOf } from "@/lib/github/link";
import { showcaseFor } from "@/lib/github/repos";
import { githubEnabled } from "@/lib/github/secret";
import { activityHoursFor } from "@/lib/members/activity";
import { personProfileFor } from "@/lib/members/person";
import { catchphraseFor, topEmojiFor, topMentionPartner } from "@/lib/members/phrases";
import { visibleGroupsFor } from "@/lib/queries/visibility";
import { titlesOf } from "@/lib/titles/queries";

export const dynamic = "force-dynamic";

/**
 * 主页上的 GitHub 那一块。
 *
 * ═════════════════════════════════════════
 * 没绑 / 没配 / 他关掉了展示 —— 三种都是「这一块不出现」
 * ═════════════════════════════════════════
 *
 * 三种情况分开报没有任何意义：调用方能做的事一模一样（什么都别画），
 * 而分开报会把「他把 GitHub 从主页上藏起来了」这件事告诉别人 ——
 * 那正是他藏起来想避免的。
 *
 * `publicConnectionOf` 已经把「他关掉了展示」判成 null，
 * 这里只要跟着它走就行。
 */
function githubBlock(userId: string | null) {
  if (!userId || !githubEnabled()) return undefined;
  const connection = publicConnectionOf(userId);
  if (!connection) return undefined;
  return { connection, repos: showcaseFor(userId, connection.pinnedRepos) };
}

/**
 * 一个人的主页。@提及 点进来落的地方。
 *
 * ═════════════════════════════════════════
 * 看不到的人和不存在的人**给同一个 404**
 * ═════════════════════════════════════════
 *
 * 403 会泄露「这个 wx_id 存在」，而 wx_id 是可以枚举的。
 * 网页那一页写的是同一条，这里照抄 —— 两处不一致的话，
 * 用 API 探测就能补上网页那边挡住的信息。
 *
 * 内容也只取自**共同群**：一个只跟他同在 1 号群的人，
 * 不该从这里看到他在别的群的动静。收口在 `personProfileFor(wxId, 共同群)`。
 */
export async function GET(request: Request, { params }: { params: Promise<{ wxId: string }> }) {
  const auth = await authenticate(request, ["community:read"]);
  if (!auth.ok) return auth.response;

  const { user } = auth.caller;
  const wxId = decodeURIComponent((await params).wxId);

  const myGroups = visibleGroupsFor(user);
  /* 共同群的 id 列表 —— 下面每一块画像都以它为范围，一次算好传下去 */
  const convIds = myGroups.map((g) => g.convId);
  const profile = personProfileFor(wxId, myGroups);
  if (!profile) return apiError(404, "not_found", "没有这个人");

  /*
   * 站内账号是可选的：群里绝大多数人没有账号（`people` 和 `users`
   * 是两回事，靠 wx_id 搭桥）。没有账号的人照样有主页 ——
   * 他在群里说过的话是真实存在的。
   */
  const account = db.select().from(users).where(eq(users.wxId, wxId)).get();

  const posts = account
    ? listPosts(buildViewerContext(user), { authorId: account.id, limit: 20 })
    : [];

  return NextResponse.json({
    wx_id: wxId,
    profile,
    hours: activityHoursFor(user, wxId, convIds),
    /* 口头禅取的是「说得怪」而不是「说得最多」—— 后者选出来的全是「哈哈」 */
    catchphrase: catchphraseFor(user, wxId, convIds),
    top_emoji: topEmojiFor(user, wxId, convIds),
    mention_partner: topMentionPartner(user, wxId, convIds),
    titles: account ? titlesOf(account.id) : [],
    posts,
    /*
     * GitHub 那一块：没配 OAuth 应用的话整块不出现，而不是给一个空对象。
     * 「半套配置比没配置更糟」—— 一个空的 GitHub 区会让人以为
     * 这个人没绑，而实际是这个站根本没开这个功能。
     */
    github: githubBlock(account?.id ?? null),
  });
}
