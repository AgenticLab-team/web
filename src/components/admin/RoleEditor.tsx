"use client";
import { roleInk } from "@/lib/ui/role-color";

import { AlertTriangle, Plus, Trash2, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import {
  AdminActions,
  AdminButton,
  AdminNote,
  AdminRow,
  AdminTag,
  adminFieldClass,
} from "@/components/admin/ui";
import { createRole, deleteRole, updateRole } from "@/lib/rbac/role-actions";
import { MAX_ROLE_NAME } from "@/lib/rbac/role-rules";

/**
 * 身份组的增删改。
 *
 * ─────────────────────────────────────────
 * 内置组和自定义组长得要不一样
 * ─────────────────────────────────────────
 *
 * 内置的那七个（owner / admin / moderator …）决定谁是管理员。
 * 它们只让改外观 —— key 一改，`can()` 里按 key 找的地方会找不到，
 * 而那些地方判的是「是不是管理员」，找不到的结果是**没有权限**：
 * 一次改名会把所有管理员关在门外，包括改名的那个人。
 *
 * ─────────────────────────────────────────
 * 自动授予那一栏，不能用的时候要说清楚为什么
 * ─────────────────────────────────────────
 *
 * 「带危险权限的组不许自动发」是一条写死的线。把输入框灰掉但不解释，
 * 人只会以为是坏了，然后去找别的路 —— 而别的路多半更糟。
 */

export interface RoleView {
  id: string;
  key: string;
  name: string;
  description: string | null;
  color: string | null;
  priority: number;
  isSystem: boolean;
  maxHolders: number | null;
  autoGrantRule: unknown;
  autoRevoke: boolean;
  holders: number;
  autoHolders: number;
  seatsLeft: number | null;
  autoGrantAllowed: boolean;
  autoGrantBlockedReason?: string;
}

export function RoleEditor({ roles }: { roles: RoleView[] }) {
  const [creating, setCreating] = useState(false);

  const custom = roles.filter((r) => !r.isSystem);
  const builtin = roles.filter((r) => r.isSystem);

  return (
    <div className="space-y-6">
      <section>
        <div className="mb-2 flex items-end justify-between px-1">
          <h2 className="t-group-label">自定义身份组（{custom.length}）</h2>
          <AdminButton
            tone="neutral"
            size="sm"
            aria-expanded={creating}
            onClick={() => setCreating((v) => !v)}
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={2.2} aria-hidden />
            新建
          </AdminButton>
        </div>

        {creating && <CreateForm onDone={() => setCreating(false)} />}

        {custom.length === 0 && !creating ? (
          <div className="inset-group px-6 py-8 text-center">
            <p className="t-callout text-[var(--ink-secondary)]">还没有自定义身份组</p>
            <p className="t-caption mt-1 text-[var(--ink-tertiary)]">
              身份组既是荣誉也是权限容器 —— 建好之后在下面的权限矩阵里挂权限
            </p>
          </div>
        ) : (
          <div className="inset-group">
            {custom.map((role) => (
              <Row key={role.id} role={role} />
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="t-group-label mb-2 px-1">内置身份组（{builtin.length}）</h2>
        <div className="inset-group">
          {builtin.map((role) => (
            <Row key={role.id} role={role} />
          ))}
        </div>
        <AdminNote>
          内置组只能改外观。key 一改，按 key 判「是不是管理员」的地方会全部落空 ——
          一次改名会把所有管理员关在门外，包括改名的那个人。
        </AdminNote>
      </section>
    </div>
  );
}

function Row({ role }: { role: RoleView }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState(role.name);
  const [color, setColor] = useState(role.color ?? "#0d5c47");
  const [priority, setPriority] = useState(String(role.priority));
  const [maxHolders, setMaxHolders] = useState(role.maxHolders === null ? "" : String(role.maxHolders));
  const [autoRule, setAutoRule] = useState(
    role.autoGrantRule ? JSON.stringify(role.autoGrantRule, null, 2) : "",
  );
  const [autoRevoke, setAutoRevoke] = useState(role.autoRevoke);

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) setError(r.error ?? "没成功");
      else {
        setError(null);
        setOpen(false);
        router.refresh();
      }
    });

  const save = () => {
    let rule: unknown = null;
    if (autoRule.trim()) {
      try {
        rule = JSON.parse(autoRule);
      } catch {
        setError("自动授予规则不是合法的 JSON");
        return;
      }
    }
    run(() =>
      updateRole(role.id, {
        name,
        color,
        priority: Number(priority),
        ...(role.isSystem
          ? {}
          : {
              maxHolders: maxHolders.trim() ? Number(maxHolders) : null,
              autoGrantRule: rule,
              autoRevoke,
            }),
      }),
    );
  };

  return (
    <AdminRow align="start" className="flex-col">
      {/* 整行可点，min-h-11 保证手机上落得下一根手指 */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex min-h-11 w-full flex-wrap items-center gap-x-2.5 gap-y-1 text-left"
      >
        {/* 传混好的字色进去 —— AdminTag 也给 var(--danger) 那类主题变量用，不能在它内部一律掺 */}
        <AdminTag color={role.color ? roleInk(role.color) : undefined} className="px-2 py-0.5">
          {role.name}
        </AdminTag>
        <span className="t-caption2 font-mono text-[var(--ink-quaternary)]">{role.key}</span>

        <span className="t-caption2 inline-flex items-center gap-1 text-[var(--ink-tertiary)]">
          <Users className="h-3 w-3" strokeWidth={2} aria-hidden />
          {role.holders}
          {role.maxHolders !== null && ` / ${role.maxHolders}`}
          {role.autoHolders > 0 && `（${role.autoHolders} 自动）`}
        </span>

        {role.autoGrantRule != null && <AdminTag color="var(--accent)">自动发</AdminTag>}

        {/*
          * 优先级跟在这一簇后面，**不再用 `flex-1` 顶到最右边**。
          *
          * 顶到右边只有在「一列数字要互相比较」时才划算，而这个列表
          * 本来就是按优先级降序排的 —— 数字是印证，不是用来比的。
          *
          * 而代价是实打实的：后台正文栏修好之后是 78rem，
          * 减掉目录还有一千像素，于是每一行左边一小簇、右边一个数字，
          * 中间九百像素空着，九行都这样。
          * （在栏宽那个 bug 还在的时候这里只有两百多像素，看不出来 ——
          * 一个修复会照出另一个地方的问题，这是第二个了。）
          */}
        <span className="tabular t-caption2 ml-1 text-[var(--ink-quaternary)]">
          优先级 {role.priority}
        </span>
      </button>

      {open && (
        <div className="animate-rise mt-1 w-full space-y-2.5 rounded-[var(--radius-control)] bg-[var(--fill)] p-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={MAX_ROLE_NAME}
              aria-label="名字"
              className={`w-28 ${adminFieldClass}`}
            />
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              aria-label="颜色"
              className="h-11 w-14 shrink-0 rounded-[var(--radius-control)] bg-[var(--fill)] p-1"
            />
            <label className="t-caption flex items-center gap-1 text-[var(--ink-tertiary)]">
              优先级
              <input
                type="number"
                min={0}
                max={1000}
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                className={`tabular w-20 ${adminFieldClass}`}
              />
            </label>
          </div>

          {!role.isSystem && (
            <>
              <label className="t-caption flex items-center gap-1.5 text-[var(--ink-tertiary)]">
                名额上限
                <input
                  type="number"
                  min={1}
                  value={maxHolders}
                  onChange={(e) => setMaxHolders(e.target.value)}
                  placeholder="不限"
                  className={`tabular w-24 ${adminFieldClass}`}
                />
                {role.seatsLeft !== null && (
                  <span className="t-caption2">还剩 {role.seatsLeft} 个</span>
                )}
              </label>

              <div>
                <p className="t-caption font-medium">自动授予规则</p>
                {role.autoGrantAllowed ? (
                  <>
                    <textarea
                      value={autoRule}
                      onChange={(e) => setAutoRule(e.target.value)}
                      rows={4}
                      placeholder={'留空 = 不自动发。例：\n{"metric":"points_total","op":">=","value":1000}'}
                      className={`mt-1 resize-none font-mono ${adminFieldClass}`}
                    />
                    <label className="t-caption mt-1.5 flex min-h-11 items-center gap-2 text-[var(--ink-secondary)]">
                      <input
                        type="checkbox"
                        checked={autoRevoke}
                        onChange={(e) => setAutoRevoke(e.target.checked)}
                        className="h-5 w-5 shrink-0 accent-[var(--accent)]"
                      />
                      不再满足条件时自动收回
                    </label>
                    {autoRevoke && (
                      <p className="t-caption2 mt-1 leading-relaxed text-[var(--ink-tertiary)]">
                        只会收回<b className="font-medium">自动发出去的</b> ——
                        管理员手动给的那些不动，那是一个人的决定。
                      </p>
                    )}
                  </>
                ) : (
                  /*
                   * 灰掉但不解释的话，人只会以为是坏了，然后去找别的路 ——
                   * 而别的路多半更糟。
                   */
                  <p className="t-caption mt-1 flex items-start gap-1.5 leading-relaxed text-[var(--warning)]">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={2.2} aria-hidden />
                    {role.autoGrantBlockedReason}
                  </p>
                )}
              </div>
            </>
          )}

          <AdminActions>
            <AdminButton tone="primary" disabled={pending} onClick={save}>
              保存
            </AdminButton>
            {/* 删身份组会连带收走所有持有者的权限 —— 归 dangerSoft：
                重建一个同 key 的组能救回来，但持有关系救不回来 */}
            {!role.isSystem && (
              <AdminButton
                tone="dangerSoft"
                disabled={pending}
                title={
                  role.holders > 0
                    ? `还有 ${role.holders} 个人挂着这个组，删掉他们会一起失去它带的权限`
                    : undefined
                }
                onClick={() => run(() => deleteRole(role.id))}
              >
                <Trash2 className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
                {role.holders > 0 ? `删掉（${role.holders} 人受影响）` : "删掉"}
              </AdminButton>
            )}
          </AdminActions>

          {error && (
            <p role="alert" className="t-caption text-[var(--danger)]">
              {error}
            </p>
          )}
        </div>
      )}
    </AdminRow>
  );
}

function CreateForm({ onDone }: { onDone: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [color, setColor] = useState("#0d5c47");
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="inset-group mb-2 space-y-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="key（小写字母数字下划线）"
          className={`w-52 font-mono ${adminFieldClass}`}
        />
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="显示名"
          maxLength={MAX_ROLE_NAME}
          className={`w-28 ${adminFieldClass}`}
        />
        <input
          type="color"
          value={color}
          onChange={(e) => setColor(e.target.value)}
          aria-label="颜色"
          className="h-11 w-14 shrink-0 rounded-[var(--radius-control)] bg-[var(--fill)] p-1"
        />
        <AdminButton
          tone="primary"
          disabled={pending || !key.trim() || !name.trim()}
          onClick={() =>
            startTransition(async () => {
              const r = await createRole({ key, name, color, priority: 10 });
              if (!r.ok) setError(r.error ?? "没成功");
              else {
                onDone();
                router.refresh();
              }
            })
          }
        >
          建这个组
        </AdminButton>
      </div>
      <p className="t-caption2 text-[var(--ink-tertiary)]">
        新建的组没有任何权限 —— 在下面的权限矩阵里挂上去才生效。
      </p>
      {error && (
        <p role="alert" className="t-caption text-[var(--danger)]">
          {error}
        </p>
      )}
    </div>
  );
}
