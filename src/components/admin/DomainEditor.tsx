"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import {
  AdminActions,
  AdminButton,
  AdminNote,
  adminFieldClass,
} from "@/components/admin/ui";
import { useToast } from "@/components/ui/Toast";
import { updateDomain } from "@/lib/mail/admin-actions";
import { MAIL_DOMAIN_KINDS, MAIL_DOMAIN_TIERS } from "@/lib/mail/kinds";
import type { MailDomainKind, MailDomainTier } from "@/lib/mail/kinds";

/**
 * 一个域名怎么用。
 *
 * ═════════════════════════════════════════
 * 改「归谁用」会连带改好几个开关，而那必须**保存前**就说
 * ═════════════════════════════════════════
 *
 * `updateDomain` 里有一串刻意的连带（见那个文件）：改成靓号池就
 * 强制关掉一次性箱、改成封禁就把收信相关的全关掉、离开靓号池就清掉档位。
 *
 * 那些连带是对的 —— 靠人记得手动关，迟早有一次会忘，而忘掉的后果是
 * 「你花 400 分买的地址，因为别人在同一个域名上注册了一百个账号
 * 而被某个网站拒收」。
 *
 * 但**不告诉他就发生**是另一回事。所以这里在按钮上方直接列出
 * 「按下去会连带关掉什么」——和 `BoardEditor` 那条同一个道理：
 * 事后通知等于没通知。
 *
 * ─────────────────────────────────────────
 * 五个类型的差别用一句话讲清楚，不靠人去猜
 * ─────────────────────────────────────────
 *
 * `admin` 和 `blocked` 长得最像而差别最大：两者都不进公共池，
 * 但前者**收信**（所以看得见有人在试探），后者连 MX 都不配。
 * 只写类型名的话没有人分得清，于是这两个会被随手选错 ——
 * 而选错 `blocked` 的后果是我们对那个商标域名上的钓鱼尝试一无所知。
 */

const KIND_LABEL: Record<MailDomainKind, string> = {
  owned: "有主域名",
  temp: "一次性箱池",
  reserved: "靓号池",
  admin: "只有管理员能开",
  blocked: "封禁（连 MX 都不配）",
};

const KIND_HINT: Record<MailDomainKind, string> = {
  owned: "归某个人所有，他可以在上面开自己的别名。要在下面指定主人",
  temp: "一次性箱从这些域名里随机挑。用完就扔，声誉迟早会脏 —— 这是它该待的地方",
  reserved: "留给申领的好地址。进这个池会强制关掉一次性箱 —— 那正是靓号唯一真正卖的东西",
  admin: "MX 配着、信收得到，但只有管理员能在上面开地址。商标近似域名放这儿：收信是为了看得见有人在试探",
  blocked: "连 MX 都不配。发到这里的信在 DNS 那一层就没了，我们什么都看不到",
};

export interface DomainEditorProps {
  domain: {
    domain: string;
    kind: MailDomainKind;
    tier: MailDomainTier | null;
    ownerUserId: string | null;
    ownerName: string | null;
    allowBurner: boolean;
    allowClaim: boolean;
    allowCustomLocal: boolean;
    inRandomRotation: boolean;
    catchAll: boolean;
    enabled: boolean;
    note: string | null;
    boxCount: number;
  };
  /** 能被指定为域名主人的人。只列已绑微信的 —— 域名归属要认得到人 */
  candidates: { id: string; name: string }[];
  onDone?: () => void;
}

