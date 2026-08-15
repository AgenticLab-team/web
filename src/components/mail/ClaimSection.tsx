"use client";

import { useState, useTransition } from "react";

import { buttonClass } from "@/components/ui/primitives";
import { claim, purchaseSlot } from "@/lib/mail/claim-actions";
import { LEVEL_SLOT_CAP, PURCHASED_SLOT_CAP, SLOT_PRICE } from "@/lib/mail/slot-rules";

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
export function ClaimForm({
  slots,
  domains,
  level,
  points,
}: {
  slots: { total: number; used: number };
  domains: { domain: string; tier: string; rent: number; minLevel: number }[];
  /** 我的等级 —— 决定哪几档开得了。不传的话界面只能等人点完才说「等级不够」 */
  level: number;
  /** 我的余额 —— 决定哪几档买得起 */
  points: number;
}) {
  const [local, setLocal] = useState("");
  const [tierFilter, setTierFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState(domains[0]?.domain ?? "");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const target = domains.find((d) => d.domain === picked);
  const full = slots.used >= slots.total;

  /*
   * ═════════════════════════════════════════
   * 八十五个域名平铺成一列单选，等于没有列表
   * ═════════════════════════════════════════
   *
   * 域名转正之后公共池里是八十多个 —— 原来这里把它们一个不落地
   * 摊成一列单选按钮。滚三屏才到底，而且**看不出档位是个概念**：
   * 每行右边的「B 档 · 60 分/年」只是一串字，不构成分类。
   *
   * 所以先按档分组（那本来就是定价的维度），再给一个搜索框：
   * 挑靓号的人心里往往已经有词了（自己的名字、项目名），
   * 而他现在只能靠滚。
   */
  const tiers = ["s", "a", "b"].filter((t) => domains.some((d) => d.tier === t));
  const shown = domains.filter(
    (d) =>
      (tierFilter === "all" || d.tier === tierFilter) &&
      (query.trim() === "" || d.domain.includes(query.trim().toLowerCase())),
  );
  /*
   * 列表**截断**，并且把「还有多少个」说出来。
   *
   * 不截的话一次渲染八十多行；而截了不说的话，人会以为池子就这么大 ——
   * 那比长列表更糟：他会得出「没有我想要的」这个错误结论。
   */
  const LIMIT = 12;
  const visible = shown.slice(0, LIMIT);
  const hidden = shown.length - visible.length;

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
    <div>
      {/*
        * 标题和槽位数搬到外面那张「长期地址」卡上了 ——
        * 这里只剩「怎么申领」这一件事。
        */}
      <p className="t-caption text-[var(--ink-tertiary)]">
        一年有效，到期可以续。地址是唯一的 —— 先到先得，不做竞价。
        {/*
          * 档位是什么，得有人说一句。
          * `kinds.ts` 里写着「靓号档位……『哪个域名算好』是审美判断」——
          * 那句话对写代码的人够了，对花 400 分的人不够。
          */}
        档位只决定年租和等级门槛，收信能力完全一样
      </p>


      {full && (
        <p className="t-caption mt-2" style={{ color: "var(--warning)" }}>
          槽位满了 —— 先退掉一个，或者在下面买一个
        </p>
      )}

      {/*
        * 档位是这套定价的骨架，所以它得是**一排能点的东西**，
        * 而不是每行右边的一句小字。顺带把「这一档要几级」写在上面 ——
        * 等级不够的话，人应该在挑之前就知道，而不是点完才被拒。
        */}
      <div className="mt-3 flex flex-wrap gap-x-1.5 gap-y-3.5">
        <button
          className={buttonClass(tierFilter === "all" ? "primary" : "quiet", "sm")}
          onClick={() => setTierFilter("all")}
        >
          全部 {domains.length}
        </button>
        {tiers.map((t) => {
          const sample = domains.find((d) => d.tier === t)!;
          const locked = level < sample.minLevel;
          return (
            <button
              key={t}
              className={buttonClass(tierFilter === t ? "primary" : "quiet", "sm")}
              onClick={() => setTierFilter(t)}
              title={locked ? `这一档要 L${sample.minLevel}，你现在 L${level}` : undefined}
            >
              {t.toUpperCase()} 档 {sample.rent} 分
              {locked && ` · 要 L${sample.minLevel}`}
            </button>
          );
        })}
      </div>

      {domains.length > LIMIT && (
        <input
          className="t-body mt-2 min-h-11 w-full rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2"
          placeholder={`在 ${domains.length} 个域名里搜`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="搜索域名"
        />
      )}

      <div className="mt-3 space-y-1.5">
        {visible.length === 0 && (
          <p className="t-caption text-[var(--ink-tertiary)]">
            没有匹配的域名{query.trim() && `（搜的是「${query.trim()}」）`}
          </p>
        )}
        {visible.map((d) => (
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
            {/*
              * 买不起 / 等级不够，在**这一行上**就说出来。
              * 原来只印一句「L2+」，而人要自己拿它和自己的等级比 ——
              * 那一步在挑第八十个域名时没人会做。
              */}
            <span
              className="t-caption2 shrink-0"
              style={{
                color:
                  level < d.minLevel || points < d.rent
                    ? "var(--warning)"
                    : "var(--ink-tertiary)",
              }}
            >
              {level < d.minLevel
                ? `要 L${d.minLevel}，你 L${level}`
                : points < d.rent
                  ? `${d.rent} 分/年 · 还差 ${d.rent - points} 分`
                  : `${d.tier.toUpperCase()} 档 · ${d.rent} 分/年`}
            </span>
          </label>
        ))}
      </div>

      {hidden > 0 && (
        <p className="t-caption2 mt-1.5 text-[var(--ink-tertiary)]">
          还有 {hidden} 个没显示 —— 上面搜一下，或者换个档位
        </p>
      )}

      <div className="mt-3 flex gap-2">
        <input
          className="t-body min-h-11 min-w-0 flex-1 rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2"
          placeholder="想要的前缀"
          aria-label="申领地址的前缀"
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

      {/*
        * ⚠️ 买槽位原来**只在槽位满了的时候才出现**。
        *
        * 也就是说：一个想提前多备一个槽位的人，
        * 在他真的撞墙之前，连价格都看不到 ——
        * 而「花分能买」正是这套经济里少数几件他可以主动做的事之一。
        * 站长的原话是「积分购买的……前端都没人实现」。
        *
        * 现在满不满都显示，只是满的时候多一句为什么。
        */}
      <div className="mt-3 border-t border-[var(--separator)] pt-3">

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
            花 {SLOT_PRICE} 分买一个槽位
          </button>
          <p className="t-caption2 mt-1 text-[var(--ink-tertiary)]">
            每升一级白送一个（到 L{LEVEL_SLOT_CAP} 封顶），买来的最多 {PURCHASED_SLOT_CAP} 个
          </p>
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
    </div>
  );
}
