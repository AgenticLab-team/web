import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { ApiConsole } from "@/components/api/ApiConsole";
import { EndpointDoc } from "@/components/api/EndpointDoc";
import { LogFilters } from "@/components/api/LogFilters";
import { Pager } from "@/components/ui/Pager";
import { GroupComposer } from "@/components/api/GroupComposer";
import { SendLog } from "@/components/api/SendLog";
import { TokenManager } from "@/components/api/TokenManager";
import { PageHeader } from "@/components/shell/PageHeader";
import { BackLink, PageNote, Section } from "@/components/ui/primitives";
import { allowedFor, blockedFor, NOT_POSSIBLE, ENDPOINTS } from "@/lib/api-tokens/catalog";
import {
  attributionCost,
  MAX_MESSAGE_CHARS,
  SCOPES,
  SEND_LIMIT,
  type ScopeKey,
  withAttribution,
} from "@/lib/api-tokens/rules";
import { grantedGroups, sendLog, senderNameOf, tokensOf, usageOf } from "@/lib/api-tokens/store";
import { getCurrentUser } from "@/lib/auth/session";
import { visibleGroupsFor } from "@/lib/queries/visibility";

export const metadata: Metadata = { title: "开放 API" };
export const dynamic = "force-dynamic";

/**
 * 「我的 → 开放 API」。
 *
 * ═════════════════════════════════════════
 * 文档按人算，不是一份写死的
 * ═════════════════════════════════════════
 *
 * 站长要的是「附有按照权限变动的动态 api 文档」。
 *
 * 一份写死的文档最常见的坏法不是过期，而是**它描述的是另一个人的世界**：
 * 读的人照着调，拿回一串 403，然后开始怀疑是自己写错了。
 * 所以这一页把「你能发到哪几个群」也算出来 —— 那是两个条件的交集
 * （站长授权过 **且** 你确实还在那个群里），只列其中一个都会给出
 * 一个调用必然失败的 conv_id。
 */
/** 日志一页多少条 */
const PER_PAGE = 20;

