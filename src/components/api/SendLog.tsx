import { Globe, KeyRound } from "lucide-react";

import { Empty } from "@/components/ui/primitives";
import type { SendLogRow } from "@/lib/api-tokens/store";

/**
 * 代发日志。
 *
 * ═════════════════════════════════════════
 * 这一页回答的是「机器人到底说了什么」
 * ═════════════════════════════════════════
 *
 * 消息署名是机器人，群里的人看不出是谁让它说的 ——
 * 所以正文要**原样摆出来**，只给个条数等于什么都没说。
 *
 * 失败的也列（而且标出来）：一串失败往往意味着有人在循环里
 * 撞限流或者撞上游，而那正是要在它变成问题之前看到的东西。
 *
 * ─────────────────────────────────────────
 * 层级反过来了
 * ─────────────────────────────────────────
 *
 * 原来每条是「一行四级灰的元信息」压着「一段二级灰的正文」——
 * 也就是说**这一页最重要的东西用的是最淡的颜色**，
 * 而时间戳和令牌名反倒排在最前面。扫一列日志时眼睛先撞上的
 * 是一堆 `2026-08-11 14:32:07`，要读的那句话得一条条找。
 *
 * 现在正文是主角（正文色、带一条引用色带，表示「群里看到的就是这个」），
 * 元信息降到下面一行。失败的整条染色 —— 那是要一眼挑出来的。
 */
export function SendLog({ rows, showWho = false }: { rows: SendLogRow[]; showWho?: boolean }) {
  if (rows.length === 0) {
    return (
      <Empty
        title="还没有通过 API 代发过消息"
        hint="从这里或者用令牌发出去的每一条都会记在这儿，失败的也记。"
      />
    );
  }

  return (
    <div className="inset-group">
      {rows.map((r) => (
        <article key={r.id} className="inset-row p-4">
          {/*
            * 正文原样显示，包括那一行代发署名 ——
            * 存的就是拼好署名之后的整条，所以这里也能看出署名有没有真的加上。
            *
            * 左边那条色带表示「这一段就是群里看到的字」，
            * 把它和周围的元信息在视觉上分开：不分的话，
            * 「本消息由某某代发」那一行看起来像是我们加的说明。
            */}
          {r.text && (
            <p
              className="t-subhead whitespace-pre-wrap break-words pl-3 leading-relaxed"
              style={{
                boxShadow: `inset 2px 0 0 ${r.ok ? "var(--separator-opaque)" : "var(--danger)"}`,
              }}
            >
              {r.text}
            </p>
          )}

          {r.error && (
            <p
              className="t-footnote mt-2 break-words rounded-[var(--radius-control)] px-2.5 py-1.5 leading-relaxed"
              style={{
                background: "color-mix(in srgb, var(--danger) 10%, transparent)",
                color: "var(--danger)",
              }}
            >
              {r.error}
            </p>
          )}

          <p
            className={`t-caption2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[var(--ink-quaternary)] ${
              r.text || r.error ? "mt-2" : ""
            }`}
          >
            {!r.ok && (
              <span
                className="rounded-[var(--radius-pill)] px-1.5 py-0.5 font-medium"
                style={{
                  background: "color-mix(in srgb, var(--danger) 12%, transparent)",
                  color: "var(--danger)",
                }}
              >
                失败
              </span>
            )}
            <span className="font-medium text-[var(--ink-tertiary)]">
              {r.convName ?? r.convId}
            </span>
            <span className="tabular">
              {new Date(r.at).toLocaleString("zh-CN", { hour12: false })}
            </span>
            {/*
              * 「从哪条路发的」用图标区分：钥匙 = 令牌，地球 = 网页。
              *
              * 网页那条路的 tokenName 是 null，原来那一段就整个不显示 ——
              * 于是它和令牌发的长得一模一样，而「这条是我在网页上手点的
              * 还是脚本发的」正是排查时第一个要问的问题。
              */}
            <span className="inline-flex items-center gap-1">
              {r.tokenName ? (
                <KeyRound className="h-3 w-3" strokeWidth={2.2} aria-hidden />
              ) : (
                <Globe className="h-3 w-3" strokeWidth={2.2} aria-hidden />
              )}
              {r.tokenName ?? "网页"}
            </span>
            {showWho && <span>发起人 {r.userId}</span>}
          </p>
        </article>
      ))}
    </div>
  );
}
