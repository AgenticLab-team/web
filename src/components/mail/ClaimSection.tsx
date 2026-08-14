"use client";

import { useState, useTransition } from "react";

import { Card, buttonClass } from "@/components/ui/primitives";
import { claim, purchaseSlot } from "@/lib/mail/claim-actions";

/**
 * 申领公共池上的长期地址。
 *
 * ═════════════════════════════════════════
 * 价格必须在按下之前就看得见
 * ═════════════════════════════════════════
 *
 * 这是这一块和另外两块最大的差别：一次性箱和自有域名别名都是免费的，
 * 而这里**按一下就扣分**，最贵的一档 400 分（≈ 三周的日常参与）。
 *
 * 所以每个域名旁边直接标着年租和等级门槛，选中之后按钮上也写着
 * 「花 150 分申领」——而不是一个写着「申领」的按钮，点完才知道多少钱。
 *
 * ─────────────────────────────────────────
 * 槽位摆在最上面
 * ─────────────────────────────────────────
 *
 * 因为它是**唯一一个他改变不了的数**：分可以攒、等级会涨，
 * 而槽位满了就只能退掉一个或者花分买。先说这个，
 * 免得他挑好了地址、算好了分，最后撞在一句「槽位满了」上。
 */
export function ClaimSection({
  slots,
  domains,
}: {
  slots: { total: number; used: number };
  domains: { domain: string; tier: string; rent: number; minLevel: number }[];
}) {
  const [local, setLocal] = useState("");
  const [picked, setPicked] = useState(domains[0]?.domain ?? "");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const target = domains.find((d) => d.domain === picked);
  const full = slots.used >= slots.total;

  const submit = () => {
    setError(null);
    setDone(null);
    start(async () => {
      const r = await claim({ domain: picked, localPart: local });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setDone(`${r.address} 是你的了，扣了 ${r.paid} 分`);
      setLocal("");
    });
  };

  if (domains.length === 0) return null;

  return (
    <Card>
      <div className="flex items-baseline gap-2">
        <h2 className="t-headline">申领一个长期地址</h2>
        <span className="tabular t-caption2 ml-auto text-[var(--ink-tertiary)]">
          槽位 {slots.used}/{slots.total}
        </span>
      </div>

      <p className="t-caption mt-1 text-[var(--ink-tertiary)]">
        一年有效，到期可以续。地址是唯一的 —— 先到先得，不做竞价
      </p>

      {full && (
        <div className="mt-2">
          <p className="t-caption" style={{ color: "var(--warning)" }}>
            槽位满了。升一级会多一个（到 L5 封顶），或者直接买一个
          </p>
          {/*
            * 「或者买一个」后面直接跟按钮，而不是让他自己去别处找。
            * 一句「可以买」而没有入口，等于把人推去问别人怎么买。
            */}
          <button
            className={`${buttonClass("quiet", "sm")} mt-1.5`}
            onClick={() =>
              start(async () => {
                setError(null);
                const r = await purchaseSlot();
                if (!r.ok) setError(r.error);
                else setDone(`买好了，现在有 ${r.total} 个买来的槽位`);
              })
            }
            disabled={pending}
          >
            花 60 分买一个槽位
          </button>
        </div>
      )}

      <div className="mt-3 space-y-1.5">
        {domains.map((d) => (
          <label
            key={d.domain}
            /* `min-h-11` = 44px：整条 label 都能点，而它原来只有 34 高 */
            className={`flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] px-3 py-2 ${
              picked === d.domain ? "bg-[var(--accent-soft)]" : "bg-[var(--fill)]"
            }`}
          >
            <input
              type="radio"
              name="claim-domain"
              checked={picked === d.domain}
              onChange={() => setPicked(d.domain)}
            />
            <code className="t-footnote min-w-0 flex-1 truncate font-mono">@{d.domain}</code>
            {/* 价格和门槛跟着域名走 —— 不让人点完才知道多少钱 */}
            <span className="t-caption2 shrink-0 text-[var(--ink-tertiary)]">
              {d.tier.toUpperCase()} 档 · {d.rent} 分/年 · L{d.minLevel}+
            </span>
          </label>
        ))}
      </div>

      <div className="mt-3 flex gap-2">
        <input
          className="t-body min-w-0 flex-1 rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2"
          placeholder="想要的前缀"
          value={local}
          onChange={(e) => setLocal(e.target.value)}
          disabled={full}
        />
        <button
          className={buttonClass("primary")}
          onClick={submit}
          disabled={pending || full || !local.trim()}
        >
          {pending ? "申领中…" : target ? `花 ${target.rent} 分申领` : "申领"}
        </button>
      </div>

      {error && (
        <p className="t-caption mt-2" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      )}
      {done && (
        <p className="t-caption mt-2" style={{ color: "var(--success)" }}>
          {done}
        </p>
      )}
    </Card>
  );
}