export default async function ApiPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/me/api");

  const sp = await searchParams;
  const one = (key: string) => {
    const value = sp[key];
    return Array.isArray(value) ? value[0] : value;
  };
  const conv = one("conv") ?? "";
  const rawStatus = one("status");
  const status = rawStatus === "ok" || rawStatus === "failed" ? rawStatus : "all";
  const q = one("q") ?? "";
  const page = Math.max(1, Number(one("page") ?? 1) || 1);

  const tokens = tokensOf(user.id);
  /*
   * 只给他自己那一份 —— 「看别人的」没有任何合理场景，只会变成越权入口。
   *
   * `userId` 写死成 user.id，**不从 searchParams 里取**：
   * 从地址栏取的话，改一个参数就能看别人代发了什么。
   */
  const log = sendLog({
    userId: user.id,
    convId: conv || null,
    status,
    query: q || null,
    limit: PER_PAGE,
    offset: (page - 1) * PER_PAGE,
  });
  const logPages = Math.max(1, Math.ceil(log.total / PER_PAGE));
  /*
   * 每把令牌今天用掉了多少。
   *
   * 界面上要答得出「我还能发几条」—— 只写上限不写用量的话，
   * 撞限流的人第一反应是「是不是坏了」，而不是「我发太多了」。
   */
  /*
   * 用量是**按人**算的，不是按令牌 —— 十把令牌共用一份额度。
   *
   * 界面上要答得出「我还能发几条」：只写上限不写用量的话，
   * 撞限流的人第一反应是「是不是坏了」，而不是「我发太多了」。
   */
  const usage = usageOf(user.id);
  const senderName = senderNameOf(user.id);
  /*
   * 列的是**你在的所有群**，标出哪些能发。
   *
   * 原来这里只列被授权的那几个 —— 于是绝大多数人（一个授权都没有的）
   * 看到的是一句「还没有」，而他真正需要的是 conv_id：
   * 读消息、读公告这些不需要授权的接口，也一样要 conv_id 才调得动。
   * 站长的原话是「开放平台看不到群列表啊」。
   *
   * 「群列表属于隐私」在这里仍然成立：visibleGroupsFor 给的就是
   * 他在网页上看得到的那几个群，一个不多。
   */
  /*
   * ═════════════════════════════════════════
   * 文档按**他手上真有的令牌**算
   * ═════════════════════════════════════════
   *
   * 这一页原来把 ENDPOINTS 整份列出来 —— 而站长要的是
   * 「附有按照权限变动的动态 api 文档」。
   *
   * 一份写死的清单最常见的坏法不是过期，是**它描述的是另一个人的世界**：
   * 读的人照着调，拿回一串 403，然后开始怀疑是自己写错了。
   *
   * 并集而不是逐把算：他可能一把管读、一把管写，而「我能不能调这条」
   * 的答案是「手上有没有任何一把能调」。
   */
  const liveScopes = [
    ...new Set(tokens.filter((t) => t.revokedAt === null).flatMap((t) => t.scopes)),
  ] as ScopeKey[];
  const usable = allowedFor(liveScopes);
  const locked = blockedFor(liveScopes);

  const granted = new Set(grantedGroups(user.id));
  const myGroups = visibleGroupsFor(user).map((g) => ({
    convId: g.convId,
    name: g.name,
    canSend: granted.has(g.convId),
  }));
  const sendable = myGroups.filter((g) => g.canSend);

  return (
    <>
      <BackLink href="/me">我的</BackLink>
      <PageHeader
        title="开放 API"
        subtitle="用令牌以你的身份读数据、往被授权的群发消息"
      />

      <TokenManager tokens={tokens} scopes={[...SCOPES]} />

      <Section title="你在的群">
        {sendable.length > 0 && (
          <div className="mb-2">
            <GroupComposer
              groups={sendable}
              maxChars={MAX_MESSAGE_CHARS - attributionCost(senderName)}
              /* 服务端拼出来的那一行，原样给它 —— 前端不重拼 */
              attributionLine={withAttribution("", senderName).trim()}
            />
          </div>
        )}
        {myGroups.length === 0 ? (
          <p className="t-caption px-1 leading-relaxed text-[var(--ink-tertiary)]">
            还没有绑定任何群。
          </p>
        ) : (
          <ul className="space-y-1.5">
            {myGroups.map((g) => (
              <li key={g.convId} className="inset-group px-3.5 py-2.5">
                <p className="t-subhead flex items-center gap-1.5 font-medium">
                  <span className="min-w-0 truncate">{g.name}</span>
                  {/*
                    * 能不能发要标出来。不标的话，人会挑一个群试着发，
                    * 而「试」在这里意味着真的往一千六百人的群里发一条。
                    */}
                  {g.canSend ? (
                    <span
                      className="t-caption2 shrink-0 rounded-[var(--radius-control)] px-1.5 py-0.5"
                      style={{
                        background: "color-mix(in srgb, var(--success) 14%, transparent)",
                        color: "var(--success)",
                      }}
                    >
                      可代发
                    </span>
                  ) : (
                    <span className="t-caption2 shrink-0 text-[var(--ink-quaternary)]">只读</span>
                  )}
                </p>
                {/*
                  * conv_id 要能一眼选中复制 —— 别的群接口全都要它，
                  * 而它是一串没人记得住的东西。
                  */}
                <code className="t-caption2 mt-0.5 block break-all text-[var(--ink-quaternary)]">
                  {g.convId}
                </code>
              </li>
            ))}
          </ul>
        )}
        {sendable.length === 0 && myGroups.length > 0 && (
          <p className="t-caption mt-2 px-1 leading-relaxed text-[var(--ink-tertiary)]">
            上面这些你都能<strong>读</strong>（消息、公告）。往群里发消息或改公告要站长
            <strong>逐个群</strong>授权 —— 拿到之后这一行会变成「可代发」，
            而且每条发出去的都会自动带一行「本消息由「你」使用 AgenticLab.sh 代发」。
          </p>
        )}
        <p className="t-caption2 mt-2 px-1 text-[var(--ink-quaternary)]">
          每把令牌最多 {SEND_LIMIT.perMinute} 条/分钟、{SEND_LIMIT.perHour} 条/小时、
          {SEND_LIMIT.perDay} 条/天（站长可以在授权上再调紧）。
          上游的额度是全站共用的，所以这里压得低 —— 剩下的要留给站长公告和系统告警。
        </p>
        <p className="t-caption2 mt-1 px-1 text-[var(--ink-quaternary)]">
          这份额度<strong>按人算，不按令牌算</strong> —— 你手上几把令牌加上网页这条路，
          一共就这么多。你今天已经发了 {usage.day}/{SEND_LIMIT.perDay} 条、这小时{" "}
          {usage.hour}/{SEND_LIMIT.perHour} 条。
        </p>
      </Section>

      <Section title="在线测试">
        <ApiConsole endpoints={ENDPOINTS.map((e) => ({ ...e }))} />
      </Section>

      <Section title="代发日志">
        {/* 一条都没发过的时候不给过滤条 —— 过滤一个空列表是纯噪音 */}
        {(log.total > 0 || conv || q || status !== "all") && (
          <LogFilters groups={myGroups.map((g) => ({ value: g.convId, label: g.name }))} />
        )}
        <SendLog rows={log.rows} />
        <Pager
          page={Math.min(page, logPages)}
          pages={logPages}
          total={log.total}
          params={{ conv, status: status === "all" ? undefined : status, q }}
        />
        <p className="t-caption2 mt-2 px-1 text-[var(--ink-quaternary)]">
          存的是拼好署名之后的整条，也就是群里真正看到的那一条 ——
          所以这里也看得出署名有没有真的加上。失败的也记，
          否则「试了一百次都失败」在限流上等于没发生过。
        </p>
      </Section>

      {/*
        * 分成「调得动的」和「还差权限的」两栏。
        *
        * 两栏都要有 —— 只列调得动的话，人根本不知道站里还有别的接口；
        * 混在一起的话，他会照着一条自己调不动的去写，
        * 然后对着 403 检查半天令牌。
        */}
      <Section title={`你现在调得动的（${usable.length}）`}>
        {usable.length === 0 ? (
          <p className="t-caption px-1 leading-relaxed text-[var(--ink-tertiary)]">
            还没有可用的令牌。上面建一把，勾上你要的权限。
          </p>
        ) : (
          <div className="space-y-2">
            {usable.map((e) => (
              <EndpointDoc key={`${e.method} ${e.path}`} endpoint={e} />
            ))}
          </div>
        )}
        <p className="t-caption2 mt-2 px-1 text-[var(--ink-quaternary)]">
          带上令牌调 <code>/api/v1/docs</code>，拿到的是<strong>这一份的 JSON 版</strong> ——
          同一套算法，所以它不会和这一页说不同的话。
        </p>
      </Section>

      {locked.length > 0 && (
        <Section title={`还差权限的（${locked.length}）`}>
          <div className="space-y-2">
            {locked.map(({ endpoint, missing }) => (
              <EndpointDoc
                key={`${endpoint.method} ${endpoint.path}`}
                endpoint={endpoint}
                missing={missing}
              />
            ))}
          </div>
        </Section>
      )}

      {/*
        * 做不到的也写出来。
        *
        * 不写的话，下一个人会先花半天找「群公告」和「踢人」，
        * 然后得出「文档不全」的结论 —— 而实际是它们不存在。
        */}
      <Section title="做不到的">
        <ul className="space-y-1.5">
          {NOT_POSSIBLE.map((n) => (
            <li key={n.what} className="inset-group px-3.5 py-2.5">
              <p className="t-subhead font-medium">{n.what}</p>
              <p className="t-caption mt-0.5 leading-relaxed text-[var(--ink-secondary)]">
                {n.why}
              </p>
            </li>
          ))}
        </ul>
      </Section>

      <PageNote>
        令牌等于一把钥匙：<strong>拿到它的人就是你</strong>。它不会带来你本来没有的权限，
        但会让别人以你的名义使用你已有的权限 —— 所以别贴进群里、别提交进仓库。
        发现贴错了就来这里撤销，撤销是立刻生效的。
      </PageNote>
    </>
  );
}
