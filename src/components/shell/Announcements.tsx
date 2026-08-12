"use client";

import { Megaphone, X } from "lucide-react";
import { useEffect, useRef, useState, useTransition } from "react";

import { Callout } from "@/components/ui/primitives";
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
 *
 * ─────────────────────────────────────────
 * 它是原生 <dialog>，不是一个 position:fixed 的 div
 * ─────────────────────────────────────────
 *
 * 原来那个盖满屏幕的 div 有 `role="dialog" aria-modal="true"`，
 * 但**焦点根本没被关住**：Tab 一路走到后面那一整页去了，
 * 而屏幕上什么都没变 —— 键盘用户会以为界面卡死了。
 * Esc 也没有反应。原生 <dialog> 把焦点陷阱、惰性区域和 Esc 一起给了。
 *
 * Esc 按下去算「知道了」而不是「取消」：这个框本来就只有一个出口，
 * 让 Esc 变成一条不留痕迹的后路，等于偷偷加回了那个不该有的「稍后」。
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

  const dialogRef = useRef<HTMLDialogElement>(null);
  /*
   * 「已经认过了」。
   *
   * 点按钮和按 Esc 会先后各走一遍这条路（按钮先关掉框，浏览器再抛 close），
   * 没有这个闸的话同一条公告会被写两次已读。
   */
  const acknowledged = useRef(false);

  useEffect(() => {
    const el = dialogRef.current;
    if (el && !el.open) el.showModal();
  }, [modal]);

  const closeBanner = (id: string) => {
    // 先从界面上拿走，再去写库
    setBanners((list) => list.filter((a) => a.id !== id));
    startTransition(async () => {
      await dismiss(id);
    });
  };

  const acknowledge = () => {
    if (acknowledged.current || !modal) return;
    acknowledged.current = true;
    const id = modal.id;
    setModal(null);
    startTransition(async () => {
      await dismiss(id);
    });
  };

  return (
    <>
      {banners.map((a) => (
        /*
         * 直接用 Callout，不再自己拼一遍底色。
         *
         * 原来这里手写了 `color-mix(… var(--accent) 10% …)`，而站里所有
         * 提示横幅走的是 Callout 的 9% —— 同一种东西在公告上比在页面里
         * 深一档。这类「差一点」正是站长说的那种割裂感的来源，
         * 而它永远不会有人来报告。
         *
         * 关掉那个按钮只能绝对定位：Callout 只有图标和正文两个槽。
         * 这一条写进了报告里 —— 它该有个 dismiss 槽。
         */
        <Callout key={a.id} tone="accent" icon={<Megaphone className="h-4 w-4" strokeWidth={2} aria-hidden />} className="relative">
          {a.title && <p className="t-subhead pr-7 font-medium text-[var(--accent)]">{a.title}</p>}
          {/*
            * 和帖子正文同一条渲染管线，所以支持链接和加粗 —— 一条公告
            * 常常需要给一个链接，而「详见某某页」写成纯文本等于没给。
            *
            * 字号写在 style 里，不是随手挑的：`.prose-forum` 定义在
            * globals.css 里、不属于任何 @layer，而 Tailwind 的字号工具类
            * 在 utilities 层里 —— 无层的规则一律压过有层的。所以这里原来
            * 那个 `t-caption` 从来没生效过，横幅正文一直是 17px 的正文字号，
            * 一条两行的公告能占掉手机首屏的六分之一。
            */}
          <div
            className="prose-forum pr-7"
            style={{ fontSize: "0.8125rem", lineHeight: 1.5 }}
            dangerouslySetInnerHTML={{ __html: a.html }}
          />
          <button
            type="button"
            onClick={() => closeBanner(a.id)}
            aria-label="关掉这条公告"
            className="tap-target absolute right-2.5 top-2.5 rounded-[var(--radius-chip)] p-1.5 text-[var(--ink-tertiary)] transition-colors hover:bg-[var(--fill)] hover:text-[var(--ink)]"
          >
            <X className="h-4 w-4" strokeWidth={2} aria-hidden />
          </button>
        </Callout>
      ))}

      {modal && (
        <dialog
          ref={dialogRef}
          onClose={acknowledge}
          aria-labelledby={`ann-${modal.id}`}
          /*
           * 手机上从底边升起，桌面上居中。
           * 底边是拇指够得到的地方，而这个框唯一的按钮在最下面。
           */
          className="animate-rise mx-0 mb-0 mt-auto w-full max-w-none rounded-t-[var(--radius-sheet)] bg-[var(--surface)] p-5 shadow-[var(--shadow-raised)] backdrop:bg-black/40 sm:m-auto sm:max-w-md sm:rounded-[var(--radius-sheet)]"
          style={{
            paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 1.25rem)",
          }}
        >
          <p id={`ann-${modal.id}`} className="t-headline flex items-center gap-2">
            <Megaphone className="h-4 w-4 shrink-0 text-[var(--accent)]" strokeWidth={2} aria-hidden />
            {modal.title ?? "公告"}
          </p>
          {/* 这一处保持正文字号：它盖住整页，本来就是要人读完的 */}
          <div className="prose-forum mt-2" dangerouslySetInnerHTML={{ __html: modal.html }} />
          <button
            type="button"
            onClick={acknowledge}
            className="t-subhead mt-5 h-11 w-full rounded-[var(--radius-control)] bg-[var(--accent)] px-4 font-medium text-[var(--accent-ink)] transition active:scale-[0.99]"
          >
            知道了
          </button>
        </dialog>
      )}
    </>
  );
}
