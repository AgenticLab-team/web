import { Eye, EyeOff } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { BioEditor } from "@/components/members/BioEditor";
import { SkillEditor } from "@/components/members/SkillEditor";
import { PageHeader } from "@/components/shell/PageHeader";
import { BackLink, Card, Section } from "@/components/ui/primitives";
import { getCurrentUser } from "@/lib/auth/session";
import { isDirectoryHidden, mySkills } from "@/lib/members/queries";

export const metadata: Metadata = { title: "个人资料" };
export const dynamic = "force-dynamic";

/**
 * 个人资料。
 *
 * 这一页的产出是**别人能不能找到你**。所以顺序是：
 * 先讲清楚谁看得到，再问你会什么 ——
 * 反过来的话，人会一边填一边担心这些填给谁看。
 *
 * ─────────────────────────────────────────
 * 「谁看得见我」的开关不在这一页
 * ─────────────────────────────────────────
 *
 * 隐身开关原来就摆在这儿，而榜单和检索那两个在隐私页 ——
 * 三个问的是同一件事，却分在两页。
 *
 * 分开的后果不是多点一次，是**有人设了其中一个就以为设完了**。
 * 所以现在这里只显示**当前状态**和一条去改的路，
 * 改的地方只有一个。
 */
export default async function ProfilePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/me/profile");

  const skills = mySkills(user.id);
  const hidden = isDirectoryHidden(user.id);

  return (
    <>
      <BackLink href="/me">我的</BackLink>

      <PageHeader title="个人资料" subtitle="决定别人能不能找到你" />

      <Section title="谁看得见我">
        <Card>
          <div className="flex items-start gap-2">
            {hidden ? (
              <EyeOff className="mt-0.5 h-4 w-4 shrink-0 text-[var(--warning)]" strokeWidth={2} aria-hidden />
            ) : (
              <Eye className="mt-0.5 h-4 w-4 shrink-0 text-[var(--ink-tertiary)]" strokeWidth={2} aria-hidden />
            )}
            <div className="min-w-0 flex-1">
              <p className="t-body leading-tight">
                {hidden ? "你现在不出现在成员目录里" : "你现在出现在成员目录里"}
              </p>
              <p className="t-caption mt-0.5 leading-relaxed text-[var(--ink-tertiary)]">
                {hidden
                  ? "别人仍然能通过你发的帖子点进你的主页 —— 藏的是「被列出来」，不是你发过的内容"
                  : "所有登录成员都看得到你的昵称、头像、简介和技能标签"}
              </p>
              <Link
                href="/me/privacy"
                className="t-caption2 mt-1.5 inline-block text-[var(--accent)] transition active:opacity-60"
              >
                去隐私设置改 —— 那儿还有榜单和检索两个开关 →
              </Link>
            </div>
          </div>
        </Card>
      </Section>

      <Section title="一句话简介">
        <BioEditor initial={user.bio ?? ""} />
      </Section>

      <Section title="技能标签">
        <SkillEditor initial={skills} />
        <p className="t-caption mt-3 px-1 leading-relaxed text-[var(--ink-tertiary)]">
          标签是<strong>自己填的</strong>，不从聊天记录里推断 ——
          在群里说过几次某个词，不代表愿意被当成那件事的对口人。
          填了标签才会出现在按技能的筛选里。
        </p>
      </Section>
    </>
  );
}
