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
import { listAliases, ownedDomains } from "@/lib/mail/alias";
import { claimableDomains } from "@/lib/mail/claim-queries";
import { listClaimed, slotStatus } from "@/lib/mail/claim";
import { LongTermSection } from "@/components/mail/LongTermSection";
import { ForwardSection } from "@/components/mail/ForwardSection";
import { forwardState } from "@/lib/mail/forward-queries";

export const metadata: Metadata = { title: "邮箱" };
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
  // 转发那一块：站里没配发信服务时它自己不渲染（见组件里那句 return null）
  const forward = forwardState(user.id);

  return (
    <>
      {/*
        * ═════════════════════════════════════════
        * 标题在最上面，一次性箱紧跟着
        * ═════════════════════════════════════════
        *
        * 这一页原来只有一次性箱，后来长出了申领、自有域名、转发四块 ——
        * 而我把它们全插在了 `PageHeader` **前面**。
        * 截图之后才看见：人打开这一页，第一眼是一张没有任何上下文的卡片，
        * 页面标题埋在四张卡片下面。
        *
        * 顺序按「多久看一次」排：
        *   一次性箱   每次要验证码都来 —— 主功能，紧跟标题
        *   我申领的   偶尔看一眼有没有新信、快不快到期
        *   申领新的   想起来才做
        *   自有域名   同上，而且绝大多数人没有
        *   转发       设置，配一次就不再动
        *
        * 而标题本身也改了：这一页早就不只是一次性邮箱了。
        */}
      <PageHeader
        title="邮箱"
        subtitle="收验证码用一次性的，用完就没；长期地址在下面"
      />

      <BurnerScreen
        boxes={boxes}
        messages={messages}
        concurrentLimit={config.burnerConcurrentLimit}
        customMinLength={config.burnerCustomMinLength}
        domains={burnerDomains()}
      />

      <div className="mt-3">
        <LongTermSection
          claimed={claimed}
          aliases={aliases}
          slots={slots}
          claimable={claimable}
          ownedDomains={owned.map((d) => ({ domain: d.domain }))}
        />
      </div>

      <div className="mt-3">
        <ForwardSection state={forward} />
      </div>

      <PageNote>
        这些地址<strong>只收不发</strong>。收到的邮件正文在箱子销毁时一起清掉，
        附件默认不落盘（只留文件名和大小）。
        脚本里也能用 —— 到「我的 → 开放 API」建一把带 <code className="font-mono">mail:burner</code> 的令牌，
        那把令牌只看得到它自己开的箱子。
      </PageNote>
    </>
  );
}
