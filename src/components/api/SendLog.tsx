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
 */
export function SendLog({ rows, showWho = false }: { rows: SendLogRow[]; showWho?: boolean }) {
  if (rows.length === 0) {
    return (
      <p className="t-caption px-1 leading-relaxed text-[var(--ink-tertiary)]">
        还没有通过 API 代发过消息。
      </p>
    );
  }

  return (
    <div className="space-y-1.5">
      {rows.map((r) => (
        <div key={r.id} className="inset-group px-3.5 py-2.5">
          <p className="t-caption2 flex flex-wrap items-center gap-x-1.5 text-[var(--ink-quaternary)]">
            <span>{new Date(r.at).toLocaleString("zh-CN", { hour12: false })}</span>
            <span>·</span>
            <span>{r.convName ?? r.convId}</span>
            {r.tokenName && (
              <>
                <span>·</span>
                <span>{r.tokenName}</span>
              </>
            )}
            {showWho && (
              <>
                <span>·</span>
                <span>{r.userId}</span>
              </>
            )}
            {!r.ok && (
              <span
                className="rounded-[var(--radius-pill)] px-1.5 py-0.5"
                style={{
                  background: "color-mix(in srgb, var(--danger) 12%, transparent)",
                  color: "var(--danger)",
                }}
              >
                失败
              </span>
            )}
          </p>

          {/*
            * 正文原样显示，包括那一行代发署名 ——
            * 存的就是拼好署名之后的整条，所以这里也能看出署名有没有真的加上。
            */}
          {r.text && (
            <p className="t-caption mt-1 whitespace-pre-wrap break-words leading-relaxed text-[var(--ink-secondary)]">
              {r.text}
            </p>
          )}
          {r.error && (
            <p className="t-caption2 mt-1 break-words" style={{ color: "var(--danger)" }}>
              {r.error}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
