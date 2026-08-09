"use client";

import { Check, Minus, X, type LucideIcon } from "lucide-react";
import { useMemo, useState, useTransition } from "react";

import type { MatrixState } from "@/lib/admin/matrix-types";
import { previewMatrixEdit, saveMatrixEdit } from "@/lib/rbac/matrix-actions";
import { stateLabel, type MatrixDiff } from "@/lib/rbac/matrix-edit";

/**
 * 权限矩阵的在线编辑。
 *
 * ─────────────────────────────────────────
 * 这个界面的全部工作是「让人在按下保存之前明白自己要做什么」
 * ─────────────────────────────────────────
 *
 * 矩阵上一格和旁边四百格长得一模一样,而改一格可能让四十个人
 * 从此能删别人的帖。所以交互按三步分开,每一步都可以停下来:
 *
 *   1. **点格子** —— 改动只在本地攒着,颜色标出「你动过这里」
 *   2. **预览**   —— 服务端真算一遍影响面,「失去 1 项、获得 3 项、影响 4 人」
 *   3. **写理由再保存** —— 理由是必填的
 *
 * 中间那一步不能省。省掉之后这个功能就变成了「四百个一样的格子,
 * 点错一个没人知道」。
 */

export type Cell = { roleId: string; permissionKey: string; state: MatrixState };

export interface MatrixEditorProps {
  roles: { id: string; name: string; color: string | null; holders: number }[];
  categories: { category: string; label: string; permissions: PermissionCol[] }[];
  /** roleId -> permissionKey -> 当前状态 */
  initial: Record<string, Record<string, MatrixState>>;
  canEdit: boolean;
  /** 反查链接的前缀 —— 函数没法跨服务端/客户端边界传，只能传字符串 */
  lookupBase: string;
}

export interface PermissionCol {
  key: string;
  label: string;
  dangerLevel: number;
  /**
   * 这个权限点今天管不管用。
   *
   * 不标出来的话，这张矩阵会让人以为每一个勾都管事 ——
   * 而其中一批**勾了什么都不会发生，取消了那个人照样做得了**。
   * 权限是拿来限制人的东西，一个不生效的限制比没有更糟：
   * 它让人以为已经限制住了。
   */
  planned?: boolean;
}

const NEXT: Record<MatrixState, MatrixState> = {
  none: "granted",
  granted: "denied",
  denied: "none",
};

/**
 * 三态用 SVG 图标，不用 ✓✗− 这几个字符。
 *
 * 这里原来就是 lucide 的 Check/X/Minus，是我改成编辑器时换成文字符号的 ——
 * 换回来。字符版有两个实际问题：粗细和基线跟着字体走，
 * 在不同系统上对不齐；而且**这三个格子是这张表唯一的信息载体**，
 * 它们和旁边正文一样粗的时候，整张矩阵会糊成一片。
 */
const GLYPH: Record<MatrixState, LucideIcon> = { granted: Check, denied: X, none: Minus };

/**
 * 本地攒改动时的键。
 *
 * 用 NUL 分隔而不是空格或冒号：roleId 是 ULID、permissionKey 形如
 * `forum.post.delete.any`，两者都不含 NUL，所以拼出来的键**不可能撞**。
 *
 * 写成 `\u0000` 转义而不是直接敲一个 NUL 字节 —— 后者会让整个文件
 * 在 `file(1)` 眼里变成 data、grep 要加 `-a` 才搜得到。
 * 一个源码文件不该是「二进制」。
 */
function cellKey(roleId: string, permissionKey: string) {
  return `${roleId}\u0000${permissionKey}`;
}

