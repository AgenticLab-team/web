"use client";

import { AlertTriangle, Percent, ShieldCheck, Users, Wrench } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import {
  AdminButton,
  AdminChip,
  AdminNote,
  AdminRow,
  AdminTag,
  adminFieldClass,
} from "@/components/admin/ui";
import { setFlagEnabled, setFlagRollout } from "@/lib/flags/actions";
import type { Rollout } from "@/lib/flags/registry";

/**
 * 功能开关列表。
 *
 * ─────────────────────────────────────────
 * 「按下去会发生什么」要写在按钮旁边
 * ─────────────────────────────────────────
 *
 * 这一页上的每个开关都能让一整块功能对所有人消失。
 * 只写一个名字（「论坛」）和一个滑块的话，按下去之前
 * 没人知道自己关掉的到底是哪些页面 —— 于是这一页会变成
 * 一个没人敢碰的地方，而它本来是出事时第一个该来的地方。
 *
 * ─────────────────────────────────────────
 * 没接线的开关要长得不一样
 * ─────────────────────────────────────────
 *
 * 十个开关里有三四个对应的功能还没做。和真开关摆成一样的话，
 * 这一页本身就成了新的死开关：点一下，什么都不会发生。
 */

export interface FlagView {
  key: string;
  label: string;
  effect: string;
  status: "wired" | "planned";
  enabled: boolean;
  rollout: Rollout;
  rolloutValue: unknown;
  updatedAt: number | null;
  missing: boolean;
}

export function FlagList({ flags }: { flags: FlagView[] }) {
  const wired = flags.filter((f) => f.status === "wired");
  const planned = flags.filter((f) => f.status === "planned");

  return (
    <div className="space-y-6">
      <section>
        <h2 className="t-group-label mb-2 px-1">真的管着东西（{wired.length}）</h2>
        <div className="inset-group">
          {wired.map((flag) => (
            <Row key={flag.key} flag={flag} />
          ))}
        </div>
      </section>

      {planned.length > 0 && (
        <section>
          <h2 className="t-group-label mb-2 px-1">功能还没做（{planned.length}）</h2>
          <div className="inset-group opacity-70">
            {planned.map((flag) => (
              <Row key={flag.key} flag={flag} />
            ))}
          </div>
          <AdminNote>
            这几个开关现在<b className="font-medium text-[var(--ink-secondary)]">不管任何事</b>
            —— 对应的功能还没写。留着是为了做的时候有个现成的位置，
            而不是让人以为按一下会有变化。
          </AdminNote>
        </section>
      )}
    </div>
  );
}

function Row({ flag }: { flag: FlagView }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) setError(r.error ?? "没成功");
      else {
        setError(null);
        router.refresh();
      }
    });

  const planned = flag.status === "planned";

  return (
    <AdminRow align="start" className="flex-col">
      <div className="flex w-full items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="t-body flex flex-wrap items-center gap-1.5 font-medium">
            {flag.label}
            <span className="t-caption2 font-mono text-[var(--ink-quaternary)]">{flag.key}</span>
            {planned && (
              <AdminTag className="inline-flex items-center gap-1">
                <Wrench className="h-3 w-3" strokeWidth={2} aria-hidden />
                还没做
              </AdminTag>
            )}
            {flag.missing && (
              /*
               * 库里没有这一行 —— 现在走的是代码里的默认值。
               * 说出来是因为「这一项从来没被改过」和「被改成了这个值」
               * 在排查时是两件事。
               */
              <span className="t-caption2 text-[var(--ink-quaternary)]">（从没改过）</span>
            )}
          </p>
          <p className="t-caption mt-0.5 leading-relaxed text-[var(--ink-tertiary)]">
            {flag.effect}
          </p>
        </div>

        {/*
          * 开关本身。
          *
          * 关的时候是灰的、开的时候是品牌绿 —— 一列扫下来
          * 「现在有什么是关着的」应该一眼看得到，那是这一页最常被问的问题。
          */}
        {/*
          * 开关本体和 ModuleToggle 用同一套尺寸与动效。
          *
          * 原来这里是 `transition-[left]` + 换 left 值 —— 动 left 每帧
          * 触发布局，正是 globals.css 里 `.switch-knob` 那段注释在说的
          * 那个病（当时收敛了五处，漏了这一处）。改走 translateX。
          *
          * 滑块也从 `bg-white` 换成 `--surface`：暗色下一个纯白的滑块
          * 亮得像颗灯泡，而它旁边所有东西都是暗的。
          *
          * 尺寸从 24×40 提到 31×51 —— 和站里其它开关一致，
          * 也正好过 44px 那条线（宽度够，高度靠行高兜）。
          */}
        <button
          type="button"
          role="switch"
          aria-checked={flag.enabled}
          aria-label={`${flag.label}：${flag.enabled ? "已开启" : "已关闭"}`}
          disabled={pending}
          onClick={() => run(() => setFlagEnabled(flag.key, !flag.enabled))}
          className={`relative h-[31px] w-[51px] shrink-0 rounded-full transition-colors disabled:opacity-50 ${
            flag.enabled ? "bg-[var(--accent)]" : "bg-[var(--fill-strong)]"
          }`}
        >
          <span
            className="switch-knob absolute left-[2px] top-[2px] h-[27px] w-[27px] rounded-full bg-[var(--surface)] shadow-sm"
            style={{ transform: flag.enabled ? "translateX(20px)" : "translateX(0)" }}
          />
        </button>
      </div>

      {flag.enabled && !planned && (
        <div className="w-full">
          <AdminButton
            tone="quiet"
            size="sm"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="-ml-2.5"
          >
            {ROLLOUT_ICON[flag.rollout]}
            {describeRollout(flag.rollout, flag.rolloutValue)}
          </AdminButton>

          {open && <RolloutEditor flag={flag} onSave={run} pending={pending} />}
        </div>
      )}

      {error && (
        <p role="alert" className="t-caption w-full text-[var(--danger)]">
          {error}
        </p>
      )}
    </AdminRow>
  );
}

