"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { AdminButton, AdminNote } from "@/components/admin/ui";
import { useToast } from "@/components/ui/Toast";
import { activateVerifiedDomains } from "@/lib/mail/admin-actions";

/**
 * 把体检过、三个灯全绿的待核域名批量转正。
 *
 * ═════════════════════════════════════════
 * 这个按钮补的是一条**根本不存在的路**
 * ═════════════════════════════════════════
 *
 * 域名是按「待核」建进池子的（MX 还没配之前放出去，人会申领到一个
 * 收不到信的地址）—— 这一步是对的。缺的是从待核**出来**的那条路：
 * `updateDomain` 的参数表里原来没有 `status`，也没有脚本、没有定时任务
 * 会去改它。
 *
 * 于是线上一百个域名全卡在待核。而申领长期地址要求「已启用」，
 * 一次性箱那条路只看 `enabled` / `allowBurner`、绕过了这道卡 ——
 * 表现就成了「站上只有一次性邮箱」，而看起来完全不像是被卡住了。
 *
 * ─────────────────────────────────────────
 * 为什么不做成「全选 → 改状态」
 * ─────────────────────────────────────────
 *
 * 那种自由度在这里恰好是危险的：一个 MX 没配对的域名转正之后，
 * 人可以花 400 分申领上去，然后**收不到任何信** ——
 * 而他要等到拿它去注册某个服务时才发现。
 *
 * 所以这个按钮和体检绑死：只动「三个灯全绿」的那些，
 * 没体检过的一个都不碰，并且把跳过了多少、为什么跳过说出来。
 */
export function ActivateDomains({ pendingCount }: { pendingCount: number }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [done, setDone] = useState<string | null>(null);

  if (pendingCount === 0) return null;

  const run = () =>
    start(async () => {
      const r = await activateVerifiedDomains();
      if (!r.ok) {
        toast.show({ message: r.error ?? "没转成", kind: "error" });
        return;
      }
      /*
       * 把「跳过了多少」也说出来。
       *
       * 只说「转正了 63 个」的话，剩下那 37 个会被当成已经处理完 ——
       * 而它们恰恰是需要人再做一件事的那些（去跑一次体检，或者去修 DNS）。
       */
      const parts = [`转正 ${r.activated ?? 0} 个`];
      if (r.skippedUnchecked) parts.push(`跳过 ${r.skippedUnchecked} 个（还没体检过）`);
      if (r.skippedBad) parts.push(`跳过 ${r.skippedBad} 个（DNS 有问题）`);
      const summary = parts.join("，");
      setDone(summary);
      toast.show({ message: summary, kind: "success" });
      router.refresh();
    });

  return (
    <div className="mb-3">
      <AdminButton tone="primary" onClick={run} disabled={pending}>
        {pending ? "转着…" : `把体检合格的待核域名转正（现有 ${pendingCount} 个待核）`}
      </AdminButton>
      <AdminNote>
        只动三个灯全绿的那些。没体检过的不碰 —— 先跑 <code>npm run mail-dns</code>。
        转正之后它们会出现在申领页上。
      </AdminNote>
      {done && <AdminNote>{done}</AdminNote>}
    </div>
  );
}
