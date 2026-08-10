import { ChevronDown, ChevronUp } from "lucide-react";

import { Avatar } from "@/components/Avatar";
import { PersonLink } from "@/components/PersonLink";
import { Empty, Group, RankBadge, Row } from "@/components/ui/primitives";
import type { BoardEntry } from "@/lib/queries/leaderboard";

/**
 * 榜单列表。首页与排行页共用，避免两处各写一遍导致样式漂移。
 */
export function LeaderboardList({
  entries,
  highlightWxId,
  showDelta = true,
}: {
  entries: BoardEntry[];
  highlightWxId?: string | null;
  showDelta?: boolean;
}) {
  if (entries.length === 0) {
    return <Empty title="这个时间段还没有数据" hint="等下一轮同步，或者换个周期看看" />;
  }

  return (
    <Group>
      <ul className="stagger">
        {entries.map((entry, i) => {
          const isMe = highlightWxId && entry.wxId === highlightWxId;
          return (
            <li key={entry.wxId} style={{ "--i": i } as React.CSSProperties}>
              <Row className={isMe ? "bg-[var(--accent-soft)]" : ""}>
                <RankBadge rank={entry.rank} />
                <PersonLink wxId={entry.wxId} name={entry.name}>
                  <Avatar
                    wxId={entry.wxId}
                    name={entry.name}
                    src={entry.avatarUrl}
                    size={36}
                  />
                </PersonLink>
                <div className="min-w-0 flex-1">
                  <p className="t-body truncate leading-tight">
                    <PersonLink wxId={entry.wxId} name={entry.name} className="hover:underline">
                      {entry.name}
                    </PersonLink>
                    {isMe && (
                      <span className="t-caption ml-1.5 text-[var(--accent)]">你</span>
                    )}
                    {/*
                      * ─────────────────────────────────────────
                      * 这两个标只有能绕过隐私的人看得到
                      * ─────────────────────────────────────────
                      *
                      * 管理员看到的是**完整**的榜。不标出来的话，
                      * 他会以为公开的榜就长这样，然后照着一个
                      * 只有他自己看得见的名次去发公告、发奖 ——
                      * 那是一次好心办出来的隐私事故。
                      *
                      * 字段本身在查询层就只给特权视角，
                      * 所以这里不需要再判一次「他是不是管理员」：
                      * 普通成员拿到的 entry 上根本没有这两个字段。
                      */}
                    {entry.hiddenFromOthers && (
                      <span
                        className="t-caption2 ml-1.5 rounded-[var(--radius-pill)] bg-[var(--warning)]/12 px-1.5 py-0.5 align-middle text-[var(--warning)]"
                        title="这个人把自己从榜单上藏起来了 —— 只有你看得到这一行"
                      >
                        仅你可见
                      </span>
                    )}
                    {entry.anonymousToGuests && (
                      <span
                        className="t-caption2 ml-1.5 rounded-[var(--radius-pill)] bg-[var(--fill)] px-1.5 py-0.5 align-middle text-[var(--ink-tertiary)]"
                        title="这个人还没注册本站 —— 未登录访客看到的是「群成员」，没有名字和头像"
                      >
                        访客不具名
                      </span>
                    )}
                  </p>
                  <p className="tabular t-caption text-[var(--ink-tertiary)]">
                    {entry.messages} 条 · 均 {Math.round(entry.chars / Math.max(entry.messages, 1))} 字
                  </p>
                </div>
                {showDelta && <Delta current={entry.rank} previous={entry.previousRank} />}
                <span className="tabular t-headline w-11 text-right">{entry.quality}</span>
              </Row>
            </li>
          );
        })}
      </ul>
    </Group>
  );
}

/**
 * 名次升降。这是榜单里最能制造追赶动机的元素 ——
 * 只有绝对名次的话，第 8 名不会知道自己这周涨了 5 名。
 */
function Delta({ current, previous }: { current: number; previous: number | null }) {
  if (previous === null) {
    return (
      <span className="t-caption w-9 text-right text-[var(--ink-quaternary)]" title="上期未上榜">
        NEW
      </span>
    );
  }
  const diff = previous - current;
  if (diff === 0) {
    return <span className="t-caption w-9 text-right text-[var(--ink-quaternary)]">—</span>;
  }
  const up = diff > 0;
  return (
    <span
      className="tabular t-caption w-9 text-right font-medium"
      style={{ color: up ? "var(--success)" : "var(--ink-tertiary)" }}
      title={`上期第 ${previous} 名`}
    >
      {/* 箭头用 SVG —— ↑↓ 这两个字符在不同字体里粗细差很多，一列排下来会歪 */}
      {up ? (
        <ChevronUp className="h-3 w-3" strokeWidth={2.6} aria-hidden />
      ) : (
        <ChevronDown className="h-3 w-3" strokeWidth={2.6} aria-hidden />
      )}
      {Math.abs(diff)}
    </span>
  );
}
