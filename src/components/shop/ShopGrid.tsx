"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { useToast } from "@/components/ui/Toast";
import { buyItem } from "@/lib/shop/actions";
import type { ItemRow } from "@/lib/shop/queries";

/**
 * 商店。
 *
 * 三条：
 *
 * ① **买不起时显示还差多少**，而不是把按钮灰掉。
 *   「还差 120 分」是一个能去够的目标。
 *
 * ② **实物商品的地址在点击之后才问**，而不是一直摆在页面上 ——
 *   大多数商品是虚拟的，让所有人都先看到一堆地址输入框是噪音。
 *
 * ③ 每次点击带一个一次性 token，**重复点不会扣两次分**。
 *   积分是有价值的东西，重复扣一次就要人工去查去退。
 */
export function ShopGrid({
  items,
  balance,
  owned,
  loggedIn,
}: {
  items: ItemRow[];
  balance: number;
  owned: Record<string, number>;
  loggedIn: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [shippingFor, setShippingFor] = useState<string | null>(null);
  const [shipping, setShipping] = useState({ name: "", phone: "", address: "" });

  const buy = (item: ItemRow, ship?: Record<string, unknown>) => {
    startTransition(async () => {
      const result = await buyItem({
        itemKey: item.key,
        shipping: ship,
        // 一次性 token：重复点击会命中幂等键，不会扣两次分
        clientToken: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      });

      if (!result.ok) {
        toast.show({ message: result.error ?? "兑换失败", kind: "error" });
        return;
      }
      toast.show({ message: result.note ?? "兑换成功", kind: "success" });
      setShippingFor(null);
      setShipping({ name: "", phone: "", address: "" });
      router.refresh();
    });
  };

  if (items.length === 0) {
    return (
      <p className="t-caption px-1 leading-relaxed text-[var(--ink-tertiary)]">
        商店里还没有东西。积分现在只进不出 —— 上架一些能花积分的东西之后，
        积分才真正代表点什么。
      </p>
    );
  }

  return (
    <div className="space-y-2.5">
      {items.map((item) => {
        const ownedCount = owned[item.id] ?? 0;
        const soldOut = item.remaining !== null && item.remaining <= 0;
        const limitReached = item.perUserLimit !== null && ownedCount >= item.perUserLimit;
        const short = balance < item.price;

        return (
          <article
            key={item.id}
            className="rounded-[var(--radius-card)] bg-[var(--surface)] p-4 hairline"
          >
            <div className="flex items-start gap-3">
              {item.icon && <span className="text-[26px] leading-none">{item.icon}</span>}

              <div className="min-w-0 flex-1">
                <p className="t-body flex flex-wrap items-center gap-1.5">
                  <span className="font-medium">{item.name}</span>
                  <span className="t-caption2 rounded-[var(--radius-pill)] bg-[var(--fill)] px-1.5 py-0.5 text-[var(--ink-tertiary)]">
                    {item.kindLabel}
                  </span>
                </p>

                {item.description && (
                  <p className="t-caption mt-0.5 leading-relaxed text-[var(--ink-tertiary)]">
                    {item.description}
                  </p>
                )}

                <p className="tabular t-caption mt-1 text-[var(--ink-quaternary)]">
                  {item.remaining !== null && `还剩 ${item.remaining} 件 · `}
                  {item.perUserLimit !== null && `每人限 ${item.perUserLimit} 件 · `}
                  已兑换 {item.sold} 次
                </p>
              </div>

              <div className="shrink-0 text-right">
                <p className="tabular t-title3 leading-none">{item.price}</p>
                <p className="t-caption2 text-[var(--ink-quaternary)]">分</p>
              </div>
            </div>

            <div className="mt-3">
              {!loggedIn ? (
                <p className="t-caption text-[var(--ink-tertiary)]">登录后可以兑换</p>
              ) : soldOut ? (
                <p className="t-caption text-[var(--ink-tertiary)]">已经兑换完了</p>
              ) : limitReached ? (
                <p className="t-caption text-[var(--ink-tertiary)]">
                  你已经兑换过了{item.perUserLimit! > 1 && `（上限 ${item.perUserLimit} 次）`}
                </p>
              ) : short ? (
                // 「还差 120 分」是能去够的目标，灰按钮不是
                <p className="t-caption" style={{ color: "var(--warning)" }}>
                  还差 {item.price - balance} 分
                </p>
              ) : shippingFor === item.id ? (
                <div className="animate-rise space-y-2">
                  <input
                    value={shipping.name}
                    onChange={(e) => setShipping({ ...shipping, name: e.target.value })}
                    placeholder="收件人"
                    className={inputClass}
                  />
                  <input
                    value={shipping.phone}
                    onChange={(e) => setShipping({ ...shipping, phone: e.target.value })}
                    placeholder="手机号"
                    className={inputClass}
                  />
                  <input
                    value={shipping.address}
                    onChange={(e) => setShipping({ ...shipping, address: e.target.value })}
                    placeholder="收货地址"
                    className={inputClass}
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={
                        pending || !shipping.name.trim() || !shipping.address.trim()
                      }
                      onClick={() => buy(item, { ...shipping })}
                      className="t-subhead flex-1 rounded-[var(--radius-control)] bg-[var(--accent)] px-4 py-2 font-medium text-[var(--accent-ink)] disabled:opacity-40"
                    >
                      确认兑换（{item.price} 分）
                    </button>
                    <button
                      type="button"
                      onClick={() => setShippingFor(null)}
                      className="t-subhead rounded-[var(--radius-control)] bg-[var(--fill)] px-4 py-2 text-[var(--ink-secondary)]"
                    >
                      取消
                    </button>
                  </div>
                  <p className="t-caption2 text-[var(--ink-quaternary)]">
                    地址只用于这次发货，管理员之外没有人能看到。
                  </p>
                </div>
              ) : (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    item.kind === "physical" ? setShippingFor(item.id) : buy(item)
                  }
                  className="t-subhead w-full rounded-[var(--radius-control)] bg-[var(--accent)] px-4 py-2 font-medium text-[var(--accent-ink)] disabled:opacity-40"
                >
                  {item.kind === "physical" ? "填写收货信息" : `兑换（${item.price} 分）`}
                </button>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}

const inputClass =
  "t-subhead w-full rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2 outline-none placeholder:text-[var(--ink-quaternary)]";
