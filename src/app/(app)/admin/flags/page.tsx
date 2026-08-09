import type { Metadata } from "next";

import { FlagList, OrphanFlags } from "@/components/admin/FlagList";
import { PageHeader } from "@/components/shell/PageHeader";
import { PageNote, Section } from "@/components/ui/primitives";
import { requireAdmin } from "@/lib/admin/guard";
import { listFlagsForAdmin, orphanFlagKeys } from "@/lib/flags/server";

export const metadata: Metadata = { title: "功能开关" };
export const dynamic = "force-dynamic";

/**
 * 功能开关。
 *
 * ─────────────────────────────────────────
 * 在这一页之前，十个开关一个调用点都没有
 * ─────────────────────────────────────────
 *
 * `feature_flags` 表里躺着十行，`isFeatureEnabled` 全站零引用 ——
 * 生产上 `keyword_radar` 和 `shop` 都写着「关」，而那两个页面
 * 照常打得开、照常挂在导航里。
 *
 * schema 上那句注释写着「出问题时先关模块，而不是回滚整站」，
 * 而真出事那一刻去关它，会发现什么都不会发生。
 * 一个只在紧急情况下才会被用到的机制，也只有在紧急情况下
 * 才会被发现是假的 —— 那时候已经来不及了。
 *
 * ─────────────────────────────────────────
 * 后台自己永远不受开关管
 * ─────────────────────────────────────────
 *
 * 一个能把管理后台关掉的开关，按错一次就再也打不开了，
 * 而唯一能重新打开它的地方正是刚被关掉的那一页。
 * 这条写死在代码里（registry 的 NEVER_GATED），不做成配置。
 */
export default async function AdminFlagsPage() {
  await requireAdmin("system.settings");

  const flags = listFlagsForAdmin();
  const orphans = orphanFlagKeys();
  const off = flags.filter((f) => f.status === "wired" && !f.enabled).length;

  return (
    <>
      <PageHeader
        title="功能开关"
        subtitle={off === 0 ? "所有功能都开着" : `有 ${off} 个功能关着`}
      />

      <Section>
        <FlagList flags={flags} />
        <OrphanFlags keys={orphans} />
      </Section>

      <PageNote>
        关掉一个功能之后，导航里的入口会消失，对应页面直接 404 ——
        <b className="font-medium">不是</b>只把入口藏起来：
        只藏入口的话，地址栏敲一下照样进得去。
        <br />
        管理后台、登录页和接口永远不受这些开关影响 ——
        否则按错一次就再也打不开了。
        <br />
        改动会记进审计日志，并且立刻生效。
      </PageNote>
    </>
  );
}