const ROLLOUT_ICON: Record<Rollout, React.ReactNode> = {
  all: <ShieldCheck className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />,
  role: <Users className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />,
  user: <Users className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />,
  percent: <Percent className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />,
};

function describeRollout(rollout: Rollout, value: unknown): string {
  const v = (value ?? {}) as Record<string, unknown>;
  if (rollout === "all") return "对所有人开放";
  if (rollout === "role") {
    const roles = Array.isArray(v.roles) ? v.roles : [];
    return roles.length ? `只给这些身份：${roles.join("、")}` : "按身份放行，但还没填身份（= 谁都进不去）";
  }
  if (rollout === "user") {
    const users = Array.isArray(v.users) ? v.users : [];
    return `只给指定的 ${users.length} 个人`;
  }
  return `放给 ${Number(v.percent ?? 0)}% 的登录用户`;
}

function RolloutEditor({
  flag,
  onSave,
  pending,
}: {
  flag: FlagView;
  onSave: (fn: () => Promise<{ ok: boolean; error?: string }>) => void;
  pending: boolean;
}) {
  const v = (flag.rolloutValue ?? {}) as Record<string, unknown>;
  const [rollout, setRollout] = useState<Rollout>(flag.rollout);
  const [roles, setRoles] = useState((Array.isArray(v.roles) ? v.roles : []).join(","));
  const [users, setUsers] = useState((Array.isArray(v.users) ? v.users : []).join(","));
  const [percent, setPercent] = useState(String(Number(v.percent ?? 0)));

  const parse = (raw: string) =>
    raw
      .split(/[,，\s]+/)
      .map((x) => x.trim())
      .filter(Boolean);

  return (
    <div className="mt-2 rounded-[var(--radius-control)] bg-[var(--fill)] p-3">
      <div className="flex flex-wrap gap-1.5">
        {(["all", "role", "percent", "user"] as const).map((mode) => (
          <AdminChip key={mode} active={rollout === mode} onClick={() => setRollout(mode)}>
            {{ all: "所有人", role: "按身份", percent: "按比例", user: "指定的人" }[mode]}
          </AdminChip>
        ))}
      </div>

      {/* 输入框走全站同一套长相 —— 这两个原来是「1px 边框 + canvas 底」的
          第二套写法，和后台其它二十来个 fill 底的框不是一个东西 */}
      {rollout === "role" && (
        <input
          value={roles}
          onChange={(e) => setRoles(e.target.value)}
          placeholder="身份组 key，用逗号分隔，例如 owner,admin"
          className={`mt-2 ${adminFieldClass}`}
        />
      )}
      {rollout === "user" && (
        <input
          value={users}
          onChange={(e) => setUsers(e.target.value)}
          placeholder="账号 id，用逗号分隔"
          className={`mt-2 ${adminFieldClass}`}
        />
      )}
      {rollout === "percent" && (
        <div className="mt-2 flex items-center gap-2">
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={percent}
            onChange={(e) => setPercent(e.target.value)}
            className="flex-1"
            aria-label="放给百分之多少的登录用户"
          />
          <span className="tabular t-caption w-10 text-right">{percent}%</span>
        </div>
      )}

      <p className="t-caption2 mt-2 leading-relaxed text-[var(--ink-tertiary)]">
        {rollout === "percent"
          ? "同一个人每次得到的答案是一样的 —— 不会一会儿有一会儿没有。访客不算在内（他们没有稳定身份）。"
          : rollout === "all"
            ? "最常用的一档。灰度只在「刚上线、想先给一部分人试」时才需要。"
            : "没登录的人一律不在范围里。"}
      </p>

      <AdminButton
        tone="primary"
        disabled={pending}
        className="mt-2.5"
        onClick={() =>
          onSave(() =>
            setFlagRollout(
              flag.key,
              rollout,
              rollout === "role"
                ? { roles: parse(roles) }
                : rollout === "user"
                  ? { users: parse(users) }
                  : rollout === "percent"
                    ? { percent: Number(percent) }
                    : null,
            ),
          )
        }
      >
        保存放量范围
      </AdminButton>
    </div>
  );
}

/** 库里有、清单里没有的 key —— 它们不生效，得说出来 */
export function OrphanFlags({ keys }: { keys: string[] }) {
  if (keys.length === 0) return null;

  return (
    <div
      className="mt-4 rounded-[var(--radius-card)] p-4 hairline"
      style={{ background: "color-mix(in srgb, var(--warning) 9%, var(--surface))" }}
    >
      <p className="t-subhead flex items-center gap-1.5 font-medium">
        <AlertTriangle className="h-4 w-4 text-[var(--warning)]" strokeWidth={2.2} aria-hidden />
        库里有 {keys.length} 个清单外的开关
      </p>
      <p className="t-caption mt-1 leading-relaxed text-[var(--ink-secondary)]">
        判定只认代码里的清单，所以这几个
        <b className="font-medium text-[var(--ink)]">改了也不会有任何效果</b>：
        <span className="font-mono"> {keys.join("、")}</span>。
        多半是改名或删功能时留下的，可以直接从库里清掉。
      </p>
    </div>
  );
}
