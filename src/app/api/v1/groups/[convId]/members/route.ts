import { NextResponse } from "next/server";

import { and, desc, eq, isNull } from "drizzle-orm";

import { apiError, authenticate } from "@/lib/api-tokens/auth";
import { paging } from "@/lib/api-tokens/route-helpers";
import { db } from "@/lib/db";
import { groupMembers, users } from "@/lib/db/schema";
import { bypassesPrivacy } from "@/lib/privacy/queries";
import { assertGroupAccess } from "@/lib/queries/visibility";
import { resolveDisplayName } from "@/lib/users/display-name";

export const dynamic = "force-dynamic";

/**
 * 一个群的成员名册。
 *
 * ═════════════════════════════════════════
 * 关掉了「出现在成员目录里」的人**不在这份名单上**
 * ═════════════════════════════════════════
 *
 * 这一条不是可选的。那个开关的意义就是「不要被列出来」，
 * 而一个能列出全群名册的新接口会让它在终端这条路上悄悄失效 ——
 * 失效得毫无症状：网页上那一页看起来一切正常，
 * 而拨了开关的那个人也不会知道。
 *
 * ─────────────────────────────────────────
 * `wx_id` 在这里是**对内**标识，和网页保持一致
 * ─────────────────────────────────────────
 *
 * 网页上成员主页的地址就是 `/members/<wx_id>`，也就是说
 * 一个登录成员本来就拿得到同群人的 wx_id。这条接口沿用它，
 * 终端才跳得到同一个人。
 *
 * `ARCHITECTURE.md` 那条「微信 ID 不出现在任何对外界面上」
 * 说的是**未登录访客看得到的地方**（榜单的兜底显示名那一类）——
 * 它禁的是把 wx_id 当成名字显示出来，不是禁止它作为 id 存在。
 * 所以这里显示名一律走 `resolveDisplayName`，它保证兜底不会退化成 wx_id。
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ convId: string }> },
) {
  const auth = await authenticate(request, ["groups:read"]);
  if (!auth.ok) return auth.response;

  const convId = decodeURIComponent((await params).convId);
  if (!assertGroupAccess(auth.caller.user, convId)) {
    return apiError(404, "not_found", "没有这个群，或者你不在里面");
  }

  const { limit, offset } = paging(request, 500);

  /*
   * 「不出现在成员目录里」这个开关存在 `users.directory_hidden` 上。
   *
   * 一次查完成一个集合，而不是逐行去问 —— 一个两千人的群
   * 逐行查就是两千次查询，而这一屏在终端里是常开的。
   *
   * 管理员不受这个开关限制（`bypassesPrivacy`），
   * 和成员目录那一页同一条口径：两处不一致的话，
   * 站长会得出「名册漏人」的结论并去查同步。
   */
  const hidden = bypassesPrivacy(auth.caller.user)
    ? new Set<string>()
    : new Set(
        db
          .select({ wxId: users.wxId })
          .from(users)
          .where(eq(users.directoryHidden, true))
          .all()
          .map((r) => r.wxId)
          .filter((id): id is string => Boolean(id)),
      );

  const rows = db
    .select()
    .from(groupMembers)
    .where(and(eq(groupMembers.convId, convId), isNull(groupMembers.leftAt)))
    .orderBy(desc(groupMembers.messages))
    .all()
    .filter((m) => !hidden.has(m.wxId));

  return NextResponse.json({
    total: rows.length,
    members: rows.slice(offset, offset + limit).map((m) => ({
      wx_id: m.wxId,
      /* 兜底显示名绝不能退化成 wx_id —— 统一走这一个解析 */
      name: resolveDisplayName([m.displayName, m.wxName], { wxId: m.wxId, fallback: "成员" }),
      messages: m.messages,
      joined_at: m.joinedAt,
    })),
    /*
     * 上游给不了的那几样，写在返回体里而不是等人来问。
     *
     * 「谁是群主」被问得最多，而答案是**上游的成员接口根本没有那个字段**
     * （库里 is_admin 两千多行全是 0）。不写出来的话，
     * 下一个人会先花半天找它，然后得出「文档不全」的结论。
     */
    note: "上游只给昵称、群昵称、发言数 —— 没有群主和管理员字段，也没有踢人接口",
  });
}
