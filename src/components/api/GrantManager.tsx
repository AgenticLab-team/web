"use client";

import { useMemo, useState, useTransition } from "react";
import { AlertTriangle, Check, CheckCircle2, Search, ShieldPlus, X } from "lucide-react";

import { ActionButton, CONTROL, Field, Panel, StatusNote } from "@/components/api/fields";
import { Empty } from "@/components/ui/primitives";
import { grantSendManyAction, revokeSendAction } from "@/lib/api-tokens/actions";
import {
  filterPersonGrants,
  mergeGrantsByUser,
  slicePage,
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
 *
 * ═════════════════════════════════════════
 * 表单排成「给谁 → 哪些群 → 为什么 → 多少」
 * ═════════════════════════════════════════
 *
 * 原来第一步是「发到哪些群」，人选完一串群之后才被问到给谁 ——
 * 而站长脑子里的顺序永远是先想到一个人。顺序对不上的表单
 * 会让人来回跳着填，中途还要滚回去确认自己选的是谁。
 *
 * 桌面端表单钉在左边、名单在右边：判断「这条授权还该不该留着」
 * 要同时看见两边，而原来它们是上下两屏。
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
    () => slicePage(filterPersonGrants(merged, listQuery), page, PER_PAGE),
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

  const ready = Boolean(effectiveId) && picked.size > 0 && reason.trim().length > 0;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,23rem)_minmax(0,1fr)] lg:items-start lg:gap-6">
      {/* ── 左：发一条新授权 ─────────────────────────── */}
      {/*
        * `min-w-0` 是**正确性**，不是样式（和 `StatTile` 上那段注释同一回事）。
        *
        * 这个 div 是外面那个 grid 的直接子项，而 grid item 默认
        * `min-width: auto` —— 放不下时它不收缩，而是把自己那一列顶宽。
        * 里面是一串人名和群名（长度不受控），min-content 算出来 510px，
        * 于是 358px 的容器里长出一根 510px 的列：
        * 整页 `scrollWidth` 527 > 视口 390，**手机上整个后台横着滑**，
        * 连固定的顶栏和底部导航都被拽出去。
        *
        * `me/api/page.tsx` 里那个同类容器早就带着 `min-w-0` ——
        * 有人踩过、在自己那一处修好了，而这一处没跟上。
        */}
      <div className="min-w-0 lg:sticky lg:top-16">
        <Panel title="给一个人发送权限">
          {/* ① 给谁 */}
          <Field label="授权给谁">
            {/*
              * 从人名里选，不是手打账号 id。
              *
              * 原来这里是一个填 `01JABC…` 的输入框 —— 而没有人知道另一个人的
              * 内部 id 长什么样：得先开用户管理页、找到他、复制、再切回来。
              * 于是这个功能虽然做出来了，实际上很难用。
              */}
            <div className="flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] bg-[var(--surface-sunken)] px-3">
              <Search
                className="h-4 w-4 shrink-0 text-[var(--ink-quaternary)]"
                strokeWidth={2}
                aria-hidden
              />
              <input
                value={personQuery}
                onChange={(e) => setPersonQuery(e.target.value)}
                placeholder={`搜一下（共 ${people.length} 人）`}
                aria-label="搜索成员"
                className="t-body min-w-0 flex-1 bg-transparent py-2 outline-none placeholder:text-[var(--ink-quaternary)]"
              />
            </div>
          </Field>

          {matched.length === 0 ? (
            <p className="t-caption mt-1.5" style={{ color: "var(--danger)" }}>
              没有叫这个名字的
            </p>
          ) : (
            <select
              value={effectiveId}
              onChange={(e) => setUserId(e.target.value)}
              size={Math.min(6, matched.length)}
              aria-label="从搜索结果里选人"
              /*
                * `min-w-0` 是**正确性**，不是样式。
                *
                * `<select>` 的最小宽度由**最长的那个选项**决定，而 `w-full`
                * （`width: 100%`）压不过 `min-width: auto`。这里列的是人名，
                * 长度不受控 —— 种子数据里那个「一个把自己的群昵称写得非常非常
                * 长的人你看它会不会撑破卡片」把这个 select 撑到 479px，
                * 于是整页 `scrollWidth` 527 > 视口 390：**手机上整个后台横着滑**，
                * 连固定的顶栏和底部导航都被拽出去了。
                *
                * 同一页另一个 select 早就带着 `min-w-0`（172px，规规矩矩）——
                * 修法一直就在旁边，只是没传过来。
                */
              className="t-body mt-1.5 w-full min-w-0 rounded-[var(--radius-control)] bg-[var(--surface-sunken)] p-1.5 outline-none"
            >
              {matched.map((p) => (
                <option key={p.id} value={p.id} className="rounded-[var(--radius-chip)] px-2 py-1">
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
            <p className="t-caption mt-1.5 text-[var(--ink-secondary)]">
              将授权给{" "}
              <strong className="text-[var(--ink)]">
                {matched.find((p) => p.id === effectiveId)?.name ?? selected?.name ?? effectiveId}
              </strong>
            </p>
          )}

          {/* ② 哪些群 */}
          <fieldset className="mt-4">
            <div className="flex items-baseline justify-between gap-2">
              <legend className="t-footnote font-medium text-[var(--ink-secondary)]">
                发到哪些群
              </legend>
              <button
                type="button"
                onClick={() =>
                  setPicked(allPicked ? new Set() : new Set(groups.map((g) => g.convId)))
                }
                className="tap-target t-caption font-medium text-[var(--accent)] transition active:opacity-60"
              >
                {allPicked ? "全不选" : "全选"}
              </button>
            </div>
            <p className="t-caption mt-0.5 text-[var(--ink-tertiary)]">
              已选 {picked.size} / {groups.length}
            </p>

            {/*
              * 限高再滚。群多的时候（现在十几个，以后只会更多）
              * 这一块会把下面的「为什么」和提交按钮整个推出屏幕，
              * 而那两样是必填的。
              */}
            <div className="mt-1.5 max-h-64 overflow-y-auto rounded-[var(--radius-control)] bg-[var(--surface-sunken)] p-1.5">
              {groups.map((g) => {
                const on = picked.has(g.convId);
                return (
                  <button
                    key={g.convId}
                    type="button"
                    onClick={() => toggle(g.convId)}
                    aria-pressed={on}
                    className="flex min-h-11 w-full items-center gap-2.5 rounded-[var(--radius-control)] px-2.5 text-left transition-colors hover:bg-[var(--fill)]"
                  >
                    <span
                      aria-hidden
                      className="flex h-[1.125rem] w-[1.125rem] shrink-0 items-center justify-center rounded-[var(--radius-chip)]"
                      style={{
                        background: on ? "var(--accent)" : "var(--fill-strong)",
                        color: "var(--accent-ink)",
                      }}
                    >
                      {on && <Check className="h-3 w-3" strokeWidth={3} aria-hidden />}
                    </span>
                    <span className="t-subhead min-w-0 flex-1 truncate">{g.name}</span>
                  </button>
                );
              })}
            </div>
          </fieldset>

          {/*
            * 「全选」= 展开成当时这几个，不是一条通配授权。
            *
            * 通配会让授权自己长大：三个月后多一个群，它会被一起给出去，
            * 而那件事没有人做过决定。这句话必须写在界面上 ——
            * 不写的话，站长会合理地以为「全选」包含以后的群。
            */}
          {allPicked && (
            <p className="t-caption mt-1.5 text-[var(--ink-tertiary)]">
              全选是「现在这 {groups.length} 个」。以后新加的群<strong>不会</strong>自动包含 ——
              授权不该自己长大。
            </p>
          )}

          {/* ③ 为什么 */}
          <Field
            label="为什么给他"
            hint="必填。半年后回头看，这是唯一要问的问题。"
            className="mt-4"
          >
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="比如：他在维护打卡机器人"
              className={CONTROL}
            />
          </Field>

          {/* ④ 额度 */}
          <Field
            label="每天最多几条"
            hint={`留空就跟全局的 ${limits.perDay} 条走。填了只会更严，不会更宽。`}
            className="mt-4"
          >
            <input
              value={perDay}
              onChange={(e) => setPerDay(e.target.value.replace(/\D/g, ""))}
              inputMode="numeric"
              placeholder={String(limits.perDay)}
              className={CONTROL}
            />
          </Field>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <ActionButton
              busy={pending}
              disabled={!ready}
              onClick={submit}
              icon={<ShieldPlus className="h-4 w-4" strokeWidth={2.2} aria-hidden />}
            >
              {pending ? "处理中…" : picked.size > 1 ? `授权 ${picked.size} 个群` : "授权"}
            </ActionButton>
            {/* 按钮为什么是灰的，直说 —— 三个必填项少哪个都会卡在这里 */}
            {!ready && !pending && (
              <span className="t-caption text-[var(--ink-tertiary)]">
                {picked.size === 0 ? "先选至少一个群" : !reason.trim() ? "理由必填" : "先选一个人"}
              </span>
            )}
          </div>

          {error && (
            <StatusNote
              tone="error"
              className="mt-3"
              icon={<AlertTriangle className="h-4 w-4" strokeWidth={2.2} aria-hidden />}
            >
              {error}
            </StatusNote>
          )}
          {note && (
            <StatusNote
              tone="ok"
              className="mt-3"
              icon={<CheckCircle2 className="h-4 w-4" strokeWidth={2.2} aria-hidden />}
            >
              {note}
            </StatusNote>
          )}
        </Panel>
      </div>

      {/* ── 右：已经给出去的 ─────────────────────────── */}
      <div className="min-w-0">
        {merged.length === 0 ? (
          <Empty
            title="还没有授权过任何人"
            hint="在左边选人、选群、写清楚理由。给出去的每一条都会出现在这里。"
          />
        ) : (
          <>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2 px-1">
              <h3 className="t-group-label">已经给出去的（{merged.length} 人）</h3>
            </div>

            {/*
              * 人多了才给搜索框。三个人的时候一个搜索框只是噪音，
              * 而它占的那一行在手机上是实打实的一屏的十分之一。
              */}
            {merged.length > 5 && (
              <div className="mb-2 flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] bg-[var(--surface-sunken)] px-3">
                <Search
                  className="h-4 w-4 shrink-0 text-[var(--ink-quaternary)]"
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
                  className="t-body min-w-0 flex-1 bg-transparent py-2 outline-none placeholder:text-[var(--ink-quaternary)]"
                />
              </div>
            )}

            {shown.items.length === 0 ? (
              <p className="t-footnote px-1 text-[var(--ink-tertiary)]">
                没有匹配的。换个词，或者清空搜索框。
              </p>
            ) : (
              <div className="inset-group">
                {shown.items.map((person) => (
                  <div key={person.userId} className="inset-row p-4">
                    <div className="flex items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="t-subhead font-medium">
                          {person.userName}
                          <span className="t-caption ml-1.5 font-normal text-[var(--ink-tertiary)]">
                            {person.groups.length} 个群
                          </span>
                        </p>
                        {/*
                          * 理由和额度一致时合成一句；不一致就交给下面逐群显示。
                          * 合成一句是**在界面上说假话**的地方 —— 见 grant-view.ts。
                          */}
                        {!person.mixed && (
                          <p className="t-caption mt-0.5 text-[var(--ink-tertiary)]">
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
                          className="t-caption min-h-9 shrink-0 rounded-[var(--radius-pill)] px-2.5 transition active:opacity-60 disabled:opacity-45"
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
                      *
                      * 标签上必须有个 × ：不画的话，它看起来是个状态标签，
                      * 没有人会想到点它 —— 于是「收回一个群」这件事
                      * 在界面上等于不存在。
                      */}
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {person.groups.map((g) => (
                        <button
                          key={g.convId}
                          type="button"
                          disabled={pending}
                          onClick={() => revoke(g.convId, person.userId)}
                          title={`收回「${g.convName}」的发送权限`}
                          className="t-caption inline-flex min-h-9 items-center gap-1.5 rounded-[var(--radius-pill)] px-2.5 transition-colors hover:bg-[var(--fill-strong)] disabled:opacity-45"
                          style={{ background: "var(--fill)" }}
                        >
                          <span className="max-w-[11rem] truncate">{g.convName}</span>
                          {/*
                            * 额度和理由不一致时，把这个群自己的额度标在它身上 ——
                            * 上面那句合并的话已经没了，不标的话这条信息就消失了。
                            */}
                          {person.mixed && g.perDay !== null && (
                            <span className="tabular" style={{ color: "var(--warning)" }}>
                              {g.perDay}/天
                            </span>
                          )}
                          <X
                            className="h-3.5 w-3.5 shrink-0 text-[var(--ink-quaternary)]"
                            strokeWidth={2.4}
                            aria-hidden
                          />
                        </button>
                      ))}
                    </div>

                    {/* 理由不一致时逐条列出来 —— 合成一句会把差异抹掉 */}
                    {person.mixed && (
                      <ul className="mt-2 space-y-0.5">
                        {person.groups.map((g) => (
                          <li key={g.convId} className="t-caption text-[var(--ink-tertiary)]">
                            {g.convName}：{g.reason ?? "（没写理由）"}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            )}

            {shown.slice.totalPages > 1 ? (
              <div className="mt-3 flex items-center justify-between gap-2 px-1">
                <button
                  type="button"
                  disabled={shown.slice.page <= 1}
                  onClick={() => setPage(shown.slice.page - 1)}
                  className="t-footnote min-h-11 rounded-[var(--radius-control)] px-3.5 transition-colors hover:bg-[var(--fill-strong)] disabled:opacity-35"
                  style={{ background: "var(--fill)" }}
                >
                  上一页
                </button>
                <span className="tabular t-caption text-[var(--ink-tertiary)]">
                  第 {shown.slice.page} / {shown.slice.totalPages} 页 · 共 {shown.total} 人
                </span>
                <button
                  type="button"
                  disabled={shown.slice.page >= shown.slice.totalPages}
                  onClick={() => setPage(shown.slice.page + 1)}
                  className="t-footnote min-h-11 rounded-[var(--radius-control)] px-3.5 transition-colors hover:bg-[var(--fill-strong)] disabled:opacity-35"
                  style={{ background: "var(--fill)" }}
                >
                  下一页
                </button>
              </div>
            ) : (
              <p className="t-caption mt-3 px-1 text-[var(--ink-tertiary)]">
                一共 {shown.total} 人拿到过授权
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
