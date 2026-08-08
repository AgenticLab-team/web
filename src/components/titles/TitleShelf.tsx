"use client";

import { Check } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { useToast } from "@/components/ui/Toast";
import { equipTitle } from "@/lib/titles/actions";
import type { OwnedTitle } from "@/lib/titles/queries";
import { rarityColor, rarityLabel } from "@/lib/titles/rules";

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
              className={`flex items-center gap-1.5 rounded-[var(--radius-pill)] px-3 py-1.5 transition active:scale-[0.97] ${
                title.active ? "" : "opacity-45"
              }`}
              style={{
                background: title.equipped
                  ? `color-mix(in srgb, ${color} 16%, transparent)`
                  : "var(--fill)",
                boxShadow: title.equipped ? `inset 0 0 0 1px ${color}` : undefined,
              }}
            >
              {title.icon && <span aria-hidden>{title.icon}</span>}
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

      <p className="t-caption2 px-1 text-[var(--ink-quaternary)]">
        可以持有多个，只能佩戴一个 —— 挂满一排等于都没挂。再点一下取消佩戴。
        {titles.some((t) => t.rarity === "legendary") && (
          <> 其中的{rarityLabel("legendary")}称号有名额上限。</>
        )}
      </p>
    </div>
  );
}
