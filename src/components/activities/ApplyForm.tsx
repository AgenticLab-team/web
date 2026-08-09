"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { useToast } from "@/components/ui/Toast";
import {
  applyToActivity,
  cancelApplication,
  resubmitApplication,
} from "@/lib/activities/actions";

/**
 * 申请表单。
 *
 * 三条：
 *
 * ① **不够格时把差距直接写出来**，而不是把按钮灰掉。
 *   「还差 13 条高质量发言」是一个能去做的目标；
 *   一个灰按钮只是一堵墙。
 *
 * ② 名额快满时**如实说还剩几个**。藏着不说的话，
 *   填完提交才发现满了，那种落差比一开始就知道难受得多。
 *
 * ③ **撤回之后接着改**，不是从头再来。撤回最常见的原因就是
 *   「我想换一个域名」，所以上次填的原样带回来，改完再提交 ——
 *   而且改的是同一条申请，不是新开一条。
 */
export function ApplyForm({
  activityId,
  fields,
  tlds,
  eligible,
  reasons,
  remaining,
  existing,
  resume = null,
}: {
  activityId: string;
  fields: { name: string; label: string; placeholder?: string; hint?: string; required: boolean }[];
  tlds: string[];
  eligible: boolean;
  reasons: string[];
  remaining: number | null;
  existing: { id: string; summary: string; statusLabel: string; canCancel: boolean } | null;
  /** 撤回（或被判无效、履约失败）掉的那一份，可以改了重提 */
  resume?: {
    id: string;
    values: Record<string, string>;
    summary: string;
    statusLabel: string;
  } | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [values, setValues] = useState<Record<string, string>>({
    // 兜底和 domainModule 的默认后缀对齐 —— 两处不一样的话人怎么填都会被拒
    tld: tlds[0] ?? "icu",
    ...(resume?.values ?? {}),
  });

  if (existing) {
    return (
      <div className="space-y-2 rounded-[var(--radius-card)] bg-[var(--fill)] p-4">
        <p className="t-body">
          你已经登记了 <span className="font-mono">{existing.summary}</span>
        </p>
        <p className="t-caption text-[var(--ink-tertiary)]">当前状态：{existing.statusLabel}</p>
        {existing.canCancel && (
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await cancelApplication({ id: existing.id });
                if (!result.ok) {
                  toast.show({ message: result.error ?? "撤回失败", kind: "error" });
                  return;
                }
                toast.show({ message: "已撤回，名额还给别人了", kind: "success" });
                router.refresh();
              })
            }
            className="t-caption rounded-[var(--radius-pill)] bg-[var(--surface)] px-2.5 py-1 text-[var(--ink-secondary)] disabled:opacity-40"
          >
            撤回申请
          </button>
        )}
      </div>
    );
  }

  if (!eligible) {
    return (
      <div className="space-y-1.5 rounded-[var(--radius-card)] bg-[var(--fill)] p-4">
        <p className="t-body">你还不满足这次的条件</p>
        {/* 把差距写出来 —— 「还差 13 条」是能去做的事，灰按钮只是一堵墙 */}
        {reasons.map((r, i) => (
          <p key={i} className="t-caption text-[var(--ink-secondary)]">
            · {r}
          </p>
        ))}
        <p className="t-caption2 pt-1 text-[var(--ink-quaternary)]">
          条件是按参与度定的，不是按先来后到 —— 多在群里和论坛聊聊就够了。
        </p>
      </div>
    );
  }

  const submit = () => {
    startTransition(async () => {
      /*
       * 有上一份就改上一份，没有才新建。
       *
       * 每次都新建的话，一个人在一个活动里会攒下一串申请 ——
       * 而名额、域名唯一性、每人限额全是按在途申请数的。
       */
      const result = resume
        ? await resubmitApplication({ id: resume.id, payload: values })
        : await applyToActivity({ activityId, payload: values });
      if (!result.ok) {
        toast.show({ message: result.error ?? "提交失败", kind: "error" });
        return;
      }
      toast.show({ message: result.note ?? "已登记", kind: "success" });
      router.refresh();
    });
  };

  return (
    <div className="space-y-2.5 rounded-[var(--radius-card)] bg-[var(--surface)] p-4 hairline">
      {/*
        * 上一份为什么还在这儿，说清楚。
        *
        * 不说的话，人打开页面看到框里已经填着东西，会以为撤回没成功。
        */}
      {resume && (
        <p className="t-caption rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2 leading-relaxed text-[var(--ink-secondary)]">
          上次那份（<span className="font-mono">{resume.summary}</span>·{resume.statusLabel}）
          还留着，名额已经还回去了。改成你想要的再提交就行 —— 改的还是这一份，不会多占一个。
        </p>
      )}

      {/* 名额快满时如实说 —— 填完才发现满了那种落差更难受 */}
      {remaining !== null && remaining <= 10 && (
        <p
          className="t-caption rounded-[var(--radius-control)] px-3 py-2"
          style={{
            background: "color-mix(in srgb, var(--warning) 10%, transparent)",
            color: "var(--warning)",
          }}
        >
          {remaining > 0
            ? `只剩 ${remaining} 个名额了`
            : "名额已经满了 —— 现在提交会进候补队列，前面有人放弃时自动补上"}
        </p>
      )}

      {fields.map((field) =>
        field.name === "tld" ? (
          <label key={field.name} className="block">
            <span className="t-caption2 mb-1 block text-[var(--ink-quaternary)]">{field.label}</span>
            <select
              value={values.tld ?? tlds[0]}
              onChange={(e) => setValues({ ...values, tld: e.target.value })}
              className={inputClass}
            >
              {tlds.map((t) => (
                <option key={t} value={t}>
                  .{t}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label key={field.name} className="block">
            <span className="t-caption2 mb-1 block text-[var(--ink-quaternary)]">
              {field.label}
              {!field.required && "（可选）"}
            </span>
            <input
              value={values[field.name] ?? ""}
              onChange={(e) => setValues({ ...values, [field.name]: e.target.value })}
              placeholder={field.placeholder}
              className={inputClass}
            />
            {field.hint && (
              <span className="t-caption2 mt-1 block text-[var(--ink-quaternary)]">
                {field.hint}
              </span>
            )}
          </label>
        ),
      )}

      <button
        type="button"
        disabled={pending || !values.name?.trim()}
        onClick={submit}
        className="t-subhead w-full rounded-[var(--radius-control)] bg-[var(--accent)] px-4 py-2 font-medium text-[var(--accent-ink)] disabled:opacity-40"
      >
        {resume ? "改好了，重新提交" : "登记"}
      </button>

      <p className="t-caption leading-relaxed text-[var(--ink-tertiary)]">
        登记之后管理员会统一去注册，结果（成功或失败）会通知你。
        如果失败，名额会还回来，你可以换一个再来。
      </p>
    </div>
  );
}

const inputClass =
  "t-subhead w-full rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2 outline-none placeholder:text-[var(--ink-quaternary)]";