export function DomainEditor({ domain, candidates, onDone }: DomainEditorProps) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();

  const [kind, setKind] = useState<MailDomainKind>(domain.kind);
  const [tier, setTier] = useState<MailDomainTier | "">(domain.tier ?? "");
  const [owner, setOwner] = useState(domain.ownerUserId ?? "");
  const [allowBurner, setAllowBurner] = useState(domain.allowBurner);
  const [allowClaim, setAllowClaim] = useState(domain.allowClaim);
  const [allowCustomLocal, setAllowCustomLocal] = useState(domain.allowCustomLocal);
  const [inRandomRotation, setInRandomRotation] = useState(domain.inRandomRotation);
  const [catchAll, setCatchAll] = useState(domain.catchAll);
  const [enabled, setEnabled] = useState(domain.enabled);
  const [note, setNote] = useState(domain.note ?? "");

  /*
   * 「按下保存会连带关掉什么」——**照着 updateDomain 里那几条算**。
   *
   * 这里重算一遍而不是等服务端返回：等返回就成了事后通知。
   * 两处会不会分叉？会 —— 所以 `tests/mail-domain-editor.test.ts`
   * 拿同一组输入两边各跑一遍，对不上就红。
   */
  const cascade: string[] = [];
  if (kind !== domain.kind) {
    if (kind === "reserved" && allowBurner) cascade.push("关掉「能开一次性箱」");
    if (kind === "blocked") {
      if (allowBurner) cascade.push("关掉「能开一次性箱」");
      if (allowClaim) cascade.push("关掉「能被申领」");
      if (catchAll) cascade.push("关掉「收所有前缀」");
      if (inRandomRotation) cascade.push("移出随机轮换");
    }
    if (kind !== "reserved" && domain.tier) cascade.push(`清掉 ${domain.tier.toUpperCase()} 档`);
  }

  const save = () => {
    start(async () => {
      const r = await updateDomain({
        domain: domain.domain,
        kind,
        tier: kind === "reserved" ? (tier || null) : null,
        ownerUserId: owner || null,
        allowBurner,
        allowClaim,
        allowCustomLocal,
        inRandomRotation,
        catchAll,
        enabled,
        note: note.trim() || null,
      });
      if (!r.ok) {
        toast.show({ message: r.error ?? "改不了", kind: "error" });
        return;
      }
      toast.show({ message: "已保存", kind: "success" });
      router.refresh();
      onDone?.();
    });
  };

  return (
    <div className="space-y-3">
      <div>
        <label className="t-caption block text-[var(--ink-secondary)]">这个域名归谁用</label>
        <select
          className={adminFieldClass}
          value={kind}
          onChange={(e) => setKind(e.target.value as MailDomainKind)}
        >
          {MAIL_DOMAIN_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
        <AdminNote>{KIND_HINT[kind]}</AdminNote>
      </div>

      {kind === "reserved" && (
        <div>
          <label className="t-caption block text-[var(--ink-secondary)]">靓号档位</label>
          <select
            className={adminFieldClass}
            value={tier}
            onChange={(e) => setTier(e.target.value as MailDomainTier | "")}
          >
            <option value="">不分档</option>
            {MAIL_DOMAIN_TIERS.map((t) => (
              <option key={t} value={t}>
                {t.toUpperCase()} 档
              </option>
            ))}
          </select>
          <AdminNote>档位决定年租价。手工标 ——「哪个域名算好」是审美判断，不做算法</AdminNote>
        </div>
      )}

      <div>
        <label className="t-caption block text-[var(--ink-secondary)]">域名主人</label>
        <select className={adminFieldClass} value={owner} onChange={(e) => setOwner(e.target.value)}>
          <option value="">（没有主人）</option>
          {candidates.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <AdminNote>
          指定之后这个域名就是他私享的：他能在上面开自己的别名。
          {domain.boxCount > 0 && ` 现在上面已经有 ${domain.boxCount} 个地址 —— 换主人不会动它们`}
        </AdminNote>
      </div>

      <fieldset className="space-y-1.5">
        <legend className="t-caption text-[var(--ink-secondary)]">这个域名上能做什么</legend>
        {(
          [
            [allowBurner, setAllowBurner, "能开一次性箱", "关掉之后随机池不会挑到它"],
            [allowClaim, setAllowClaim, "能被申领", "长期地址能落在这个域名上"],
            [allowCustomLocal, setAllowCustomLocal, "能自选前缀", "关掉的话只能拿随机地址"],
            [inRandomRotation, setInRandomRotation, "进随机轮换", "开一次性箱时会不会挑到它"],
            [catchAll, setCatchAll, "收所有前缀", "★ 开了之后发给任何前缀的信都收 —— 垃圾量会涨一个量级"],
            [enabled, setEnabled, "启用", "关掉之后这个域名整个不收信"],
          ] as const
        ).map(([value, set, label, hint]) => (
          <label key={label} className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={value}
              onChange={(e) => set(e.target.checked)}
            />
            <span className="min-w-0">
              <span className="t-footnote block">{label}</span>
              <span className="t-caption2 block text-[var(--ink-quaternary)]">{hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <div>
        <label className="t-caption block text-[var(--ink-secondary)]">备注</label>
        <input
          className={adminFieldClass}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="为什么这么配 —— 半年后是你自己在读"
        />
      </div>

      {/*
        * ★ 连带效果写在按钮**上方**。
        *
        * 和 BoardEditor 那条同一个道理：事后通知等于没通知。
        * 「保存成功，顺便把一次性箱关了」——那时候它已经关了。
        */}
      {cascade.length > 0 && (
        <AdminNote tone="warning">
          按下保存会连带：{cascade.join("、")}。这些连带是刻意的 ——
          靠人记得手动关，迟早有一次会忘
        </AdminNote>
      )}

      <AdminActions>
        <AdminButton tone="primary" onClick={save} disabled={pending}>
          {pending ? "保存中…" : "保存"}
        </AdminButton>
      </AdminActions>
    </div>
  );
}
