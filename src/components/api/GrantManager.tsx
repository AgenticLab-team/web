"use client";

import { useMemo, useState, useTransition } from "react";
import { Check, Search, X } from "lucide-react";

import { grantSendManyAction, revokeSendAction } from "@/lib/api-tokens/actions";
import {
  filterPersonGrants,
  mergeGrantsByUser,
  paginate,
  type PersonGrants,
} from "@/lib/api-tokens/grant-view";
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
/** 一页显示几个人。手机上再多就要划很久 */
const PER_PAGE = 8;

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
  /* 已给出去的那张列表自己的筛选和页码 —— 和上面那个表单互不相干 */
  const [listQuery, setListQuery] = useState("");
  const [page, setPage] = useState(1);
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

  /*
   * 一个人一张卡。库里存的仍然是逐群的行 ——
   * 合并只发生在显示这一层，见 grant-view.ts。
   */
  const merged = useMemo(() => mergeGrantsByUser(grants), [grants]);
  const shown = useMemo(
    () => paginate(filterPersonGrants(merged, listQuery), page, PER_PAGE),
    [merged, listQuery, page],
  );

  const revoke = (convId: string, uid: string) =>
    start(async () => {
      setError(null);
      setNote(null);
      const r = await revokeSendAction(convId, uid);
      if (r.ok) setNote(r.note);
      else setError(r.error);
    });

  const revokeAll = (person: PersonGrants) =>
    start(async () => {
      setError(null);
      setNote(null);
      /*
       * 一个个来，不做成一次批量调用。
       *
       * 收回是逐群的（审计也是逐群的），而「全部收回」只是替他
       * 少点几下 —— 把它做成一个批量接口的话，就多出一条
       * 需要单独测、单独想权限的路，换来的只是少几次往返。
       */
      for (const g of person.groups) {
        const r = await revokeSendAction(g.convId, person.userId);
        if (!r.ok) {
          setError(r.error);
          return;
        }
      }
      setNote(`收回了「${person.userName}」的 ${person.groups.length} 个群`);
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

      {/* ── 已经给出去的 ─────────────────────────────── */}

      {merged.length === 0 ? (
        <p className="t-caption px-1 text-[var(--ink-tertiary)]">还没有授权过任何人。</p>
      ) : (
        <>
          {/*
            * 人多了才给搜索框。三个人的时候一个搜索框只是噪音，
            * 而它占的那一行在手机上是实打实的一屏的十分之一。
            */}
          {merged.length > 5 && (
            <div className="mb-2 flex items-center gap-1.5 rounded-[var(--radius-control)] bg-[var(--surface-sunken)] px-2.5">
              <Search
                className="h-3.5 w-3.5 shrink-0 text-[var(--ink-quaternary)]"
                strokeWidth={2}
                aria-hidden
              />
              <input
                value={listQuery}
                onChange={(e) => {
                  setListQuery(e.target.value);
                  // 筛完可能只剩一页，停在第 3 页会看到空白
                  setPage(1);
                }}
                placeholder="搜人名、群名或理由"
                aria-label="筛选授权"
                className="t-body min-w-0 flex-1 bg-transparent py-2 outline-none"
              />
            </div>
          )}

          {shown.items.length === 0 ? (
            <p className="t-caption px-1 text-[var(--ink-tertiary)]">没有匹配的。</p>
          ) : (
            <div className="space-y-1.5">
              {shown.items.map((person) => (
                <div key={person.userId} className="inset-group px-3.5 py-3">
                  <div className="flex items-start gap-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="t-subhead font-medium">
                        {person.userName}
                        <span className="t-caption2 ml-1.5 font-normal text-[var(--ink-quaternary)]">
                          {person.groups.length} 个群
                        </span>
                      </p>
                      {/*
                        * 理由和额度一致时合成一句；不一致就交给下面逐群显示。
                        * 合成一句是**在界面上说假话**的地方 —— 见 grant-view.ts。
                        */}
                      {!person.mixed && (
                        <p className="t-caption2 mt-0.5 text-[var(--ink-quaternary)]">
                          {person.uniformReason ?? "（没写理由）"}
                          {person.uniformPerDay !== null && ` · 每天 ${person.uniformPerDay} 条`}
                        </p>
                      )}
                    </div>
                    {person.groups.length > 1 && (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => revokeAll(person)}
                        className="t-caption2 shrink-0 rounded-[var(--radius-pill)] px-2.5 py-1 transition active:opacity-60 disabled:opacity-45"
                        style={{
                          background: "color-mix(in srgb, var(--danger) 10%, transparent)",
                          color: "var(--danger)",
                        }}
                      >
                        全部收回
                      </button>
                    )}
                  </div>

                  {/*
                    * 群做成一排可点的标签，点一下收回那一个。
                    *
                    * 每个群单独一行的话，十二个群就是十二行 ——
                    * 而合并显示的全部意义就是不要那十二行。
                    */}
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {person.groups.map((g) => (
                      <button
                        key={g.convId}
                        type="button"
                        disabled={pending}
                        onClick={() => revoke(g.convId, person.userId)}
                        title={`收回「${g.convName}」的发送权限`}
                        className="t-caption2 inline-flex min-h-8 items-center gap-1 rounded-[var(--radius-pill)] px-2.5 transition active:opacity-60 disabled:opacity-45"
                        style={{ background: "var(--fill)" }}
                      >
                        <span className="max-w-[11rem] truncate">{g.convName}</span>
                        {/*
                          * 额度和理由不一致时，把这个群自己的额度标在它身上 ——
                          * 上面那句合并的话已经没了，不标的话这条信息就消失了。
                          */}
                        {person.mixed && g.perDay !== null && (
                          <span className="text-[var(--warning)]">{g.perDay}/天</span>
                        )}
                        <X className="h-3 w-3 shrink-0 text-[var(--ink-quaternary)]" strokeWidth={2.4} aria-hidden />
                      </button>
                    ))}
                  </div>

                  {/* 理由不一致时逐条列出来 —— 合成一句会把差异抹掉 */}
                  {person.mixed && (
                    <ul className="mt-2 space-y-0.5">
                      {person.groups.map((g) => (
                        <li key={g.convId} className="t-caption2 text-[var(--ink-quaternary)]">
                          {g.convName}：{g.reason ?? "（没写理由）"}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}

          {shown.pages > 1 && (
            <div className="mt-2 flex items-center justify-between gap-2 px-1">
              <button
                type="button"
                disabled={shown.page <= 1}
                onClick={() => setPage(shown.page - 1)}
                className="t-footnote min-h-9 rounded-[var(--radius-control)] px-3 transition active:opacity-60 disabled:opacity-35"
                style={{ background: "var(--fill)" }}
              >
                上一页
              </button>
              <span className="tabular t-caption2 text-[var(--ink-quaternary)]">
                第 {shown.page} / {shown.pages} 页 · 共 {shown.total} 人
              </span>
              <button
                type="button"
                disabled={shown.page >= shown.pages}
                onClick={() => setPage(shown.page + 1)}
                className="t-footnote min-h-9 rounded-[var(--radius-control)] px-3 transition active:opacity-60 disabled:opacity-35"
                style={{ background: "var(--fill)" }}
              >
                下一页
              </button>
            </div>
          )}
          {shown.pages <= 1 && (
            <p className="t-caption2 mt-2 px-1 text-[var(--ink-quaternary)]">
              一共 {shown.total} 人拿到过授权
            </p>
          )}
        </>
      )}
    </>
  );
}
