import type { Metadata } from "next";
import Link from "next/link";

import { OrderActions } from "@/components/admin/OrderActions";
import { relativeTime } from "@/components/forum/PostList";
import { PageHeader } from "@/components/shell/PageHeader";
import { Pagination } from "@/components/ui/Pagination";
import { Empty, Section } from "@/components/ui/primitives";
import { requireAdmin } from "@/lib/admin/guard";
import { listItems, pagedOrders, pendingShipments } from "@/lib/shop/queries";

export const metadata: Metadata = { title: "商店与订单" };
export const dynamic = "force-dynamic";

/**
 * 商店后台。
 *
 * 待发货放最前面 —— 虚拟商品自动交付，只有实物会积压，
 * 而**积压久了就是失信**：用户花掉的分是真的没了，东西却没到。
 */
export default async function AdminShopPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const admin = await requireAdmin("shop.manage");
  const params = await searchParams;

  const items = listItems(true);
  // 副标题里的订单数必须是单独 count 出来的总数 ——
  // 以前用 rows.length，列表截到 60 条，副标题就跟着谎报「共 60 笔」
  const { rows: orders, total: orderTotal, slice } = pagedOrders({ page: params.page });
  const pending = pendingShipments();

  const drifted = items.filter((i) => i.drifted);

  return (
    <>
      <PageHeader
        title="商店与订单"
        subtitle={`${items.length} 个商品 · ${orderTotal} 笔订单`}
      />

      {pending.length > 0 && (
        <div
          className="mb-4 rounded-[var(--radius-card)] p-4 hairline"
          style={{ background: "color-mix(in srgb, var(--warning) 9%, var(--surface))" }}
        >
          <p className="t-subhead font-medium" style={{ color: "var(--warning)" }}>
            {pending.length} 笔实物订单待发货
          </p>
          <p className="t-caption mt-1 leading-relaxed text-[var(--ink-secondary)]">
            用户花掉的分是真的没了，东西却还没到 —— 积压久了就是失信。
          </p>
        </div>
      )}

      {drifted.length > 0 && (
        <div
          className="mb-4 rounded-[var(--radius-card)] p-4 hairline"
          style={{ background: "color-mix(in srgb, var(--danger) 9%, var(--surface))" }}
        >
          <p className="t-subhead font-medium" style={{ color: "var(--danger)" }}>
            {drifted.length} 个商品的卖出数与订单数对不上
          </p>
          <p className="t-caption mt-1 text-[var(--ink-secondary)]">
            {drifted.map((i) => `${i.name}（记 ${i.sold}）`).join("、")}。
            库存数错了会导致超卖或永远卖不完，先查清楚再继续上架。
          </p>
        </div>
      )}

      <Section title="商品">
        {items.length === 0 ? (
          <Empty
            title="还没有商品"
            hint="积分现在只进不出 —— 上架些能花积分的东西，积分才真正代表点什么"
          />
        ) : (
          <div className="inset-group">
            {items.map((item) => (
              <div key={item.id} className="inset-row flex items-center gap-2 px-4 py-2.5">
                {item.icon && <span className="shrink-0">{item.icon}</span>}
                <span className={`t-body min-w-0 flex-1 truncate ${item.enabled ? "" : "opacity-45"}`}>
                  {item.name}
                  <span className="t-caption2 ml-1.5 text-[var(--ink-quaternary)]">
                    {item.kindLabel}
                    {!item.enabled && " · 已下架"}
                  </span>
                </span>
                <span className="tabular t-caption shrink-0 text-[var(--ink-tertiary)]">
                  {item.price} 分
                  {item.remaining !== null && ` · 剩 ${item.remaining}`}
                  {item.sold > 0 && ` · 卖出 ${item.sold}`}
                </span>
              </div>
            ))}
          </div>
        )}
        <p className="t-caption mt-2 px-1 leading-relaxed text-[var(--ink-tertiary)]">
          商品目前通过 <code className="font-mono">npm run seed-shop</code> 初始化。
          价格调整会影响后续兑换，但<strong>已有订单按下单时的价格记账</strong> ——
          事后调价不影响对账。
        </p>
      </Section>

      <Section title="订单">
        {orders.length === 0 ? (
          <Empty title="还没有订单" />
        ) : (
          <div className="space-y-2">
            {orders.map((order) => (
              <article
                key={order.id}
                className="rounded-[var(--radius-card)] bg-[var(--surface)] p-3.5 hairline"
              >
                <p className="t-body flex flex-wrap items-center gap-1.5">
                  <span>{order.itemName}</span>
                  <Link href={`/admin/users/${order.userId}`} className="t-caption text-[var(--ink-tertiary)]">
                    {order.userName}
                  </Link>
                  <span className="t-caption2 text-[var(--ink-quaternary)]">
                    {order.statusLabel}
                  </span>
                  <span className="tabular t-caption ml-auto text-[var(--ink-quaternary)]">
                    {order.pricePaid} 分 · {relativeTime(order.createdAt)}
                  </span>
                </p>

                {order.shipping && (
                  <p className="t-caption mt-1 text-[var(--ink-secondary)]">
                    {String(order.shipping.name ?? "")} · {String(order.shipping.phone ?? "")} ·{" "}
                    {String(order.shipping.address ?? "")}
                  </p>
                )}

                {/* 交付出问题的订单要显眼 —— 用户已经付了分 */}
                {typeof order.fulfillResult?.error === "string" && (
                  <p className="t-caption mt-1" style={{ color: "var(--danger)" }}>
                    自动交付失败：{String(order.fulfillResult.error ?? "未知原因")}
                  </p>
                )}

                {order.refundReason && (
                  <p className="t-caption mt-1 text-[var(--ink-tertiary)]">
                    已退款：{order.refundReason}
                  </p>
                )}

                {admin.has("shop.order.handle") && (
                  <OrderActions id={order.id} status={order.status} />
                )}
              </article>
            ))}
          </div>
        )}
        <Pagination
          slice={slice}
          total={orderTotal}
          noun="笔订单"
          basePath="/admin/shop"
        />
      </Section>

      <p className="t-caption px-1 pb-4 leading-relaxed text-[var(--ink-tertiary)]">
        退款走<strong>冲正</strong>而不是凭空加分 —— 凭空加的话积分总量会悄悄多出来，
        而通胀体检看到「有人白拿了分」却查不出源头。退款同时会把库存还回去。
      </p>
    </>
  );
}
