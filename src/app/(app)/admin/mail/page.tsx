import type { Metadata } from "next";
import Link from "next/link";

import { AdminNote, AdminRow, AdminTag } from "@/components/admin/ui";
import { DomainRow } from "@/components/admin/DomainRow";
import { MAIL_DOMAIN_KIND_LABEL } from "@/lib/mail/kinds";
import type { MailDomainKind, MailDomainTier } from "@/lib/mail/kinds";
import { relativeTime } from "@/components/forum/PostList";
import { PageHeader } from "@/components/shell/PageHeader";
import { Callout, Empty, PageNote, Section } from "@/components/ui/primitives";
import { requireAdmin } from "@/lib/admin/guard";
import {
  domainOwnerCandidates,
  domainSummary,
  listBanwords,
  listBoxes,
  listDomains,
  recentRejections,
} from "@/lib/mail/admin-queries";
import { expiryLabel, expiryTone } from "@/lib/mail/expiry-rules";
import { mailConfig } from "@/lib/mail/config";

export const metadata: Metadata = { title: "邮箱与域名池" };
export const dynamic = "force-dynamic";

/**
 * 邮箱后台。
 *
 * 顺序是按**「不看会出事」的程度**排的，不是按功能分组：
 *   ① 域名到期 —— 唯一无声的故障，过期了所有邮箱一起消失
 *   ② 没登记到期日的 —— 比①更危险，它们连告警都不会有
 *   ③ 有主但没认到人的 —— 那个人手里是一张空头支票
 *   ④ DNS 没配好的 —— 「他收不到信」十次有九次是这个
 * 剩下的才是日常查看的表。
 */
