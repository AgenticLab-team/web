"use client";

import { Search, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * 代发日志的过滤条。
 *
 * ═════════════════════════════════════════
 * 条件写在 URL 里，不是组件的 state
 * ═════════════════════════════════════════
 *
 * 三个理由，都不是洁癖：
 *
 *   · 分页和过滤必须**一起**记住。写在 state 里的话，翻到第 3 页
 *     再改过滤条件，页码还停在 3 —— 而新条件下可能只有 1 页，
 *     于是屏幕一片空白
 *   · 站长排查问题时会把这一页的地址发给别人（「你看这条」），
 *     state 版发过去是一张没有过滤的全量列表
 *   · 后退键要能回到上一次的筛选结果
 *
 * 改条件时**页码一律回到第一页** —— 这是上面第一条的解法，
 * 而它必须写在改条件的那个函数里，不能指望每个调用点记得。
 *
 * ─────────────────────────────────────────
 * 成败那一栏从下拉框换成了分段控件
 * ─────────────────────────────────────────
 *
 * 「只看失败」是出事那天唯一要点的东西，而它原来藏在一个
 * 三选一的 `<select>` 里 —— 手机上要点开、滚、再点，三次交互。
 * 三个互斥选项正是 HIG 里分段控件的定义，摊开来是一次点击，
 * 而且**当前在哪一档不用点开就看得见**。
 */

interface Option {
  value: string;
  label: string;
}

const STATUS_TABS: Option[] = [
  { value: "all", label: "全部" },
  { value: "ok", label: "成功" },
  /*
   * 「只看失败」是这一栏最常用的一档 —— 出事那天要找的
   * 就是那几条，而它们混在几百条成功里根本翻不到。
   */
  { value: "failed", label: "失败" },
];

export function LogFilters({
  groups,
  showStatus = true,
}: {
  groups: Option[];
  showStatus?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const convId = params.get("conv") ?? "";
  const status = params.get("status") ?? "all";
  const query = params.get("q") ?? "";

  /*
   * 搜索框自己存一份，因为它要防抖 —— 每敲一个字就换一次地址的话，
   * 后退键会被塞满「搜索关键词的每一个前缀」，按十下才退得出去。
   */
  const [text, setText] = useState(query);

  /*
   * 地址被别处改了（后退键、点了「清空」）时跟上。
   *
   * 用「渲染期比一下」而不是 effect：写成
   * `useEffect(() => setText(query), [query])` 的话会多渲染一轮，
   * 而且那一轮里输入框显示的还是旧值 —— 仓库里的 lint 规则
   * 直接拦这种写法（「Calling setState synchronously within an effect」）。
   *
   * 这是 React 官方那条「prop 变了要调整 state」的形状：
   * 渲染期 setState 是允许的，React 会立刻用新值重跑这一次渲染，
   * 不会真的提交那一帧。
   */
  const [syncedQuery, setSyncedQuery] = useState(query);
  if (query !== syncedQuery) {
    setSyncedQuery(query);
    setText(query);
  }

  const apply = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
    }
    // 改条件就回第一页 —— 不回的话新条件下可能根本没有那一页
    next.delete("page");
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };

  useEffect(() => {
    if (text === query) return;
    const timer = setTimeout(() => {
      const next = new URLSearchParams(params.toString());
      if (text) next.set("q", text);
      else next.delete("q");
      next.delete("page");
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    }, 300);
    return () => clearTimeout(timer);
    // params 每次渲染都是新对象，放进依赖会让这个 effect 每次都重来
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, query, pathname]);

  const dirty = Boolean(convId || query || (showStatus && status !== "all"));

  return (
    <div className="inset-group mb-2 p-3">
      {/* 桌面端一行摆得下，手机上分两行 —— 搜索框永远独占一行 */}
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <div className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-[var(--radius-control)] bg-[var(--surface-sunken)] px-3">
          <Search
            className="h-4 w-4 shrink-0 text-[var(--ink-quaternary)]"
            strokeWidth={2}
            aria-hidden
          />
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="在代发内容里搜"
            aria-label="在代发内容里搜"
            className="t-body min-w-0 flex-1 bg-transparent py-2 outline-none placeholder:text-[var(--ink-quaternary)]"
          />
          {text && (
            <button
              type="button"
              onClick={() => setText("")}
              aria-label="清空搜索"
              className="tap-target shrink-0 p-1 text-[var(--ink-quaternary)] transition active:opacity-60"
            >
              <X className="h-4 w-4" strokeWidth={2} aria-hidden />
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={convId}
            onChange={(e) => apply({ conv: e.target.value || null })}
            aria-label="按群筛选"
            className="t-footnote min-h-11 min-w-0 flex-1 rounded-[var(--radius-control)] bg-[var(--surface-sunken)] px-3 outline-none lg:flex-none lg:max-w-52"
          >
            <option value="">所有群</option>
            {groups.map((g) => (
              <option key={g.value} value={g.value}>
                {g.label}
              </option>
            ))}
          </select>

          {showStatus && (
            /*
             * 分段控件。用 aria-pressed 而不是 role=radiogroup ——
             * 后者要自己接管方向键，而这里三个按钮 Tab 过去就够用了，
             * 少一套自己实现的键盘逻辑就少一处会坏的地方。
             */
            <div
              role="group"
              aria-label="按成败筛选"
              className="flex shrink-0 rounded-[var(--radius-control)] bg-[var(--surface-sunken)] p-0.5"
            >
              {STATUS_TABS.map((t) => {
                const on = status === t.value;
                return (
                  <button
                    key={t.value}
                    type="button"
                    aria-pressed={on}
                    onClick={() => apply({ status: t.value === "all" ? null : t.value })}
                    className={`t-footnote min-h-10 rounded-[var(--radius-chip)] px-3 font-medium transition-colors ${
                      on
                        ? "bg-[var(--surface)] text-[var(--ink)]"
                        : "text-[var(--ink-tertiary)] hover:text-[var(--ink-secondary)]"
                    }`}
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>
          )}

          {/*
            * 「清空」只在真的有条件时出现，而且**不占位** ——
            * 常驻一个灰按钮会让人以为随时有东西可以清。
            */}
          {dirty && (
            <button
              type="button"
              onClick={() => apply({ conv: null, status: null, q: null })}
              className="t-footnote min-h-11 shrink-0 rounded-[var(--radius-control)] px-3 text-[var(--ink-secondary)] transition-colors hover:bg-[var(--fill)]"
            >
              清空筛选
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
