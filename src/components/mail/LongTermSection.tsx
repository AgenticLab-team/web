"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { AliasCreate, AliasRows } from "@/components/mail/AliasSection";
import { ClaimForm } from "@/components/mail/ClaimSection";
import { ClaimedRows } from "@/components/mail/ClaimedSection";
import { Card, buttonClass } from "@/components/ui/primitives";
import type { AliasView } from "@/lib/mail/alias";
import type { ClaimedView } from "@/lib/mail/claim";

/**
 * 长期地址 —— **申领来的和自有域名上的，收进同一张卡**。
 *
 * ═════════════════════════════════════════
 * 为什么合并
 * ═════════════════════════════════════════
 *
 * 原来这一页上有两张几乎同名的卡片：
 *
 *   「我申领的地址」   —— 公共池里租来的，一年一续
 *   「我的长期地址」   —— 自己域名上开的，不过期
 *
 * 两个名字看不出差别，而它们中间还夹着第三张「申领一个长期地址」。
 * 站长的原话是「ui 奇差」「点开只有我自己的两个域名」——
 * 后半句正是这个结构造成的：公共池那几十个域名当时全是待核状态、
 * 申领那块空着，于是屏幕上只剩「我的长期地址」里他自己那两个。
 * 页面看起来像**只支持自有域名**，而实际是另一半被卡住了。
 *
 * 合并之后：一个标题、一份列表，每行自己说清楚是哪一种、什么时候到期。
 * 「再开一个」也收成一处 —— 原来一个在卡片标题栏里、
 * 一个是整张独立卡片，人得先弄明白这两张卡的区别才知道该点哪个。
 *
 * ─────────────────────────────────────────
 * 空态要说清楚**为什么空**
 * ─────────────────────────────────────────
 *
 * 一句「还没有长期地址」会让人以为是自己没开。而实际可能是
 * 公共池一个域名都没放出来（管理员还没把域名转正）——
 * 那种情况下他再点一百次也开不出来。
 */
export function LongTermSection({
  claimed,
  aliases,
  slots,
  claimable,
  ownedDomains,
  level,
  points,
}: {
  claimed: ClaimedView[];
  aliases: AliasView[];
  slots: { total: number; used: number };
  /** 公共池里现在能申领的域名。空数组 = 管理员还没放出来 */
  claimable: React.ComponentProps<typeof ClaimForm>["domains"];
  /** 我自己拥有的域名。空数组 = 这条路对我不存在 */
  ownedDomains: { domain: string }[];
  /** 我的等级和余额 —— 申领那一栏靠它们在**挑之前**就说清楚够不够得着 */
  level: number;
  points: number;
}) {
  const router = useRouter();
  /** 打开哪个「再开一个」的表单。同时只开一个 —— 两个表单并排会让人不知道该填哪个 */
  const [opening, setOpening] = useState<"claim" | "alias" | null>(null);

  const total = claimed.length + aliases.length;

  return (
    <Card>
      <div className="flex items-baseline gap-2">
        <h2 className="t-headline">长期地址</h2>
        {slots.total > 0 && (
          <span className="tabular t-caption2 ml-auto text-[var(--ink-tertiary)]">
            槽位 {slots.used}/{slots.total}
          </span>
        )}
      </div>

      <p className="t-caption mt-1 text-[var(--ink-tertiary)]">
        可以写进别人的通讯录 —— 上面那种 24 小时就销毁
      </p>

      {total > 0 ? (
        <div className="mt-3 space-y-1.5">
          <ClaimedRows boxes={claimed} />
          <AliasRows aliases={aliases} onRemoved={() => router.refresh()} />
        </div>
      ) : (
        <p className="t-caption mt-3 leading-relaxed text-[var(--ink-tertiary)]">
          还没有。
          {claimable.length === 0 && ownedDomains.length === 0
            ? "公共池现在一个域名都没放出来，而你也还没有自己的域名 —— 这一栏暂时开不了。"
            : claimable.length === 0
              ? "公共池现在一个域名都没放出来（管理员那边还没把域名转正），不过你可以用自己的域名开一个。"
              : "花分从公共池申领一个，或者用自己的域名开。"}
        </p>
      )}

      {/*
        * 两个入口摆在一起。
        *
        * 原来它们分散在两张卡上（一个在标题栏里的小加号、一个是整张
        * 独立卡片），于是「我该点哪个」这个问题得先弄懂两张卡的区别
        * 才答得上来 —— 而那正是这一页最不该让人费劲的地方。
        */}
      {(claimable.length > 0 || ownedDomains.length > 0) && (
        <div className="mt-3 flex flex-wrap gap-x-1.5 gap-y-3.5 border-t border-[var(--separator)] pt-3">
          {claimable.length > 0 && (
            <button
              className={buttonClass(opening === "claim" ? "primary" : "quiet", "sm")}
              onClick={() => setOpening(opening === "claim" ? null : "claim")}
            >
              从公共池申领
            </button>
          )}
          {ownedDomains.length > 0 && (
            <button
              className={buttonClass(opening === "alias" ? "primary" : "quiet", "sm")}
              onClick={() => setOpening(opening === "alias" ? null : "alias")}
            >
              用自己的域名开
            </button>
          )}
        </div>
      )}

      {/*
        * 有地址、但公共池是空的 —— 也要说一句为什么。
        *
        * 这正是站长撞上的那一屏：他有一个自有域名地址，
        * 于是空态那段话不显示；而「从公共池申领」那个按钮因为池子空
        * 也不显示 —— 页面看起来就像**只支持自有域名**。
        * 少一个按钮不会引起怀疑，而那恰恰是最该解释的时候。
        */}
      {total > 0 && claimable.length === 0 && (
        <p className="t-caption2 mt-2 text-[var(--ink-tertiary)]">
          公共池现在没有可申领的域名（管理员那边还没把域名转正）
        </p>
      )}

      {opening === "claim" && (
        <div className="mt-3">
          <ClaimForm slots={slots} domains={claimable} level={level} points={points} />
        </div>
      )}
      {opening === "alias" && (
        <div className="mt-3">
          <AliasCreate
            domains={ownedDomains}
            onDone={() => {
              setOpening(null);
              router.refresh();
            }}
          />
        </div>
      )}
    </Card>
  );
}
