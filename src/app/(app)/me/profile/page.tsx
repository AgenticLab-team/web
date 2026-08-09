import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { BioEditor } from "@/components/members/BioEditor";
import { DirectoryToggle } from "@/components/members/DirectoryToggle";
import { SkillEditor } from "@/components/members/SkillEditor";
import { PageHeader } from "@/components/shell/PageHeader";
import { Section } from "@/components/ui/primitives";
import { getCurrentUser } from "@/lib/auth/session";
import { isDirectoryHidden, mySkills } from "@/lib/members/queries";

export const metadata: Metadata = { title: "个人资料" };
export const dynamic = "force-dynamic";

/**
 * 个人资料。
 *
 * 这一页的产出是**别人能不能找到你**。
 * 所以顺序是：先讲清楚谁看得到（隐身开关在最上面），
 * 再问你会什么 —— 反过来的话，人会一边填一边担心这些填给谁看。
 */
export default async function ProfilePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/me/profile");

  const skills = mySkills(user.id);
  const hidden = isDirectoryHidden(user.id);

  return (
    <>
      <Link
        href="/me"
        className="t-subhead -ml-1 mt-6 inline-flex items-center gap-0.5 text-[var(--accent)] transition active:opacity-60"
      >
        <ChevronLeft className="h-4 w-4" strokeWidth={2.2} aria-hidden />
        我的
      </Link>

      <PageHeader title="个人资料" subtitle="决定别人能不能找到你" />

      <Section title="可见性">
        <DirectoryToggle initial={hidden} />
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