export function MatrixEditor({ roles, categories, initial, canEdit, lookupBase }: MatrixEditorProps) {
  const [edits, setEdits] = useState<Map<string, MatrixState>>(new Map());
  /*
   * 分类切换是**组件内部的状态**,不是 URL。
   *
   * 走 URL 的话每次切分类都是一次整页导航,攒着没保存的改动会全部丢掉 ——
   * 而人最可能的操作顺序恰恰是「在这一类改两格,再去那一类改两格」。
   */
  const [active, setActive] = useState(categories[0]?.category ?? "");
  const [diff, setDiff] = useState<MatrixDiff | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  const stateOf = (roleId: string, key: string): MatrixState =>
    edits.get(cellKey(roleId, key)) ?? initial[roleId]?.[key] ?? "none";

  const isEdited = (roleId: string, key: string) => edits.has(cellKey(roleId, key));

  const cycle = (roleId: string, key: string) => {
    if (!canEdit) return;
    const next = NEXT[stateOf(roleId, key)];
    const original = initial[roleId]?.[key] ?? "none";

    setEdits((prev) => {
      const copy = new Map(prev);
      // 转回原值时把这条改动去掉 —— 否则「改了又改回来」会留在 diff 里
      if (next === original) copy.delete(cellKey(roleId, key));
      else copy.set(cellKey(roleId, key), next);
      return copy;
    });
    setDiff(null);
    setErrors([]);
    setSaved(false);
  };

  /** 每一类里攒了几处改动 —— 切走之后还看得见，否则改动会被忘在别的标签里 */
  const editsByCategory = useMemo(() => {
    const counts = new Map<string, number>();
    for (const key of edits.keys()) {
      const permissionKey = key.slice(key.indexOf(" ") + 1);
      const category = categories.find((c) => c.permissions.some((p) => p.key === permissionKey));
      if (category) counts.set(category.category, (counts.get(category.category) ?? 0) + 1);
    }
    return counts;
  }, [edits, categories]);

  const shown = categories.filter((c) => c.category === active);

  const cells: Cell[] = useMemo(
    () =>
      [...edits].map(([k, state]) => {
        const [roleId, permissionKey] = k.split("\u0000");
        return { roleId, permissionKey, state };
      }),
    [edits],
  );

  const reset = () => {
    setEdits(new Map());
    setDiff(null);
    setErrors([]);
    setSaved(false);
  };

  const doPreview = () =>
    startTransition(async () => {
      const result = await previewMatrixEdit({ cells, reason });
      if (result.ok) {
        setDiff(result.diff);
        setErrors([]);
      } else {
        setDiff(null);
        setErrors(result.errors);
      }
    });

  const doSave = () =>
    startTransition(async () => {
      const result = await saveMatrixEdit({ cells, reason });
      if (result.ok) {
        setSaved(true);
        setEdits(new Map());
        setDiff(null);
        setReason("");
      } else {
        setErrors(result.errors);
      }
    });

  return (
    <div>
      <div className="no-scrollbar -mx-4 mb-3 flex gap-1.5 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
        {categories.map((c) => {
          const pending = editsByCategory.get(c.category) ?? 0;
          const isActive = c.category === active;
          return (
            <button
              key={c.category}
              type="button"
              onClick={() => setActive(c.category)}
              aria-current={isActive ? "true" : undefined}
              className={[
                "t-caption shrink-0 rounded-full border px-2.5 py-1 transition-colors",
                isActive
                  ? "border-[var(--accent)] bg-[var(--accent)] text-white"
                  : "border-[var(--separator)] text-[var(--ink-secondary)] hover:bg-[var(--fill)]",
              ].join(" ")}
            >
              {c.label} {c.permissions.length}
              {pending > 0 && (
                <span
                  className={[
                    "ml-1.5 rounded-full px-1.5 py-px text-[11px] font-semibold tabular-nums",
                    isActive ? "bg-white/25" : "bg-[var(--accent)] text-white",
                  ].join(" ")}
                  aria-label={`这一类有 ${pending} 处改动还没保存`}
                >
                  {pending}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="inset-group overflow-x-auto">
        <table className="w-full min-w-[36rem] border-collapse text-left">
          <thead>
            <tr>
              <th scope="col" className="t-caption sticky left-0 z-10 bg-[var(--surface)] px-3 py-2 font-normal text-[var(--ink-tertiary)]">
                权限点
              </th>
              {roles.map((role) => (
                <th key={role.id} scope="col" className="px-2 py-2 text-center align-bottom">
                  <span
                    className="t-caption block truncate font-medium"
                    style={role.color ? { color: role.color } : undefined}
                  >
                    {role.name}
                  </span>
                  <span className="t-caption2 block text-[var(--ink-quaternary)]">
                    {role.holders} 人
                  </span>
                </th>
              ))}
            </tr>
          </thead>

          {shown.map((category) => (
            <tbody key={category.category}>
              <tr>
                <th
                  scope="colgroup"
                  colSpan={roles.length + 1}
                  className="t-caption sticky left-0 bg-[var(--surface-sunken)] px-3 py-1 text-left font-normal text-[var(--ink-tertiary)]"
                >
                  {category.label}
                </th>
              </tr>
              {category.permissions.map((permission) => (
                <tr key={permission.key} className="border-t border-[var(--separator)]">
                  <th
                    scope="row"
                    className="sticky left-0 z-10 max-w-[13rem] bg-[var(--surface)] px-3 py-2 text-left font-normal"
                  >
                    <a
                      href={`${lookupBase}${encodeURIComponent(permission.key)}`}
                      className="block"
                      title="点击反查谁拥有它"
                    >
                      <span className="t-subhead block truncate">
                        {permission.label}
                        {permission.planned && (
                          <span
                            className="t-caption2 ml-1.5 rounded-[var(--radius-pill)] bg-[var(--fill)] px-1.5 py-0.5 align-middle font-normal text-[var(--ink-tertiary)]"
                            title="这一项今天还没接线：勾上不会有任何效果，取消也拦不住"
                          >
                            未生效
                          </span>
                        )}
                        {permission.dangerLevel > 0 && (
                          <span
                            className="ml-1.5 text-[var(--danger)]"
                            title={["", "敏感", "危险", "极危"][permission.dangerLevel]}
                            aria-label={["", "敏感", "危险", "极危"][permission.dangerLevel]}
                          >
                            ●
                          </span>
                        )}
                      </span>
                      <code className="t-caption2 block truncate font-mono text-[var(--ink-quaternary)]">
                        {permission.key}
                      </code>
                    </a>
                  </th>

                  {roles.map((role) => {
                    const state = stateOf(role.id, permission.key);
                    const edited = isEdited(role.id, permission.key);
                    const color =
                      state === "granted"
                        ? "text-[var(--success)]"
                        : state === "denied"
                          ? "text-[var(--danger)]"
                          : "text-[var(--ink-quaternary)]";

                    return (
                      <td key={role.id} className="px-1 py-1 text-center">
                        <button
                          type="button"
                          onClick={() => cycle(role.id, permission.key)}
                          disabled={!canEdit}
                          aria-label={`${role.name} · ${permission.label}：${stateLabel(state)}${
                            edited ? "（已改动）" : ""
                          }`}
                          title={canEdit ? "点一下换一个状态" : "你没有编辑权限"}
                          className={[
                            "mx-auto flex h-7 w-7 items-center justify-center rounded-md transition-colors",
                            color,
                            canEdit ? "hover:bg-[var(--fill)]" : "cursor-default",
                            // 动过的格子要一眼看得出来 —— 否则改了三十格之后没人记得改了哪些
                            edited
                              ? "bg-[var(--accent)]/12 ring-2 ring-[var(--accent)] ring-inset"
                              : "",
                          ].join(" ")}
                        >
                          {(() => {
                            const Icon = GLYPH[state];
                            return (
                              <Icon
                                className={state === "none" ? "h-3 w-3" : "h-3.5 w-3.5"}
                                strokeWidth={state === "none" ? 2.5 : 3}
                                aria-hidden
                              />
                            );
                          })()}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>

      {/*
        * 图例要用**和格子里一模一样的图标**。
        *
        * 格子换成 SVG 之后图例还写着 ✓✗−，那两套符号长得不一样 ——
        * 人对照不上的时候会以为自己看错了行。
        */}
      <p className="t-caption mt-2 flex flex-wrap items-center gap-x-1 gap-y-0.5 px-1 leading-relaxed text-[var(--ink-tertiary)]">
        <Check className="h-3 w-3 text-[var(--success)]" strokeWidth={3} aria-hidden /> 允许 ·
        <X className="h-3 w-3 text-[var(--danger)]" strokeWidth={3} aria-hidden />
        显式拒绝（优先级高于任何允许）·
        <Minus className="h-3 w-3" strokeWidth={2.5} aria-hidden /> 未授予。
        点权限点名可以反查谁拥有它。红点表示危险操作。
        {canEdit && " 点格子换状态，改完先预览再保存。"}
      </p>

      {saved && (
        <p
          role="status"
          className="t-subhead mt-3 rounded-lg border border-[var(--success)]/40 bg-[var(--success)]/8 px-3 py-2 text-[var(--success)]"
        >
          已保存。这次改动进了审计日志，含改前改后的值和理由。
        </p>
      )}

      {errors.length > 0 && (
        <ul
          role="alert"
          className="mt-3 space-y-1 rounded-lg border border-[var(--danger)]/40 bg-[var(--danger)]/8 px-3 py-2"
        >
          {errors.map((e) => (
            <li key={e} className="t-subhead text-[var(--danger)]">
              {e}
            </li>
          ))}
        </ul>
      )}

      {cells.length > 0 && (
        <MatrixReview
          count={cells.length}
          diff={diff}
          reason={reason}
          onReason={setReason}
          onPreview={doPreview}
          onSave={doSave}
          onReset={reset}
          pending={pending}
        />
      )}
    </div>
  );
}

/**
 * 改动攒好之后的那一栏。
 *
 * 它是**粘在底部**的:改到第三十格的时候,页面早就滚出去很远了,
 * 而「我现在攒了多少改动」这个问题必须随时看得见 ——
 * 看不见的待提交改动,最后要么被忘掉,要么被连带着一起提交。
 */
function MatrixReview({
  count,
  diff,
  reason,
  onReason,
  onPreview,
  onSave,
  onReset,
  pending,
}: {
  count: number;
  diff: MatrixDiff | null;
  reason: string;
  onReason: (v: string) => void;
  onPreview: () => void;
  onSave: () => void;
  onReset: () => void;
  pending: boolean;
}) {
  return (
    <div className="sticky bottom-0 z-20 mt-3 rounded-xl border border-[var(--separator)] bg-[var(--surface)]/95 p-3 shadow-lg backdrop-blur">
      <div className="flex flex-wrap items-center gap-2">
        <span className="t-subhead font-medium">{count} 处改动还没保存</span>
        <button
          type="button"
          onClick={onReset}
          className="t-caption rounded-md px-2 py-1 text-[var(--ink-tertiary)] transition-colors hover:bg-[var(--fill)]"
        >
          全部撤销
        </button>

        <span className="flex-1" />

        {!diff ? (
          <button
            type="button"
            onClick={onPreview}
            disabled={pending}
            className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-[13px] font-medium text-white transition-opacity hover:opacity-85 disabled:opacity-50"
          >
            {pending ? "算着…" : "预览影响"}
          </button>
        ) : (
          <button
            type="button"
            onClick={onSave}
            disabled={pending}
            className="rounded-lg bg-[var(--danger)] px-3 py-1.5 text-[13px] font-medium text-white transition-opacity hover:opacity-85 disabled:opacity-50"
          >
            {pending ? "保存中…" : "确认保存"}
          </button>
        )}
      </div>

      {diff && (
        <div className="mt-3 border-t border-[var(--separator)] pt-3">
          {/*
            * 影响面这句话要最大最显眼。
            *
            * 下面那份格子清单是给想细看的人的,而绝大多数时候
            * 人只会读这一句就按下去 —— 所以这一句必须是准的、
            * 而且是按人算出来的,不是「这个身份组有几个人」。
            */}
          <p className="t-body mb-2 font-medium">{diff.summary}</p>

          <ul className="mb-3 max-h-40 space-y-0.5 overflow-y-auto">
            {diff.changes.map((c) => (
              <li key={`${c.roleId}-${c.permissionKey}`} className="t-caption tabular-nums">
                <span className="text-[var(--ink-secondary)]">{c.roleName}</span>
                <code className="mx-1.5 font-mono text-[var(--ink-tertiary)]">{c.permissionKey}</code>
                <span className="text-[var(--ink-quaternary)]">{stateLabel(c.from)}</span>
                <span className="mx-1 text-[var(--ink-quaternary)]">→</span>
                <span
                  className={
                    c.to === "denied"
                      ? "font-medium text-[var(--danger)]"
                      : c.to === "granted"
                        ? "text-[var(--success)]"
                        : "text-[var(--ink-tertiary)]"
                  }
                >
                  {stateLabel(c.to)}
                </span>
              </li>
            ))}
          </ul>

          {(diff.impact.lost.length > 0 || diff.impact.gained.length > 0) && (
            <ul className="mb-3 max-h-32 space-y-0.5 overflow-y-auto">
              {diff.impact.lost.map((u) => (
                <li key={`l-${u.userId}`} className="t-caption text-[var(--danger)]">
                  {u.name} 失去 {u.permissions.length} 项：{u.permissions.join("、")}
                </li>
              ))}
              {diff.impact.gained.map((u) => (
                <li key={`g-${u.userId}`} className="t-caption text-[var(--ink-secondary)]">
                  {u.name} 获得 {u.permissions.length} 项：{u.permissions.join("、")}
                </li>
              ))}
            </ul>
          )}

          <label className="t-caption block text-[var(--ink-tertiary)]">
            为什么改（必填，会进审计日志）
            <textarea
              value={reason}
              onChange={(e) => onReason(e.target.value)}
              rows={2}
              className="mt-1 w-full rounded-lg border border-[var(--separator)] bg-[var(--surface)] px-2 py-1.5 text-[14px] outline-none focus-visible:border-[var(--accent)]"
            />
          </label>
        </div>
      )}
    </div>
  );
}
