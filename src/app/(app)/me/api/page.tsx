import { KeyRound, Radio } from "lucide-react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { ApiConsole } from "@/components/api/ApiConsole";
import { EndpointDoc } from "@/components/api/EndpointDoc";
import { LogFilters } from "@/components/api/LogFilters";
import { Pagination } from "@/components/ui/Pagination";
import { paginate } from "@/lib/pagination";
import { GroupComposer } from "@/components/api/GroupComposer";
import { SendLog } from "@/components/api/SendLog";
import { TokenManager } from "@/components/api/TokenManager";
import { PageHeader } from "@/components/shell/PageHeader";
import { BackLink, Callout, PageNote, Pill, PillRow, Section } from "@/components/ui/primitives";
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
 *
 * ═════════════════════════════════════════
 * 版面：一条长流 → 两栏 + 一份目录
 * ═════════════════════════════════════════
 *
 * 站长的原话是「ui 布局都是灾难」。这一页最具体的病是**它没有层级**：
 * 令牌、群列表、在线测试、日志、十二条端点文档、做不到的清单，
 * 六件事一样宽、一样重、从上到下排成一条，手机上要划过整整十屏，
 * 桌面上两侧各空着三百多像素。
 *
 * 拆法按「用的时候手会怎么动」来分，不是按数据来源分：
 *
 *   · **左（主栏）是要动手的**：建令牌、发一条、试一条、翻日志。
 *     它们都是「填点什么然后点一下」，需要宽度。
 *   · **右（副栏）是要照着抄的**：还能发几条、群叫什么、conv_id 是多少。
 *     这些在动手的**同时**要看得见 —— 原来它们在两屏之外，
 *     于是每填一个 conv_id 都要上下滚一趟。所以副栏 sticky。
 *   · 手机上没有第二栏，就按「令牌 → 群和额度 → 动手 → 参考」排，
 *     并且在最上面给一排锚点，让人一步跳到自己要的那一段。
 *
 * 十二条端点文档改成可展开的目录（见 EndpointDoc），
 * 这一页最长的那一段因此从十屏收成了半屏。
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

  const tokens = tokensOf(user.id);
  /*
   * 只给他自己那一份 —— 「看别人的」没有任何合理场景，只会变成越权入口。
   *
   * `userId` 写死成 user.id，**不从 searchParams 里取**：
   * 从地址栏取的话，改一个参数就能看别人代发了什么。
   */
  const counted = sendLog({
    userId: user.id,
    convId: conv || null,
    status,
    query: q || null,
    limit: 1,
    offset: 0,
  });
  // 先夹页码再取那一页 —— 反过来的话 ?page=999 会显示「第 3 页」而列表是空的
  const slice = paginate(one("page"), counted.total, PER_PAGE);
  const log = sendLog({
    userId: user.id,
    convId: conv || null,
    status,
    query: q || null,
    limit: slice.perPage,
    offset: slice.offset,
  });
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

  /** 额度用掉的比例 —— 条子只表达「还剩多少」，数字才是精确值 */
  const meter = (used: number, cap: number) => Math.min(1, cap === 0 ? 1 : used / cap);

  return (
    <>
      <BackLink href="/me">我的</BackLink>
      <PageHeader title="开放 API" subtitle="让程序以你的身份读数据、往被授权的群发消息" />

      {/*
        * data-dense：这一页要宽栏。
        *
        * 它没有需要「读」的长句，全是要对照着看的东西 —— 端点、
        * conv_id、日志。压在 52rem 的正文栏宽里的话，右边那条
        * 「照着抄」的副栏根本放不下，而它正是这次重构的核心。
        */}
      <div data-dense>
        {/*
          * 一排锚点。手机上它是唯一能「一步到位」的东西 ——
          * 没有它，想看日志就得从令牌开始一路划过去。
          * 桌面上它顺带充当这一页的目录：进来先知道这里有几件事。
          */}
        <PillRow>
          <Pill href="#tokens">令牌</Pill>
          {sendable.length > 0 && <Pill href="#send">发一条</Pill>}
          <Pill href="#console">在线测试</Pill>
          <Pill href="#log">代发日志</Pill>
          <Pill href="#docs">接口</Pill>
        </PillRow>

        {/*
          * ── 署名 ────────────────────────────────
          *
          * 摆在最上面，在任何一个「发」的按钮之前。
          *
          * 它不是提示语，是这套东西的**不变量**：消息由机器人账号发出，
          * 群里没有人看得出是谁让它说的 —— 署名是唯一让「这句话是谁的」
          * 在群里当场成立的东西。所以它既写在这儿（进来就看见），
          * 也写在发送框里（发之前看得见那一行长什么样），
          * 还写在日志里（事后查得出有没有真的加上）。三处都不能省。
          */}
        <Callout
          tone="warning"
          title="每条发出去的消息都带代发署名"
          icon={<Radio className="h-4 w-4" strokeWidth={2.2} aria-hidden />}
        >
          <p className="t-footnote mt-1 leading-relaxed text-[var(--ink-secondary)]">
            消息由群里那个机器人发出，看的人认不出是谁让它说的。所以正文后面会自动接一行
            「本消息由「你」使用 AgenticLab.sh 代发」。这一行去不掉，网页和 API 两条路都一样。
          </p>
        </Callout>

        <div className="flex flex-col lg:grid lg:grid-cols-[minmax(0,1fr)_19rem] lg:items-start lg:gap-x-8">
          {/* ── 主栏 ①：令牌 ───────────────────────── */}
          <div className="order-1 min-w-0 lg:col-start-1 lg:row-start-1">
            <Section title="令牌">
              <TokenManager tokens={tokens} scopes={[...SCOPES]} />
            </Section>
          </div>

          {/*
            * ── 副栏：动手时要照着抄的 ─────────────────
            *
            * 桌面上跨两行并 sticky，所以往下翻到「在线测试」时，
            * conv_id 和剩余额度还在眼前。手机上它排在令牌后面 ——
            * 因为「我能发到哪个群」是建完令牌后的下一个问题。
            */}
          <aside
            /*
              * 钉住之后还要能滚：群多的时候这一栏比视口高，
              * 不给它自己的滚动条的话，最后几个群的 conv_id
              * 会永远停在视口下面 —— 而它们正是这一栏存在的理由。
              */
            className="order-2 min-w-0 lg:sticky lg:top-16 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:max-h-[calc(100dvh-6rem)] lg:overflow-y-auto lg:pb-2"
          >
            <Section title="今天还能发几条">
              <div className="inset-group p-4">
                <div className="space-y-3">
                  {[
                    { label: "今天", used: usage.day, cap: SEND_LIMIT.perDay },
                    { label: "这小时", used: usage.hour, cap: SEND_LIMIT.perHour },
                  ].map((row) => (
                    <div key={row.label}>
                      <p className="t-footnote flex items-baseline justify-between">
                        <span className="text-[var(--ink-secondary)]">{row.label}</span>
                        <span className="tabular font-medium">
                          {row.used} / {row.cap}
                        </span>
                      </p>
                      <div className="mt-1 h-1 overflow-hidden rounded-[var(--radius-pill)] bg-[var(--fill)]">
                        <div
                          className="progress-fill h-full bg-[var(--accent)]"
                          style={{
                            transform: `translateX(${meter(row.used, row.cap) * 100 - 100}%)`,
                          }}
                          aria-hidden
                        />
                      </div>
                    </div>
                  ))}
                </div>
                <p className="t-caption mt-3 leading-relaxed text-[var(--ink-tertiary)]">
                  按人算，不按令牌算 —— 几把令牌加上网页这条路，一共就这么多。
                  每分钟还另有 {SEND_LIMIT.perMinute} 条的上限。
                </p>
              </div>
            </Section>

            <Section title="你在的群">
              {myGroups.length === 0 ? (
                <p className="t-footnote px-1 leading-relaxed text-[var(--ink-tertiary)]">
                  你还没有绑定任何群。绑定之后，群 id 会列在这里。
                </p>
              ) : (
                <div className="inset-group">
                  {myGroups.map((g) => (
                    <div key={g.convId} className="inset-row px-4 py-3">
                      <p className="t-subhead flex items-center gap-1.5 font-medium">
                        <span className="min-w-0 truncate">{g.name}</span>
                        {/*
                          * 能不能发要标出来。不标的话，人会挑一个群试着发，
                          * 而「试」在这里意味着真的往一千六百人的群里发一条。
                          */}
                        {g.canSend ? (
                          <span
                            className="t-caption2 shrink-0 rounded-[var(--radius-pill)] px-1.5 py-0.5"
                            style={{
                              background: "color-mix(in srgb, var(--success) 14%, transparent)",
                              color: "var(--success)",
                            }}
                          >
                            可代发
                          </span>
                        ) : (
                          <span className="t-caption2 shrink-0 text-[var(--ink-quaternary)]">
                            只读
                          </span>
                        )}
                      </p>
                      {/*
                        * conv_id 要能一眼选中复制 —— 别的群接口全都要它，
                        * 而它是一串没人记得住的东西。
                        */}
                      <code className="t-caption2 mt-1 block break-all select-all text-[var(--ink-tertiary)]">
                        {g.convId}
                      </code>
                    </div>
                  ))}
                </div>
              )}
              {sendable.length === 0 && myGroups.length > 0 && (
                <p className="t-caption mt-2 px-1 leading-relaxed text-[var(--ink-tertiary)]">
                  上面这些你都能读（消息、公告）。要往群里发消息或改公告，
                  得请站长逐个群授权 —— 拿到之后这里会变成「可代发」。
                </p>
              )}
            </Section>
          </aside>

          {/* ── 主栏 ②：动手的和参考的 ──────────────── */}
          <div className="order-3 min-w-0 lg:col-start-1 lg:row-start-2">
            {/*
              * 这两块（发一条、在线测试）**不给 Section 标题**，它们自带 h3。
              *
              * 标题的粗细在这一页有含义：t-group-label 那种小号大写
              * 是「一组东西」的标签（日志、接口、做不到的），
              * 而 t-headline 是「一个能动手的工具」。两个都给的话，
              * 屏幕上会出现「发一条 / 在这里发一条」这种自己念自己的标题。
              */}
            {sendable.length > 0 && (
              <Section>
                <GroupComposer
                  groups={sendable}
                  maxChars={MAX_MESSAGE_CHARS - attributionCost(senderName)}
                  /* 服务端拼出来的那一行，原样给它 —— 前端不重拼 */
                  attributionLine={withAttribution("", senderName).trim()}
                />
              </Section>
            )}

            <Section>
              <ApiConsole endpoints={ENDPOINTS.map((e) => ({ ...e }))} />
            </Section>

            <Section title="代发日志">
              <div id="log" className="scroll-mt-16">
                {/* 一条都没发过的时候不给过滤条 —— 过滤一个空列表是纯噪音 */}
                {(log.total > 0 || conv || q || status !== "all") && (
                  <LogFilters groups={myGroups.map((g) => ({ value: g.convId, label: g.name }))} />
                )}
                <SendLog rows={log.rows} />
                <Pagination
                  slice={slice}
                  total={log.total}
                  noun="条代发"
                  basePath="/me/api"
                  params={{ conv, status: status === "all" ? undefined : status, q }}
                />
                <p className="t-caption mt-3 px-1 leading-relaxed text-[var(--ink-tertiary)]">
                  存的是拼好署名之后的整条，也就是群里真正看到的那一条 ——
                  所以这里也看得出署名有没有真的加上。失败的也记。
                </p>
              </div>
            </Section>

            {/*
              * ── 接口 ──────────────────────────────
              *
              * 分成「调得动的」和「还差权限的」两栏。
              *
              * 两栏都要有 —— 只列调得动的话，人根本不知道站里还有别的接口；
              * 混在一起的话，他会照着一条自己调不动的去写，
              * 然后对着 403 检查半天令牌。
              *
              * 每条都是一行可展开的目录（见 EndpointDoc），
              * 所以两栏加起来仍然一屏看得完。
              */}
            <Section title={`调得动的（${usable.length}）`}>
              <div id="docs" className="scroll-mt-16">
                {usable.length === 0 ? (
                  <p className="t-footnote px-1 leading-relaxed text-[var(--ink-tertiary)]">
                    还没有可用的令牌。上面建一把，勾上你要的权限。
                  </p>
                ) : (
                  <div className="inset-group">
                    {usable.map((e) => (
                      <EndpointDoc key={`${e.method} ${e.path}`} endpoint={e} />
                    ))}
                  </div>
                )}
                <p className="t-caption mt-3 px-1 leading-relaxed text-[var(--ink-tertiary)]">
                  带上令牌调 <code>/api/v1/docs</code>，拿到的是这一份的 JSON 版 ——
                  同一套算法，所以它不会和这一页说不同的话。
                </p>
              </div>
            </Section>

            {locked.length > 0 && (
              <Section title={`还差权限的（${locked.length}）`}>
                <div className="inset-group">
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
              <div className="inset-group">
                {NOT_POSSIBLE.map((n) => (
                  <div key={n.what} className="inset-row px-4 py-3">
                    <p className="t-subhead font-medium">{n.what}</p>
                    <p className="t-caption mt-0.5 leading-relaxed text-[var(--ink-secondary)]">
                      {n.why}
                    </p>
                  </div>
                ))}
              </div>
            </Section>

            {/*
              * 收尾这一段是安全属性，不是免责声明 ——
              * 所以写成两条具体的动作（别贴哪里、贴错了怎么办），
              * 而不是一段「请妥善保管」。
              */}
            <Callout
              title="令牌就是你"
              icon={<KeyRound className="h-4 w-4" strokeWidth={2.2} aria-hidden />}
            >
              <p className="t-footnote mt-1 leading-relaxed text-[var(--ink-secondary)]">
                它不会带来你本来没有的权限，但拿到它的人能以你的名义用掉你已有的权限。
                别贴进群里，别提交进仓库。贴错了就回来撤销，立刻生效。
              </p>
            </Callout>
          </div>
        </div>
      </div>

      <PageNote>
        这一页列出来的接口是按你手上令牌的权限算的，别人看到的和你不一样。
      </PageNote>
    </>
  );
}
