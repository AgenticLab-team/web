"use client";

import { AlertTriangle, Plus, Trash2, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

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
          <button
            type="button"
            onClick={() => setCreating((v) => !v)}
            className="t-caption inline-flex items-center gap-1 rounded-[var(--radius-control)] bg-[var(--fill)] px-2.5 py-1.5 font-medium transition active:scale-95"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={2.2} aria-hidden />
            新建
          </button>
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
        <p className="t-caption mt-2 px-1 leading-relaxed text-[var(--ink-tertiary)]">
          内置组只能改外观。key 一改，按 key 判「是不是管理员」的地方会全部落空 ——
          一次改名会把所有管理员关在门外，包括改名的那个人。
        </p>
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
    <div className="inset-row px-4 py-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 text-left"
      >
        <span
          className="t-caption shrink-0 rounded-[var(--radius-pill)] px-2 py-0.5 font-medium"
          style={{
            background: `color-mix(in srgb, ${role.color ?? "var(--ink)"} 14%, transparent)`,
            color: role.color ?? "var(--ink-secondary)",
          }}
        >
          {role.name}
        </span>
        <span className="t-caption2 font-mono text-[var(--ink-quaternary)]">{role.key}</span>

        <span className="t-caption2 inline-flex items-center gap-1 text-[var(--ink-tertiary)]">
          <Users className="h-3 w-3" strokeWidth={2} aria-hidden />
          {role.holders}
          {role.maxHolders !== null && ` / ${role.maxHolders}`}
          {role.autoHolders > 0 && `（${role.autoHolders} 自动）`}
        </span>

        {role.autoGrantRule != null && (
          <span className="t-caption2 rounded-[var(--radius-pill)] bg-[var(--accent-soft)] px-1.5 py-0.5 text-[var(--accent)]">
            自动发
          </span>
        )}

        <span className="flex-1" />
        <span className="tabular t-caption2 text-[var(--ink-quaternary)]">优先级 {role.priority}</span>
      </button>

      {open && (
        <div className="mt-3 space-y-2.5 rounded-[var(--radius-control)] bg-[var(--fill)] p-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={MAX_ROLE_NAME}
              aria-label="名字"
              className="t-body w-28 rounded-[var(--radius-control)] border border-[var(--separator)] bg-[var(--canvas)] px-2 py-1.5 outline-none focus:border-[var(--accent)]"
            />
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              aria-label="颜色"
              className="h-8 w-12 rounded-[var(--radius-control)] border border-[var(--separator)] bg-[var(--canvas)]"
            />
            <label className="t-caption flex items-center gap-1 text-[var(--ink-tertiary)]">
              优先级
              <input
                type="number"
                min={0}
                max={1000}
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                className="tabular t-body w-20 rounded-[var(--radius-control)] border border-[var(--separator)] bg-[var(--canvas)] px-2 py-1.5 outline-none focus:border-[var(--accent)]"
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
                  className="tabular t-body w-24 rounded-[var(--radius-control)] border border-[var(--separator)] bg-[var(--canvas)] px-2 py-1.5 outline-none focus:border-[var(--accent)]"
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
                      className="t-caption2 mt-1 w-full rounded-[var(--radius-control)] border border-[var(--separator)] bg-[var(--canvas)] px-2.5 py-2 font-mono outline-none focus:border-[var(--accent)]"
                    />
                    <label className="t-caption mt-1.5 flex items-center gap-1.5 text-[var(--ink-secondary)]">
                      <input
                        type="checkbox"
                        checked={autoRevoke}
                        onChange={(e) => setAutoRevoke(e.target.checked)}
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

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={save}
              className="t-caption rounded-[var(--radius-control)] bg-[var(--accent)] px-3 py-1.5 font-medium text-[var(--accent-ink)] transition active:scale-95 disabled:opacity-50"
            >
              保存
            </button>
            {!role.isSystem && (
              <button
                type="button"
                disabled={pending}
                onClick={() => run(() => deleteRole(role.id))}
                className="t-caption inline-flex items-center gap-1 rounded-[var(--radius-control)] px-2.5 py-1.5 text-[var(--ink-tertiary)] transition hover:bg-[var(--surface)] hover:text-[var(--danger)] disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
                删掉
              </button>
            )}
          </div>

          {error && <p className="t-caption text-[var(--danger)]">{error}</p>}
        </div>
      )}
    </div>
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
          className="t-body w-52 rounded-[var(--radius-control)] border border-[var(--separator)] bg-[var(--canvas)] px-2.5 py-1.5 font-mono outline-none focus:border-[var(--accent)]"
        />
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="显示名"
          maxLength={MAX_ROLE_NAME}
          className="t-body w-28 rounded-[var(--radius-control)] border border-[var(--separator)] bg-[var(--canvas)] px-2.5 py-1.5 outline-none focus:border-[var(--accent)]"
        />
        <input
          type="color"
          value={color}
          onChange={(e) => setColor(e.target.value)}
          aria-label="颜色"
          className="h-8 w-12 rounded-[var(--radius-control)] border border-[var(--separator)] bg-[var(--canvas)]"
        />
        <button
          type="button"
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
          className="t-caption rounded-[var(--radius-control)] bg-[var(--accent)] px-3 py-1.5 font-medium text-[var(--accent-ink)] transition active:scale-95 disabled:opacity-40"
        >
          建
        </button>
      </div>
      <p className="t-caption2 text-[var(--ink-tertiary)]">
        新建的组没有任何权限 —— 在下面的权限矩阵里挂上去才生效。
      </p>
      {error && <p className="t-caption text-[var(--danger)]">{error}</p>}
    </div>
  );
}