export default async function AdminMailPage() {
  const admin = await requireAdmin("mail.domain.read");
  const canWrite = admin.has("mail.domain.write");
  const canReadBoxes = admin.has("mail.box.read");
  const canBanword = admin.has("mail.banword");

  // 时钟在查询层读完传下来 —— 渲染期读 Date.now() 过不了 React Compiler
  const domains = listDomains();
  const summary = domainSummary(domains);
  // 指定域名主人时的下拉。整页一次查完 —— 一百行各查一次就是 N+1
  const candidates = domainOwnerCandidates();
  const config = mailConfig();

  const boxes = canReadBoxes ? listBoxes({ limit: 60 }) : [];
  const rejections = canReadBoxes ? recentRejections(30) : [];
  const banwords = canBanword ? listBanwords() : [];

  // 中文名收在 `lib/mail/kinds.ts` —— 这一页和域名编辑器引同一份，
  // 否则同一页上同一个类型会出现两个叫法
  const kindLabel: Record<string, string> = MAIL_DOMAIN_KIND_LABEL;

  return (
    <>
      <PageHeader
        title="邮箱与域名池"
        subtitle={`${summary.total} 个域名 · ${Object.entries(summary.byKind)
          .map(([k, n]) => `${kindLabel[k] ?? k} ${n}`)
          .join(" · ")}`}
      />

      {summary.expiringSoon.length > 0 && (
        <Callout tone="danger" title={`${summary.expiringSoon.length} 个域名快到期了`}>
          <p className="t-caption mt-1 leading-relaxed text-[var(--ink-secondary)]">
            {summary.expiringSoon
              .slice(0, 6)
              .map((d) => `${d.domain}（${expiryLabel(d.expiryDays)}）`)
              .join("、")}
            {summary.expiringSoon.length > 6 && ` 等 ${summary.expiringSoon.length} 个`}。
            <strong>域名过期是这套东西里唯一无声的故障</strong> ——
            挂在它上面的所有邮箱会同时消失，而表现只是「邮件不再来了」。
          </p>
        </Callout>
      )}

      {summary.noExpiry > 0 && (
        <Callout tone="warning" title={`${summary.noExpiry} 个域名没登记到期日`}>
          <p className="t-caption mt-1 leading-relaxed text-[var(--ink-secondary)]">
            它们<strong>不会触发任何到期告警</strong> —— 也就是说这一批比快到期的那些更危险，
            会在完全没有预警的情况下过期。到注册商那里对一遍日期补上。
          </p>
        </Callout>
      )}

      {summary.unclaimedOwned > 0 && (
        <Callout tone="warning" title={`${summary.unclaimedOwned} 个有主域名还没认到人`}>
          <p className="t-caption mt-1 leading-relaxed text-[var(--ink-secondary)]">
            归属是启动时从活动申请里认的，认不到多半是那个人还没绑定账号。
            在他绑定之前，这个域名收到的信没有人看得到。
          </p>
        </Callout>
      )}

      {summary.dnsProblems > 0 && (
        <Callout tone="warning" title={`${summary.dnsProblems} 个域名的 DNS 没配齐`}>
          <p className="t-caption mt-1 leading-relaxed text-[var(--ink-secondary)]">
            MX 要指向 <code className="font-mono">{config.mxHost}</code>；
            SPF 写 <code className="font-mono">v=spf1 -all</code>（这些域名不发信，就要明说，
            否则任何人都能拿它伪造发件人）；
            DMARC 写{" "}
            <code className="font-mono">
              v=DMARC1; p=reject;{config.dmarcRua ? ` rua=mailto:${config.dmarcRua}` : ""}
            </code>
            。
            {/*
              * rua 没配就不显示它。
              *
              * 显示一个收不到报告的地址比不显示更糟：跨域报告要求收件那一侧
              * 发布授权记录，而且那个信箱得真的能收信 —— 两条缺一，
              * 报告就静默地不来，而 DNS 上明明写着它。
              */}
            {!config.dmarcRua && (
              <> 没配报告地址就先不写 <code className="font-mono">rua</code> —— 见 ops/mail-gateway/DNS.md。</>
            )}
          </p>
        </Callout>
      )}

      <Section title="域名池">
        <div className="inset-group">
          {domains.map((d) => {
            const tone = expiryTone(d.expiryDays);
            return (
              /*
                * 一行一个域名，**点开就能改**。
                *
                * 这一页原来整个是只读的：`updateDomain` 那一串字段
                * （归谁用、谁是主人、四个开关）后端全写好了，
                * 而界面上一个都碰不到 —— 想改一个域名的用途只能进库。
                */
              <DomainRow
                key={d.domain}
                domain={{
                  domain: d.domain,
                  kind: d.kind as MailDomainKind,
                  tier: (d.tier ?? null) as MailDomainTier | null,
                  ownerUserId: d.ownerUserId,
                  ownerName: d.ownerName,
                  allowBurner: d.allowBurner,
                  allowClaim: d.allowClaim,
                  allowCustomLocal: d.allowCustomLocal,
                  inRandomRotation: d.inRandomRotation,
                  catchAll: d.catchAll,
                  enabled: d.enabled,
                  note: d.note,
                  boxCount: d.boxCount,
                }}
                candidates={candidates}
                summary={
                  <span className="flex items-center gap-2">
                <span className="min-w-0 flex-1">
                  <span className={`t-body block truncate ${d.enabled ? "" : "opacity-45"}`}>
                    {d.domain}
                    {/* 中文域名把 A 标签也显示出来 —— 排查收信问题时要的就是它 */}
                    {d.punycode !== d.domain && (
                      <code className="t-caption2 ml-1.5 font-mono text-[var(--ink-quaternary)]">
                        {d.punycode}
                      </code>
                    )}
                  </span>
                  <span className="t-caption2 mt-0.5 block text-[var(--ink-quaternary)]">
                    {kindLabel[d.kind] ?? d.kind}
                    {d.tier && ` · ${d.tier.toUpperCase()} 档`}
                    {d.ownerName && ` · ${d.ownerName}`}
                    {d.boxCount > 0 && ` · ${d.boxCount} 个地址`}
                    {d.recentReceived > 0 && ` · 近 7 天 ${d.recentReceived} 封`}
                  </span>
                </span>

                {/* DNS 三灯。只对真的要收信的域名亮 —— 封禁的连 MX 都不该配 */}
                {d.kind !== "blocked" && (
                  <span className="t-caption2 shrink-0 font-mono text-[var(--ink-quaternary)]">
                    {[
                      ["MX", d.mxOk],
                      ["SPF", d.spfOk],
                      ["DMARC", d.dmarcOk],
                    ].map(([label, ok]) => (
                      <span
                        key={String(label)}
                        className="ml-1.5"
                        style={{
                          color:
                            ok === true
                              ? "var(--success)"
                              : ok === false
                                ? "var(--danger)"
                                : "var(--ink-quaternary)",
                        }}
                        title={ok === null ? "还没体检过" : ok ? "正常" : "不对"}
                      >
                        {String(label)}
                      </span>
                    ))}
                  </span>
                )}

                <span
                  className="tabular t-caption shrink-0"
                  style={{
                    color:
                      tone === "danger"
                        ? "var(--danger)"
                        : tone === "warning"
                          ? "var(--warning)"
                          : "var(--ink-tertiary)",
                  }}
                >
                  {expiryLabel(d.expiryDays)}
                </span>
              </span>
                }
              />
            );
          })}
        </div>
        <AdminNote>
          归属那一列是启动时从活动申请里认出来的（<code className="font-mono">normalized_key</code>{" "}
          对应回申请人），认过一次之后这里改的结果不会被下次启动覆盖。
          {" "}
          <a href="/api/admin/mail/export" className="underline">
            导出 CSV
          </a>
          —— 带归属、到期和 DNS 三项，能回答「这个域名是谁的」。
          {!canWrite && " 你现在只有只读权限。"}
        </AdminNote>
      </Section>

      {canReadBoxes && (
        <Section title="地址">
          {boxes.length === 0 ? (
            <Empty title="还没有人开过邮箱" hint="一次性箱在 /mail/burner，域名主人的别名在 /mail/domains" />
          ) : (
            <div className="inset-group">
              {boxes.map((b) => (
                <AdminRow key={b.id}>
                  <span className="min-w-0 flex-1">
                    <code className="t-footnote block truncate font-mono">{b.displayAddress}</code>
                    <span className="t-caption2 mt-0.5 block text-[var(--ink-quaternary)]">
                      <Link href={`/admin/users/${b.ownerUserId}`}>{b.ownerName}</Link>
                      {` · ${b.kind}`}
                      {b.status !== "active" && ` · ${b.status}`}
                      {b.messageCount > 0 && ` · ${b.messageCount} 封`}
                    </span>
                  </span>
                  <span className="tabular t-caption shrink-0 text-[var(--ink-quaternary)]">
                    {b.expiresAt ? relativeTime(b.expiresAt) + "到期" : "不过期"}
                  </span>
                </AdminRow>
              ))}
            </div>
          )}
          <AdminNote>
            这里<strong>只有元数据</strong> —— 主题和正文要单独的 `mail.content.read` 权限，
            而它默认不给任何人。理由：这些邮箱会拿去收验证码和找回密码的链接，
            一个能静默读正文的后台等于一把能登录所有人第三方账号的万能钥匙。
          </AdminNote>
        </Section>
      )}

      {canReadBoxes && rejections.length > 0 && (
        <Section title="被拒的投递">
          <div className="inset-group">
            {rejections.map((r) => (
              <AdminRow key={r.id}>
                <span className="min-w-0 flex-1">
                  <code className="t-caption block truncate font-mono">{r.envelopeTo}</code>
                  <span className="t-caption2 mt-0.5 block text-[var(--ink-quaternary)]">
                    来自 {r.envelopeFrom ?? "（未知）"} · {r.reason}
                  </span>
                </span>
                <AdminTag>{r.verdict}</AdminTag>
                <span className="tabular t-caption shrink-0 text-[var(--ink-quaternary)]">
                  {relativeTime(r.createdAt)}
                </span>
              </AdminRow>
            ))}
          </div>
          <AdminNote>
            「我朋友说发了，我怎么没收到」——
            这张表是唯一能回答这句话的地方，所以拒掉的投递也要留痕。
          </AdminNote>
        </Section>
      )}

      {canBanword && (
        <Section title="前缀禁用词">
          <div className="inset-group">
            {banwords.map((w) => (
              <AdminRow key={w.id}>
                <code className="t-footnote min-w-0 flex-1 truncate font-mono">{w.word}</code>
                <AdminTag>{w.kind}</AdminTag>
                <span className="t-caption2 shrink-0 text-[var(--ink-quaternary)]">
                  {w.builtin ? "系统保留" : (w.reason ?? "")}
                </span>
              </AdminRow>
            ))}
          </div>
          <AdminNote>
            <code className="font-mono">postmaster</code> 和{" "}
            <code className="font-mono">abuse</code> 标着「系统保留」，删不掉 ——
            RFC 要求域名能收这两个地址，而它们是收「你们家域名在发垃圾邮件」这类投诉的唯一通道。
            发给用户的话，我们会在完全不知情的情况下被投诉、被拉黑。
          </AdminNote>
        </Section>
      )}

      <PageNote>
        设计与取舍见仓库里的 <code className="font-mono">MAIL.md</code>。
        收信走自建 SMTP 网关（源站 IP 不外泄），发信默认关死 ——
        这些域名共用一套信誉，一个人群发一次会连累另外九十九个。
      </PageNote>
    </>
  );
}
