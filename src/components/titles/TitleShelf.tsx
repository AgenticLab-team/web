"use client";

import { Check } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { useToast } from "@/components/ui/Toast";
import { equipTitle } from "@/lib/titles/actions";
import { setAutoRenew } from "@/lib/titles/renew-actions";
import type { OwnedTitle } from "@/lib/titles/queries";
import { rarityColor, rarityLabel } from "@/lib/titles/rules";
import { TitleIcon } from "./TitleIcon";
import { Switch } from "@/components/ui/Switch";

/**
 * 称号架。
 *
 * 三条交互决定它是不是好用：
 *
 *   1. **点一下就换，不需要「保存」。** 佩戴称号是完全可逆的操作，
 *      给它加一步确认只是在制造摩擦。
 *   2. **再点一下就摘下**，同一个按钮。不用去找一个单独的「摘下」入口。
 *   3. **过期的仍然陈列出来，只是变灰**。「我曾经拿到过」也是履历，
 *      直接消失会让人以为系统弄丢了自己的东西。
 *   4. 会到期的称号带自动续费开关，**默认关**。
 *      默认开着的自动续费，会在某人早就不用它的时候每月悄悄扣分 ——
 *      而积分是这个站里唯一的硬通货。
 */
export function TitleShelf({ titles }: { titles: OwnedTitle[] }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();

  if (titles.length === 0) {
    return (
      <p className="t-caption px-1 leading-relaxed text-[var(--ink-tertiary)]">
        还没有称号。连续打卡、在论坛发帖和回复都会解锁 ——
        它们不是靠攒分买的，是靠做过的事拿的。
      </p>
    );
  }

  /** 会到期的（租用 / 赛季）单独列出来 —— 到期要在到期之前看得见 */
  const renewable = titles.filter((t) => t.expiresAt !== null && t.revokedAt === null);

  const flipRenew = (title: OwnedTitle) => {
    startTransition(async () => {
      const result = await setAutoRenew({
        userTitleId: title.userTitleId,
        autoRenew: !title.autoRenew,
      });
      toast.show({
        message: result.ok ? (result.note ?? "已保存") : (result.error ?? "操作失败"),
        kind: result.ok ? "success" : "error",
      });
      if (result.ok) router.refresh();
    });
  };

  const toggle = (title: OwnedTitle) => {
    if (!title.active) return;
    startTransition(async () => {
      const result = await equipTitle(title.equipped ? null : title.titleId);
      if (!result.ok) {
        toast.show({ message: result.error ?? "操作失败", kind: "error" });
        return;
      }
      toast.show({
        message: title.equipped ? "已摘下" : `已佩戴「${title.name}」`,
        kind: "success",
      });
      router.refresh();
    });
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {titles.map((title) => {
          const color = rarityColor(title.rarity);
          return (
            <button
              key={title.userTitleId}
              type="button"
              disabled={!title.active || pending}
              onClick={() => toggle(title)}
              aria-pressed={title.equipped}
              title={title.description ?? undefined}
              className={`tap-target flex items-center gap-1.5 rounded-[var(--radius-pill)] px-3 py-1.5 transition active:scale-[0.97] ${
                title.active ? "" : "opacity-45"
              }`}
              style={{
                background: title.equipped
                  ? `color-mix(in srgb, ${color} 16%, transparent)`
                  : "var(--fill)",
                boxShadow: title.equipped ? `inset 0 0 0 1px ${color}` : undefined,
              }}
            >
              <TitleIcon icon={title.icon} className="h-3.5 w-3.5" />
              <span className="t-footnote font-medium" style={{ color: title.active ? color : undefined }}>
                {title.name}
              </span>
              {title.equipped && (
                <Check className="h-3 w-3" strokeWidth={2.5} style={{ color }} aria-hidden />
              )}
              {title.expired && <span className="t-caption2 text-[var(--ink-quaternary)]">已过期</span>}
              {title.revokedAt !== null && (
                <span className="t-caption2 text-[var(--ink-quaternary)]">已收回</span>
              )}
            </button>
          );
        })}
      </div>

      {/* 会到期的称号单独列一行：到期这件事必须在到期之前就看得见 */}
      {renewable.length > 0 && (
        <div className="inset-group">
          {renewable.map((title) => (
            <div key={title.userTitleId} className="inset-row flex items-start gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="t-subhead flex items-center gap-1.5">
                  <TitleIcon icon={title.icon} />
                  {title.name}
                </p>
                <p className="t-caption mt-0.5 leading-relaxed text-[var(--ink-tertiary)]">
                  {title.expired
                    ? "已到期"
                    : `${title.daysLeft} 天后到期`}
                  {title.renewPrice !== null && ` · 续一次 ${title.renewPrice} 分`}
                  {title.autoRenew ? " · 到期自动续" : " · 到期就摘下"}
                </p>
              </div>

              <Switch on={title.autoRenew} onToggle={() => flipRenew(title)} label={`${title.name} 自动续费`} disabled={pending || title.renewPrice === null} />
            </div>
          ))}
        </div>
      )}

      <p className="t-caption2 px-1 text-[var(--ink-quaternary)]">
        可以持有多个，只能佩戴一个 —— 挂满一排等于都没挂。再点一下取消佩戴。
        {titles.some((t) => t.rarity === "legendary") && (
          <> 其中的{rarityLabel("legendary")}称号有名额上限。</>
        )}
      </p>
    </div>
  );
}
