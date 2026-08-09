import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { getCurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

/**
 * 按账号 id 跳到成员主页。
 *
 * ─────────────────────────────────────────
 * 为什么绕这一道
 * ─────────────────────────────────────────
 *
 * 主页的正式地址是 `/members/<wx_id>`。而成员目录**刻意不把 wx_id
 * 放进返回结构**（见 lib/members/queries.ts 里那段注释与
 * tests/member-directory.test.ts ④）—— 它会被序列化进 RSC 载荷，
 * 出现在网页源码里。
 *
 * 那条规矩值得守：目录里列的是所有同群的人，**包括从没在群里
 * 说过话的**。他们的 wx_id 在别处拿不到（群聊存档里只有开过口的人），
 * 而拿着 wx_id 就能在微信里直接把人加上。一次「让头像可以点」
 * 不该顺带把一群沉默的人的微信号摊在页面源码里。
 *
 * 所以目录链到这里 —— 账号 id 本来就在那个结构里（列表的 key 用它）——
 * 由服务端换成 wx_id 再跳过去。**只有真的点开的那个人**的 wx_id
 * 会出现在地址栏，而不是一整页人的。
 *
 * 这一页放在 `(app)` 外面：它只跳转、不渲染任何东西，
 * 摆进外壳里等于为一次重定向渲染整套侧栏和 Tab 栏。
 */
export default async function MemberByIdPage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  const { userId } = await params;

  // 要登录 —— 这条路等价于打开主页，门槛不能比主页低
  const me = await getCurrentUser();
  if (!me) notFound();

  const row = db.select({ wxId: users.wxId }).from(users).where(eq(users.id, userId)).get();

  /*
   * 查不到、或者这个人没绑微信 —— 一律 404。
   *
   * 不区分两者：区分了就等于回答「这个账号 id 存在吗」。
   * 真正的可见性判定在主页那一页（只有同群的人打得开），
   * 这里只做一次翻译，不放宽任何东西。
   */
  if (!row?.wxId) notFound();

  redirect(`/members/${encodeURIComponent(row.wxId)}`);
}
