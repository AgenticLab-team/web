import { NextResponse } from "next/server";

import { authenticate } from "@/lib/api-tokens/auth";
import { ADMIN_SECTIONS } from "@/lib/admin/api-registry";
import { can } from "@/lib/rbac/can";

export const dynamic = "force-dynamic";

/**
 * 我能进后台的哪几个分区。
 *
 * ═════════════════════════════════════════
 * **按人算过的**，而不是一份写死的清单
 * ═════════════════════════════════════════
 *
 * 这条接口存在的理由和 `/api/v1/docs` 一模一样：
 * 一份写死的清单描述的是**另一个人的世界**。
 * 一个只有审计权限的人照着它调，会拿回一串 403，
 * 然后开始怀疑是自己写错了。
 *
 * 终端最左那一竖里后台底下列哪几项，读的就是这条 ——
 * 而不是在 Go 那边写死三十个入口。写死的话，
 * 那个只有审计权限的人会看到一整排点进去是 403 的入口。
 *
 * ─────────────────────────────────────────
 * 动作的字段表也一起给
 * ─────────────────────────────────────────
 *
 * 终端靠它画表单。不给的话，Go 那侧只能为三十个分区各写一份表单，
 * 而后台加一个字段时那三十份里没有一份会知道。
 */
export async function GET(request: Request) {
  const auth = await authenticate(request, ["admin:all"]);
  if (!auth.ok) return auth.response;

  const { user } = auth.caller;

  const sections = ADMIN_SECTIONS.filter((s) => can(user, s.permission).allowed).map((s) => ({
    key: s.key,
    label: s.label,
    description: s.description,
    permission: s.permission,
    actions: s.actions.map((a) => ({
      key: a.key,
      label: a.label,
      danger: a.danger ?? 0,
      /* 危险级 ≥2 的要显式确认，终端据此多问一句 */
      needs_confirm: (a.danger ?? 0) >= 2,
      fields: a.fields,
    })),
  }));

  return NextResponse.json({
    sections,
    /*
     * 被挡下的那几个也列出来，只给名字和缺哪个权限。
     *
     * 这和 `/api/v1/docs` 里 `unavailable` 那一栏是同一个用意：
     * 「有这个东西但你进不去」和「没有这个东西」是两件事，
     * 而后者会让人去找一个不存在的功能。
     */
    unavailable: ADMIN_SECTIONS.filter((s) => !can(user, s.permission).allowed).map((s) => ({
      key: s.key,
      label: s.label,
      needs_permission: s.permission,
    })),
  });
}
