"use client";

import { useMemo, useState, useTransition } from "react";
import { Check, Search } from "lucide-react";

import { grantSendManyAction, revokeSendAction } from "@/lib/api-tokens/actions";
import type { GrantRow } from "@/lib/api-tokens/store";

/**
 * 授权谁能往哪个群发。
 *
 * ─────────────────────────────────────────
 * 理由必填
 * ─────────────────────────────────────────
 *
 * 这是一次把「以机器人身份说话」的能力交出去的操作，
 * 而半年后回头看的时候，「为什么给了他」是唯一要问的问题。
 */
export function GrantManager({
  grants,
  groups,
  people,
  limits,
}: {
  grants: GrantRow[];
  groups: { convId: string; name: string }[];
  /** 能被授权的人。全站注册账号一百多个，一个下拉框装得下 */
  people: { id: string; name: string }[];
  limits: { perMinute: number; perHour: number; perDay: number };
}) {
  /*
   * 多选。原来是一个下拉框，一次只能给一个群 ——
   * 而「给他所有群」这件事就得点十二遍，每遍都重填一次理由。
   */
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [userId, setUserId] = useState(people[0]?.id ?? "");
  /* 一百三十多个人，下拉框里翻不动 —— 打两个字筛一下 */
  const [personQuery, setPersonQuery] = useState("");
  const [reason, setReason] = useState("");
  const [perDay, setPerDay] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pending, start] = useTransition();

  /*
   * 筛人。大小写、站内昵称、微信昵称都能搜到 ——
   * 这里的 name 已经是解析过的显示名，所以一次 includes 就够。
   */
  const matched = useMemo(() => {
    const q = personQuery.trim().toLowerCase();
    if (!q) return people;
    return people.filter((p) => p.name.toLowerCase().includes(q));
  }, [people, personQuery]);

  /*
   * 筛完之后选中的人可能不在结果里了。
   *
   * 不处理的话，下拉框会显示筛出来的第一个人，而 `userId` 还是原来那个 ——
   * 于是**屏幕上写着 A，授权给的是 B**。这是这个表单唯一可能
   * 把权限给错人的地方。
   */
  const selected = people.find((p) => p.id === userId);
  const effectiveId = matched.some((p) => p.id === userId) ? userId : (matched[0]?.id ?? "");

  const allPicked = groups.length > 0 && picked.size === groups.length;

  const toggle = (convId: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(convId)) next.delete(convId);
      else next.add(convId);
      return next;
    });

  const submit = () =>
    start(async () => {
      setError(null);
      setNote(null);
      const r = await grantSendManyAction({
        convIds: [...picked],
        userId: effectiveId,
        reason,
        // 留空 = 跟着全局走。填了也只会取更严的那个
        perDay: perDay.trim() ? Number(perDay) : null,
      });
      if (r.ok) {
        setNote(r.note);
        setReason("");
        setPerDay("");
        setPicked(new Set());
      } else setError(r.error);
    });

  const revoke = (g: GrantRow) =>
    start(async () => {
      setError(null);
      setNote(null);
      const r = await revokeSendAction(g.convId, g.userId);
      if (r.ok) setNote(r.note);
      else setError(r.error);
    });

  return (
    <>
      <div className="inset-group mb-3 px-3.5 py-3">
        <p className="t-subhead font-medium">给一个人发送权限</p>

        <div className="mt-3 flex items-baseline justify-between">
          <label className="t-caption2 text-[var(--ink-quaternary)]">
            发到哪些群（已选 {picked.size}/{groups.length}）
          </label>
          <button
            type="button"
            onClick={() => setPicked(allPicked ? new Set() : new Set(groups.map((g) => g.convId)))}
            className="t-caption2 text-[var(--accent)] transition active:opacity-60"
          >
            {allPicked ? "全不选" : "全选"}
          </button>
        </div>
        <div className="mt-1 space-y-0.5 rounded-[var(--radius-control)] bg-[var(--surface-sunken)] p-1.5">
          {groups.map((g) => {
            const on = picked.has(g.convId);
            return (
              <button
                key={g.convId}
                type="button"
                onClick={() => toggle(g.convId)}
                aria-pressed={on}
                className="flex min-h-9 w-full items-center gap-2 rounded-[var(--radius-control)] px-2 text-left transition active:opacity-60"
              >
                <span
                  aria-hidden
                  className="flex h-4 w-4 shrink-0 items-center justify-center rounded-[0.25rem]"
                  style={{
                    background: on ? "var(--accent)" : "var(--fill)",
                    color: "var(--accent-ink)",
                  }}
                >
                  {on && <Check className="h-3 w-3" strokeWidth={3} aria-hidden />}
                </span>
                <span className="t-footnote min-w-0 flex-1 truncate">{g.name}</span>
              </button>
            );
          })}
        </div>
        {/*
          * 「全选」= 展开成当时这几个，不是一条通配授权。
          *
          * 通配会让授权自己长大：三个月后多一个群，它会被一起给出去，
          * 而那件事没有人做过决定。这句话必须写在界面上 ——
          * 不写的话，站长会合理地以为「全选」包含以后的群。
          */}
        {allPicked && (
          <p className="t-caption2 mt-1 px-1 text-[var(--ink-quaternary)]">
            全选是「现在这 {groups.length} 个」。以后新加的群<strong>不会</strong>自动包含 ——
            授权不该自己长大。
          </p>
        )}

        <label className="t-caption2 mt-3 block text-[var(--ink-quaternary)]">授权给谁</label>
        {/*
          * 从人名里选，不是手打账号 id。
          *
          * 原来这里是一个填 `01JABC…` 的输入框 —— 而没有人知道另一个人的
          * 内部 id 长什么样：得先开用户管理页、找到他、复制、再切回来。
          * 于是这个功能虽然做出来了，实际上很难用。
          */}
        <div className="mt-1 flex items-center gap-1.5 rounded-[var(--radius-control)] bg-[var(--surface-sunken)] px-2.5">
          <Search className="h-3.5 w-3.5 shrink-0 text-[var(--ink-quaternary)]" strokeWidth={2} aria-hidden />
          <input
            value={personQuery}
            onChange={(e) => setPersonQuery(e.target.value)}
            placeholder={`搜一下（共 ${people.length} 人）`}
            aria-label="搜索成员"
            className="t-body min-w-0 flex-1 bg-transparent py-2 outline-none"
          />
        </div>
        {matched.length === 0 ? (
          <p className="t-caption2 mt-1 px-1" style={{ color: "var(--danger)" }}>
            没有叫这个名字的
          </p>
        ) : (
          <select
            value={effectiveId}
            onChange={(e) => setUserId(e.target.value)}
            size={Math.min(6, matched.length)}
            className="t-body mt-1 w-full rounded-[var(--radius-control)] bg-[var(--surface-sunken)] px-3 py-2 outline-none"
          >
            {matched.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        {/*
          * 把最终选中的人再念一遍。
          *
          * 搜索框会改变列表内容，而「屏幕上高亮的那一行」和
          * 「真正会被授权的那个 id」在筛选之后可能不是同一个人 ——
          * 这一行是最后一道防线，它念的是真的要提交的那个。
          */}
        {effectiveId && (
          <p className="t-caption2 mt-1 px-1 text-[var(--ink-tertiary)]">
            将授权给：
            <strong>
              {matched.find((p) => p.id === effectiveId)?.name ?? selected?.name ?? effectiveId}
            </strong>
          </p>
        )}

        <label className="t-caption2 mt-3 block text-[var(--ink-quaternary)]">
          为什么给他（必填 —— 半年后这是唯一要问的问题）
        </label>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="比如：他在维护打卡机器人"
          className="t-body mt-1 w-full rounded-[var(--radius-control)] bg-[var(--surface-sunken)] px-3 py-2 outline-none"
        />

        <label className="t-caption2 mt-3 block text-[var(--ink-quaternary)]">
          每天最多几条（留空 = 跟全局的 {limits.perDay} 条走；填了只会更严）
        </label>
        <input
          value={perDay}
          onChange={(e) => setPerDay(e.target.value.replace(/\D/g, ""))}
          inputMode="numeric"
          placeholder={String(limits.perDay)}
          className="t-body mt-1 w-full rounded-[var(--radius-control)] bg-[var(--surface-sunken)] px-3 py-2 outline-none"
        />

        <button
          type="button"
          disabled={pending || !effectiveId || picked.size === 0 || !reason.trim()}
          onClick={submit}
          className="t-footnote mt-3 inline-flex min-h-11 items-center rounded-[var(--radius-pill)] px-3.5 font-medium text-[var(--accent)] transition active:opacity-60 disabled:opacity-45"
          style={{ background: "color-mix(in srgb, var(--accent) 12%, transparent)" }}
        >
          {pending
            ? "处理中…"
            : picked.size > 1
              ? `授权 ${picked.size} 个群`
              : "授权"}
        </button>

        {error && (
          <p className="t-caption mt-2" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        )}
        {note && <p className="t-caption mt-2 text-[var(--accent)]">{note}</p>}
      </div>

      {grants.length === 0 ? (
        <p className="t-caption px-1 text-[var(--ink-tertiary)]">还没有授权过任何人。</p>
      ) : (
        <div className="space-y-1.5">
          {grants.map((g) => (
            <div
              key={`${g.convId}:${g.userId}`}
              className="inset-group flex items-start gap-2.5 px-3.5 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <p className="t-subhead font-medium">
                  {g.userName ?? g.userId} → {g.convName ?? g.convId}
                </p>
                <p className="t-caption2 text-[var(--ink-quaternary)]">
                  {g.reason ?? "（没写理由）"}
                  {g.perDay !== null && ` · 每天 ${g.perDay} 条`}
                </p>
              </div>
              <button
                type="button"
                disabled={pending}
                onClick={() => revoke(g)}
                className="t-caption2 shrink-0 rounded-[var(--radius-pill)] px-2.5 py-1 text-[var(--ink-tertiary)] transition active:opacity-60 disabled:opacity-45"
                style={{ background: "var(--fill)" }}
              >
                收回
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
