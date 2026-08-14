import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { BurnerScreen } from "@/components/mail/BurnerScreen";
import { PageHeader } from "@/components/shell/PageHeader";
import { PageNote } from "@/components/ui/primitives";
import { getCurrentUser } from "@/lib/auth/session";
import { requireFeature } from "@/lib/flags/server";
import { listBurnerMessages, listBurners } from "@/lib/mail/burner";
import { mailConfig } from "@/lib/mail/config";
import { burnerDomains } from "@/lib/mail/queries";
import type { BurnerMessageView } from "@/lib/mail/burner";
import { AliasSection } from "@/components/mail/AliasSection";
import { listAliases, ownedDomains } from "@/lib/mail/alias";
import { ClaimSection } from "@/components/mail/ClaimSection";
import { claimableDomains } from "@/lib/mail/claim-queries";
import { listClaimed, slotStatus } from "@/lib/mail/claim";
import { ClaimedSection } from "@/components/mail/ClaimedSection";

export const metadata: Metadata = { title: "一次性邮箱" };
export const dynamic = "force-dynamic";

/**
 * 模式①：一次性邮箱。
 *
 * 页面本身很薄 —— 取数据、判开关，剩下的交给客户端组件，
 * 因为这一页的核心是**倒计时和等待**，两件都只能在客户端发生。
 *
 * 注意 Server Component 往 Client Component **不能传函数**，
 * 传了就是线上 500。这里传下去的全是纯数据。
 */
export default async function BurnerPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/mail/burner");

  requireFeature("temp_mailbox", user);

  const config = mailConfig();
  const boxes = listBurners({ userId: user.id });

  /*
   * 每个箱子的信一次查完。
   *
   * 同时在手最多 3 个，所以这里最多 3 次查询 —— 没必要为它做联表。
   * （上限调大到几十的话要回来改这里。）
   */
  const messages: Record<string, BurnerMessageView[]> = {};
  for (const box of boxes) messages[box.id] = listBurnerMessages(box.id);

  /*
   * 自有域名上的长期地址。
   *
   * `owned` 为空时**整块不渲染** —— 绝大多数人没有自己的域名，
   * 给他们看一个「你没有可用的域名」的空块，只是在告诉他们
   * 有个功能他们用不上。
   */
  const owned = ownedDomains(user.id);
  const aliases = owned.length > 0 ? listAliases(user.id) : [];

  // 申领那一块：没有任何可申领的域名时它自己不渲染（见组件里那句 return null）
  const claimable = claimableDomains();
  const slots = slotStatus(user.id);
  // 申领来的（kind=temp）—— 在这之前它一处都不显示：花了分，然后地址消失了
  const claimed = listClaimed(user.id);

  return (
    <>
      {/* 已经有的排在前面 —— 「我的东西」比「能买什么」要紧 */}
      {claimed.length > 0 && (
        <div className="mb-3">
          <ClaimedSection boxes={claimed} />
        </div>
      )}

      <div className="mb-3">
        <ClaimSection slots={slots} domains={claimable} />
      </div>

      {owned.length > 0 && (
        <div className="mb-3">
          <AliasSection aliases={aliases} domains={owned.map((d) => ({ domain: d.domain }))} />
        </div>
      )}

      <PageHeader
        title="一次性邮箱"
        subtitle={`${config.burnerTtlHours} 小时后自动销毁 · 同时最多 ${config.burnerConcurrentLimit} 个`}
      />

      <BurnerScreen
        boxes={boxes}
        messages={messages}
        concurrentLimit={config.burnerConcurrentLimit}
        customMinLength={config.burnerCustomMinLength}
        domains={burnerDomains()}
      />

      <PageNote>
        这些地址<strong>只收不发</strong>。收到的邮件正文在箱子销毁时一起清掉，
        附件默认不落盘（只留文件名和大小）。
        脚本里也能用 —— 到「我的 → 开放 API」建一把带 <code className="font-mono">mail:burner</code> 的令牌，
        那把令牌只看得到它自己开的箱子。
      </PageNote>
    </>
  );
}
