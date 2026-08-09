import type { Metadata } from "next";

import { relativeTime } from "@/components/forum/PostList";
import { ShopGrid } from "@/components/shop/ShopGrid";
import { PageHeader } from "@/components/shell/PageHeader";
import { Callout, PageNote, Section } from "@/components/ui/primitives";
import { requireFeature } from "@/lib/flags/server";
import { getCurrentUser } from "@/lib/auth/session";
import { listItems, listOrders, ownedCounts, unusedMakeupCards , pinnablePosts } from "@/lib/shop/queries";

export const metadata: Metadata = { title: "商店" };
export const dynamic = "force-dynamic";

/**
 * 商店。
 *
 * 它在这套系统里的位置不是「多一个玩法」，是**积分的主要回收口** ——
 * 只发不收的积分一年后必然废掉：商店价格变成笑话、新人永远追不上老人、
 * 积分不再代表任何东西，于是也没人再为它做事。
 *
 * 所以这一页真正的作用是让「攒积分」这件事有意义。
 */
export default async function ShopPage() {
  const user = await getCurrentUser();
  // 功能开关：关掉之后这一页 404 —— 只藏导航的话，地址栏敲一下照样进得去
  requireFeature("shop", user);

  const items = listItems();
  const owned = user ? ownedCounts(user.id) : new Map<string, number>();
  const myOrders = user ? listOrders({ userId: user.id, limit: 20 }) : [];
  const cards = user ? unusedMakeupCards(user.id) : 0;
  const pinnable = user ? pinnablePosts(user.id) : [];

  return (
    <>
      <PageHeader
        title="商店"
        subtitle={user ? `你有 ${user.points} 分` : "登录后可以兑换"}
      />

      {cards > 0 && (
        <Callout title={`你还有 ${cards} 张补签卡没用`}>
          <p className="t-caption mt-0.5 text-[var(--ink-tertiary)]">
            断签的那天可以补回来 —— 连胜不会因为一次忘记就归零。
          </p>
        </Callout>
      )}

      <Section>
        <ShopGrid
          items={items}
          balance={user?.points ?? 0}
          owned={Object.fromEntries(owned)}
          loggedIn={Boolean(user)}
          pinnable={pinnable}
        />
      </Section>

      {myOrders.length > 0 && (
        <Section title="我的兑换">
          <div className="inset-group">
            {myOrders.map((order) => (
              <div key={order.id} className="inset-row px-4 py-2.5">
                <p className="t-body flex flex-wrap items-center gap-1.5">
                  <span>{order.itemName}</span>
                  <span className="t-caption2 text-[var(--ink-quaternary)]">
                    {order.statusLabel}
                  </span>
                  <span className="tabular t-caption ml-auto text-[var(--ink-quaternary)]">
                    {order.pricePaid} 分 · {relativeTime(order.createdAt)}
                  </span>
                </p>

                {order.trackingNo && (
                  <p className="t-caption mt-0.5 font-mono text-[var(--ink-tertiary)]">
                    运单号 {order.trackingNo}
                  </p>
                )}
                {order.refundReason && (
                  <p className="t-caption mt-0.5 text-[var(--ink-tertiary)]">
                    已退款：{order.refundReason}
                  </p>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}

      <PageNote>
        兑换会真正<strong>销毁</strong>这些积分，而不是转给谁 ——
        这是积分能一直代表点什么的原因。只发不收的话，一年后所有价格都要重定，
        而重定价格等于宣布之前攒的都不算数。
      </PageNote>
    </>
  );
}
