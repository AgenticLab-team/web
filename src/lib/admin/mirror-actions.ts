"use server";

import { requireAdmin } from "@/lib/admin/guard";
import { auditMirror, type MirrorAudit } from "@/lib/admin/mirror-audit";

/**
 * 手动跑一次镜像对账。
 *
 * ─────────────────────────────────────────
 * 为什么是按钮，不是页面加载时自动跑
 * ─────────────────────────────────────────
 *
 * 它要对**每一个群**问一次上游。挂在页面渲染里的话：
 *
 *   · 后台这一页每打开一次就打 12 个上游请求，而上游有配额
 *   · 上游慢一点，整页跟着卡在那儿 —— 而这一页上别的数字
 *     全部来自本地，本来是瞬间的
 *   · 上游挂掉时这一页会连带挂掉，恰恰是最需要看它的时候
 *
 * 所以：想知道的时候点一下，结果当场给。**不存**，
 * 存下来的「上次对账通过」会随着时间慢慢变成谎话，
 * 而对账正是用来识破谎话的。
 */
export async function runMirrorAudit(): Promise<
  { ok: true; audit: MirrorAudit } | { ok: false; error: string }
> {
  /*
   * 只读操作，所以是 requireAdmin 而不是 requireWritableAdmin ——
   * 它一个字节都不写库。
   */
  await requireAdmin(["group.manage", "group.stats.read"]);

  try {
    return { ok: true, audit: await auditMirror() };
  } catch (error) {
    /*
     * 整体失败（比如隧道断了）也要**如实说**，
     * 不能返回一份「全部正常」的空对账 —— 那是这一页最坏的形态。
     */
    return { ok: false, error: error instanceof Error ? error.message : "对账失败" };
  }
}
