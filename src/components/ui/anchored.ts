"use client";

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

/**
 * 把一个悬浮面板锚在触发按钮下方 —— 用视口坐标，配合传送到 body。
 *
 * ─────────────────────────────────────────
 * 这个 hook 存在的原因是一个真实的 bug
 * ─────────────────────────────────────────
 *
 * 站长报的：「论坛的更多菜单会被底下的回复挡住」。
 *
 * 成因不是 z-index 不够大。`@keyframes rise` 里有 `transform`，
 * 而 `.animate-rise` 用了 `animation-fill-mode: both` ——
 * 于是帖子那个 `<article>` **成了一个层叠上下文**。
 * 菜单写的 `z-40` 只在这个上下文*内部*有效，而回复列表在
 * `<article>` 外面、DOM 顺序更靠后，所以盖住了它。
 *
 * **把 z-index 调到 9999 也没用** —— 被困在上下文里的元素，
 * 数字再大也出不去。而这类 bug 每次成因都不同
 * （transform、filter、opacity、overflow、contain…），
 * 一处处调 z-index 永远追不完。
 *
 * 唯一稳的做法是让面板**不待在任何祖先的上下文里**：
 * 传送到 `document.body`，用 `position: fixed` + 视口坐标定位。
 */

/** 这个值不会变，所以不需要订阅任何东西 */
const subscribeNothing = () => () => {};

const MOBILE_MAX = 640;
/** 和视口边缘留一点，免得贴边 */
const EDGE = 8;

export interface AnchoredPanel {
  /** 窄屏走底部弹层，不跟随按钮 —— 贴着按钮弹出来多半会被手挡住 */
  narrow: boolean;
  /** 宽屏时的 fixed 坐标；窄屏为 null */
  position: { top: number; left: number } | null;
  /** 传送门要等挂载之后才能建（服务端没有 document） */
  mounted: boolean;
}

/**
 * **ref 由调用方持有并传进来**，这个 hook 只返回普通值。
 *
 * 把 ref 一起返回在对象里的话，调用方在渲染期读那个对象就会被
 * React 编译器拦下 —— 而它拦得对：渲染期读 ref 的组件不保证会重渲。
 */
export function useAnchoredPanel(
  open: boolean,
  triggerRef: React.RefObject<HTMLButtonElement | null>,
  panelRef: React.RefObject<HTMLDivElement | null>,
  align: "start" | "end" = "end",
): AnchoredPanel {
  const [narrow, setNarrow] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  /*
   * 「已经在浏览器里了吗」——服务端渲染时没有 document，传送门建不了。
   *
   * 用 useSyncExternalStore 而不是 useEffect + setState:
   * 后者是在 effect 里同步 setState，会多一轮渲染，
   * 而这正是 React 编译器要拦的那种写法。这个 hook 就是为
   * 「读一个 React 之外的值，且服务端和客户端答案不同」准备的。
   */
  const mounted = useSyncExternalStore(
    subscribeNothing,
    () => true,
    () => false,
  );

  useLayoutEffect(() => {
    if (!open) return;

    const place = () => {
      const el = triggerRef.current;
      if (!el) return;

      const isNarrow = window.innerWidth < MOBILE_MAX;
      setNarrow(isNarrow);
      if (isNarrow) {
        setPosition(null);
        return;
      }

      const r = el.getBoundingClientRect();
      const width = panelRef.current?.offsetWidth ?? 240;
      /*
       * 右对齐时也要夹住 —— 按钮靠右边缘时算出来会是负数，
       * 菜单会跑到屏幕外面去，人只看到「点了没反应」。
       */
      const raw = align === "end" ? r.right - width : r.left;
      const left = Math.max(EDGE, Math.min(raw, window.innerWidth - width - EDGE));
      setPosition({ top: r.bottom + 4, left });
    };

    place();
    /*
     * 滚动和缩放时重算，capture 是为了也收得到内层滚动容器的事件。
     *
     * 不重算的话按钮跑了而菜单停在原地 ——
     * 一个飘在半空、和任何东西都对不上的菜单，比直接关掉它更让人困惑。
     */
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, align, triggerRef, panelRef]);

  return { narrow, position, mounted };
}

/** 面板的 className 与 style —— 两种排布共用一处，免得改了一边忘了另一边 */
export function panelStyles(p: Pick<AnchoredPanel, "narrow" | "position">) {
  return p.narrow
    ? {
        className:
          "animate-rise fixed inset-x-3 z-[100] rounded-[var(--radius-card)] bg-[var(--surface)] p-1.5 shadow-[var(--shadow-raised)] hairline",
        style: {
          bottom: "calc(var(--tabbar-height) + env(safe-area-inset-bottom, 0px) + 0.75rem)",
        } as React.CSSProperties,
      }
    : {
        className:
          "animate-fade fixed z-[100] w-60 rounded-[var(--radius-card)] bg-[var(--surface)] p-1.5 shadow-[var(--shadow-raised)] hairline",
        // 还没算出坐标时先放到屏幕外，避免闪一下左上角
        style: {
          top: p.position?.top ?? -9999,
          left: p.position?.left ?? -9999,
        } as React.CSSProperties,
      };
}

/**
 * 点外面关掉 + Escape 关掉。
 *
 * ─────────────────────────────────────────
 * 传送门把「里面」和「外面」拆开了
 * ─────────────────────────────────────────
 *
 * 面板为了不被后面的内容盖住，是 `createPortal` 到 `document.body` 的
 * （见「论坛更多菜单被回复挡住」那次修复）。而这么一来，
 * **面板在 DOM 上就不再是触发按钮的后代**了。
 *
 * 于是只判 `根元素.contains(target)` 的话，点面板里任何一个东西
 * 都会被算成「点在外面」—— 菜单在手指落下的那一刻就关掉了，
 * 表现是「点不动，点了就瞬间消失」。
 *
 * 传送门是上一次修 bug 引进来的，而这个判定留在原地没跟着改。
 * 所以这个 helper 收在这里：谁用 `useAnchoredPanel`，就用这个关闭 ——
 * 两个 ref 本来就在手上，不该由每个调用方各记一遍。
 */
export function useDismissOnOutside(
  open: boolean,
  close: () => void,
  refs: React.RefObject<HTMLElement | null>[],
): void {
  /*
   * refs 数组每次渲染都是新的，直接进依赖会让 effect 每帧重挂。
   * 存进 ref，effect 只依赖 open 与 close。
   */
  const latest = useRef(refs);
  useEffect(() => {
    latest.current = refs;
  });

  useEffect(() => {
    if (!open) return;

    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      // 任何一个 ref 包住它，就算「点在里面」
      if (latest.current.some((r) => r.current?.contains(target))) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };

    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
}
