"use client";

import { Plus } from "lucide-react";
import { useState, useTransition } from "react";

import { Card, buttonClass } from "@/components/ui/primitives";
import { createAlias } from "@/lib/mail/alias-actions";
import type { AliasView } from "@/lib/mail/alias";

/**
 * 自有域名上的长期地址。
 *
 * ═════════════════════════════════════════
 * 它和上面那块一次性箱**长得不一样，是故意的**
 * ═════════════════════════════════════════
 *
 * 一次性箱那一块的主角是**验证码**：地址和码各占一行大字，
 * 因为人来那儿只做两件事（拿地址、等码）。
 *
 * 长期地址不是。它是一个「地址」——你会把它写进别人的通讯录，
 * 而不是盯着它等一封信。所以这里的主角是**地址列表**，
 * 每行带一个未读数，点进去才是信。
 *
 * 两块用同一种排版的话，页面会变成一长串同样大小的卡片，
 * 而「哪个是我在等的、哪个是我长期用的」这个区别就没了。
 */
export function AliasSection({
  aliases,
  domains,
}: {
  aliases: AliasView[];
  /** 我拥有的域名。空数组时这一整块不渲染 —— 见页面那侧 */
  domains: { domain: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [local, setLocal] = useState("");
  const [domain, setDomain] = useState(domains[0]?.domain ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const create = () => {
    setError(null);
    start(async () => {
      const r = await createAlias({ domain, localPart: local });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setLocal("");
      setOpen(false);
    });
  };

  return (
    <Card>
      <div className="flex items-baseline gap-2">
        <h2 className="t-headline">我的长期地址</h2>
        <span className="t-caption2 text-[var(--ink-quaternary)]">不过期</span>
        <button
          className={`${buttonClass("quiet", "sm")} ml-auto`}
          onClick={() => setOpen(!open)}
        >
          <Plus className="size-3.5" />
          开一个
        </button>
      </div>

      {open && (
        <div className="mt-3 space-y-2">
          <div className="flex gap-2">
            <input
              className="t-body min-w-0 flex-1 rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2"
              placeholder="前缀"
              value={local}
              onChange={(e) => setLocal(e.target.value)}
              autoFocus
            />
            <select
              className="t-body shrink-0 rounded-[var(--radius-control)] bg-[var(--fill)] px-2 py-2"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
            >
              {domains.map((d) => (
                <option key={d.domain} value={d.domain}>
                  @{d.domain}
                </option>
              ))}
            </select>
          </div>
          {error && (
            <p className="t-caption" style={{ color: "var(--danger)" }}>
              {error}
            </p>
          )}
          <button
            className={buttonClass("primary", "sm")}
            onClick={create}
            disabled={pending || !local.trim()}
          >
            {pending ? "开着…" : "开这个地址"}
          </button>
        </div>
      )}

      <div className="mt-3 space-y-1.5">
        {aliases.length === 0 ? (
          <p className="t-caption text-[var(--ink-tertiary)]">
            {/*
              * 空态要说清楚它和上面那块的差别，否则人会问
              * 「我不是已经有邮箱了吗」。
              */}
            还没开过。长期地址不会过期，适合写进别人的通讯录 ——
            而上面那种 {"24"} 小时就销毁
          </p>
        ) : (
          aliases.map((a) => (
            <div
              key={a.id}
              className="flex items-center gap-2 rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2"
            >
              <code className="t-footnote min-w-0 flex-1 truncate font-mono">{a.address}</code>
              {a.unreadCount > 0 && (
                <span
                  className="t-caption2 shrink-0 rounded-[var(--radius-pill)] px-1.5 py-0.5"
                  style={{ background: "var(--accent)", color: "var(--accent-ink)" }}
                >
                  {a.unreadCount}
                </span>
              )}
              <span className="tabular t-caption2 shrink-0 text-[var(--ink-quaternary)]">
                {a.messageCount} 封
              </span>
            </div>
          ))
        )}
      </div>
    </Card>
  );
}
