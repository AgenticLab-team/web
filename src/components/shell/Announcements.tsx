"use client";

import { Megaphone, X } from "lucide-react";
import { useState, useTransition } from "react";

import { dismiss } from "@/lib/broadcast/announce-actions";

/**
 * 站内公告。
 *
 * ─────────────────────────────────────────
 * 关掉要立刻消失
 * ─────────────────────────────────────────
 *
 * 等服务端回来再消失的话，那零点几秒里横幅还在，人会再点一次 ——
 * 而第二次点的是同一条，看起来像「关不掉」。所以先从界面上拿走，
 * 失败了也不放回来：一条公告没关成的代价，比一个关不掉的横幅小得多。
 *
 * ─────────────────────────────────────────
 * 打断式的那个不给「稍后」
 * ─────────────────────────────────────────
 *
 * 它盖住整页，只有一个「知道了」。给「稍后再说」的话，
 * 它就退化成一个更烦人的横幅 —— 而**能被推迟的事，
 * 本来就不该用打断式**。这条限制是给发公告的人的，不是给读者的。
 */

export interface AnnouncementView {
  id: string;
  title: string | null;
  /** 已经渲染好的 HTML —— 和帖子正文走同一条消毒管线 */
  html: string;
}

export function Announcements({
  banners: initialBanners,
  modal: initialModal,
}: {
  banners: AnnouncementView[];
  modal: AnnouncementView | null;
}) {
  const [banners, setBanners] = useState(initialBanners);
  const [modal, setModal] = useState(initialModal);
  const [, startTransition] = useTransition();

  const close = (id: string, kind: "banner" | "modal") => {
    // 先从界面上拿走，再去写库
    if (kind === "modal") setModal(null);
    else setBanners((list) => list.filter((a) => a.id !== id));
    startTransition(async () => {
      await dismiss(id);
    });
  };

  return (
    <>
      {banners.map((a) => (
        <div
          key={a.id}
          className="flex items-start gap-2.5 border-b border-[var(--separator)] bg-[color-mix(in_srgb,var(--accent)_10%,var(--surface))] px-4 py-2.5"
          role="status"
        >
          <Megaphone
            className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent)]"
            strokeWidth={2}
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            {a.title && <p className="t-subhead font-medium">{a.title}</p>}
            {/* 和帖子正文同一条渲染管线，所以支持链接和加粗 —— 一条公告
                常常需要给一个链接，而「详见某某页」写成纯文本等于没给 */}
            <div
              className="prose-forum t-caption leading-relaxed"
              dangerouslySetInnerHTML={{ __html: a.html }}
            />
          </div>
          <button
            type="button"
            onClick={() => close(a.id, "banner")}
            aria-label="关掉这条公告"
            className="tap-target -m-1.5 shrink-0 rounded-[0.375rem] p-1.5 text-[var(--ink-tertiary)] transition-colors hover:bg-[var(--fill)] hover:text-[var(--ink)]"
          >
            <X className="h-4 w-4" strokeWidth={2} aria-hidden />
          </button>
        </div>
      ))}

      {modal && (
        <div
          className="fixed inset-0 z-[200] flex items-end justify-center bg-black/40 p-4 sm:items-center"
          role="dialog"
          aria-modal="true"
          aria-labelledby={`ann-${modal.id}`}
        >
          {/*
            * 手机端从底部起、桌面端居中 —— 底部是拇指够得到的地方，
            * 而这个框唯一的按钮在最下面。
            */}
          <div className="w-full max-w-md rounded-[var(--radius-card)] bg-[var(--surface)] p-5 shadow-lg">
            <p id={`ann-${modal.id}`} className="t-headline flex items-center gap-2 font-medium">
              <Megaphone className="h-4 w-4 text-[var(--accent)]" strokeWidth={2} aria-hidden />
              {modal.title ?? "公告"}
            </p>
            <div
              className="prose-forum t-subhead mt-2 leading-relaxed"
              dangerouslySetInnerHTML={{ __html: modal.html }}
            />
            <button
              type="button"
              onClick={() => close(modal.id, "modal")}
              className="t-subhead mt-4 w-full rounded-[var(--radius-control)] bg-[var(--accent)] px-4 py-2.5 font-medium text-[var(--accent-ink)] transition active:scale-[0.99]"
            >
              知道了
            </button>
          </div>
        </div>
      )}
    </>
  );
}
