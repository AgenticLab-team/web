import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { PrivacyToggle } from "@/components/me/PrivacyToggle";
import { PageHeader } from "@/components/shell/PageHeader";
import { BackLink, Group, PageNote, Row, Section } from "@/components/ui/primitives";
import { getCurrentUser } from "@/lib/auth/session";
import { privacyOf } from "@/lib/privacy/queries";
import { PRIVACY_SWITCHES, switchIsOn } from "@/lib/privacy/rules";

export const metadata: Metadata = { title: "隐私" };
export const dynamic = "force-dynamic";

/**
 * 隐私开关。
 *
 * ─────────────────────────────────────────
 * 这一页存在的理由
 * ─────────────────────────────────────────
 *
 * 这个站把 45,000 条群聊做成了全文可检索，还把发言量做成了
 * 对未登录访客公开的榜单。这两件事都让这里比微信有用得多，
 * 也都是微信里**不存在**的暴露 —— 群里说过的话，
 * 原本只有当时在场的人看得见，翻半年前的记录几乎不可能。
 *
 * `user_privacy` 这张表当初就是为了平衡这件事建的
 * （建表注释的原话：「群聊可检索这件事需要它来平衡」），
 * 而它在 schema 之外零读零写 —— 平衡从来没有存在过。
 *
 * ─────────────────────────────────────────
 * 每个开关都要说清楚它**不管**什么
 * ─────────────────────────────────────────
 *
 * 一个隐私开关最坏的形态不是没有，是让人以为它管得比实际多 ——
 * 那样他会照着一个不存在的保护去说话。所以关掉之后紧跟着一句
 * 「它不管什么」，而不是等出事之后再解释。
 */
export default async function PrivacyPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/me/privacy");

  const settings = privacyOf(user.id);

  return (
    <>
      <BackLink href="/me">我的</BackLink>

      <PageHeader title="隐私" subtitle="这里比微信多出来的那些暴露，你可以关掉" />

      {PRIVACY_SWITCHES.map((spec) => {
        const on = switchIsOn(spec.key, settings[spec.key]);

        return (
          <Section key={spec.key} title={spec.label}>
            <p className="t-caption mb-2 px-1 leading-relaxed text-[var(--ink-tertiary)]">
              {spec.exposure}
            </p>
            <PrivacyToggle
              switchKey={spec.key}
              on={on}
              label={spec.label}
              detail={spec.detail}
              limit={spec.limit}
            />
          </Section>
        );
      })}

      <Section title="搜索引擎">
        {/*
          「会不会被搜到」是这一页最常被问、而以前答不上来的一件事。

          它和上面那些开关不是一类：开关管的是**谁能看**，
          这里管的是**能不能被搜出来**。两者差别很实在 ——
          一个人的微信昵称如果和他的真名一起出现在搜索结果里，
          那是他加群时完全没有同意过的事。

          三条分开写，因为它们的性质不同：
          一条是承诺、一条是设计如此、一条是承诺的边界。
          只写前两条的话，这一段就成了一个做不到的保证。
        */}
        <Group>
          <Row>
            <p className="t-caption leading-relaxed text-[var(--ink-secondary)]">
              <span className="text-[var(--ink)]">榜单不会被搜索引擎收录。</span>
              未登录的人打开链接仍然看得到榜单，但用你的名字去搜是搜不到它的。
            </p>
          </Row>
          <Row>
            <p className="t-caption leading-relaxed text-[var(--ink-secondary)]">
              <span className="text-[var(--ink)]">群聊记录、成员目录、你的主页都不会被收录。</span>
              这些本来就要登录才看得到。
            </p>
          </Row>
          <Row>
            <p className="t-caption leading-relaxed text-[var(--ink-secondary)]">
              <span className="text-[var(--ink)]">论坛里公开的帖子会被收录。</span>
              那是「公开」这一档的本意；不想被搜到就发成「仅成员可见」。
              从群聊转过来的内容不在此列。
            </p>
          </Row>
        </Group>
        <p className="t-caption mt-2 px-1 leading-relaxed text-[var(--ink-tertiary)]">
          说明一句边界：拦住爬虫靠的是 robots.txt 和页面声明，
          守规矩的搜索引擎会照办，不守规矩的抓取程序不会。
        </p>
      </Section>

      <PageNote>
        改完立刻生效。你自己看到的东西不会变 —— 你永远看得到自己。
        想连成员目录也不出现，去
        <a href="/me/profile" className="text-[var(--accent)]">个人资料</a>
        里关「出现在成员目录里」。
      </PageNote>
    </>
  );
}
