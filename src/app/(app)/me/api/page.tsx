import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { ApiConsole } from "@/components/api/ApiConsole";
import { SendLog } from "@/components/api/SendLog";
import { TokenManager } from "@/components/api/TokenManager";
import { PageHeader } from "@/components/shell/PageHeader";
import { BackLink, PageNote, Section } from "@/components/ui/primitives";
import { NOT_POSSIBLE, ENDPOINTS } from "@/lib/api-tokens/catalog";
import { SCOPES, SEND_LIMIT } from "@/lib/api-tokens/rules";
import { grantedGroups, sendLog, tokensOf, usageOf } from "@/lib/api-tokens/store";
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
export default async function ApiPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/me/api");

  const tokens = tokensOf(user.id);
  // 只给他自己那一份 —— 「看别人的」没有任何合理场景，只会变成越权入口
  const log = sendLog({ userId: user.id, limit: 50 });
  /*
   * 每把令牌今天用掉了多少。
   *
   * 界面上要答得出「我还能发几条」—— 只写上限不写用量的话，
   * 撞限流的人第一反应是「是不是坏了」，而不是「我发太多了」。
   */
  const usage = Object.fromEntries(
    tokens.filter((t) => t.revokedAt === null).map((t) => [t.id, usageOf(t.id)]),
  );
  const visible = new Map(visibleGroupsFor(user).map((g) => [g.convId, g.name]));
  const sendable = grantedGroups(user.id)
    .filter((c) => visible.has(c))
    .map((c) => ({ convId: c, name: visible.get(c)! }));

  return (
    <>
      <BackLink href="/me">我的</BackLink>
      <PageHeader
        title="开放 API"
        subtitle="用令牌以你的身份读数据、往被授权的群发消息"
      />

      <TokenManager tokens={tokens} scopes={[...SCOPES]} usage={usage} limits={SEND_LIMIT} />

      <Section title="你能发到哪几个群">
        {sendable.length === 0 ? (
          <p className="t-caption px-1 leading-relaxed text-[var(--ink-tertiary)]">
            还没有。发消息要站长<strong>逐个群</strong>授权 —— 拿到授权之后这里会列出来，
            而且每条发出去的消息都会自动带一行「本消息由「你」使用 AgenticLab.sh 代发」。
          </p>
        ) : (
          <ul className="space-y-1.5">
            {sendable.map((g) => (
              <li key={g.convId} className="inset-group px-3.5 py-2.5">
                <p className="t-subhead font-medium">{g.name}</p>
                <code className="t-caption2 break-all text-[var(--ink-quaternary)]">
                  {g.convId}
                </code>
              </li>
            ))}
          </ul>
        )}
        <p className="t-caption2 mt-2 px-1 text-[var(--ink-quaternary)]">
          每把令牌最多 {SEND_LIMIT.perMinute} 条/分钟、{SEND_LIMIT.perHour} 条/小时、
          {SEND_LIMIT.perDay} 条/天（站长可以在授权上再调紧）。
          上游的额度是全站共用的，所以这里压得低 —— 剩下的要留给站长公告和系统告警。
        </p>
      </Section>

      <Section title="在线测试">
        <ApiConsole endpoints={ENDPOINTS.map((e) => ({ ...e }))} />
      </Section>

      <Section title="代发日志">
        <SendLog rows={log} />
        <p className="t-caption2 mt-2 px-1 text-[var(--ink-quaternary)]">
          存的是拼好署名之后的整条，也就是群里真正看到的那一条 ——
          所以这里也看得出署名有没有真的加上。失败的也记，
          否则「试了一百次都失败」在限流上等于没发生过。
        </p>
      </Section>

      <Section title="端点">
        <div className="space-y-2">
          {ENDPOINTS.map((e) => (
            <div key={`${e.method} ${e.path}`} className="inset-group px-3.5 py-3">
              <p className="t-subhead font-medium">
                <span className="t-caption2 mr-1.5 rounded-[var(--radius-control)] bg-[var(--fill)] px-1.5 py-0.5 text-[var(--ink-secondary)]">
                  {e.method}
                </span>
                <code className="break-all">{e.path}</code>
              </p>
              <p className="t-caption mt-1 text-[var(--ink-secondary)]">{e.summary}</p>
              {e.scopes.length > 0 && (
                <p className="t-caption2 mt-1 text-[var(--ink-quaternary)]">
                  需要：{e.scopes.join("、")}
                </p>
              )}
              {e.note && (
                <p className="t-caption2 mt-1 leading-relaxed text-[var(--ink-tertiary)]">
                  {e.note}
                </p>
              )}
              <pre className="t-caption2 mt-2 overflow-x-auto rounded-[var(--radius-control)] bg-[var(--surface-sunken)] p-2.5 text-[var(--ink-secondary)]">
                {e.example}
              </pre>
            </div>
          ))}
        </div>
        <p className="t-caption2 mt-2 px-1 text-[var(--ink-quaternary)]">
          带上令牌调 <code>/api/v1/docs</code>，拿到的是<strong>按你这把令牌算过</strong>的同一份清单。
        </p>
      </Section>

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
