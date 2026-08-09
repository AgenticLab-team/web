import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { PrefsPanel } from "@/components/notifications/PrefsPanel";
import { PageHeader } from "@/components/shell/PageHeader";
import { getCurrentUser } from "@/lib/auth/session";
import { canUseEmail } from "@/lib/notifications/prefs";
import { getPrefs } from "@/lib/notifications/store";

export const metadata: Metadata = { title: "通知设置" };
export const dynamic = "force-dynamic";

/**
 * 通知设置。
 *
 * 存在的理由很直接：不给用户关掉某一类的办法，他会关掉全部 ——
 * 而在这个站上，「关掉全部」的具体做法是不再打开它。
 */
export default async function NotificationPrefsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/me/notifications");

  const prefs = getPrefs(user.id);

  return (
    <>
      <Link
        href="/me"
        className="t-subhead -ml-1 mt-6 inline-flex items-center gap-0.5 text-[var(--accent)] transition active:opacity-60"
      >
        <ChevronLeft className="h-4 w-4" strokeWidth={2.2} aria-hidden />
        我的
      </Link>

      <PageHeader title="通知设置" subtitle="决定什么事值得打断你" />

      <PrefsPanel initial={prefs} />

      {/* 邮件通道还没接。在接上之前不给开关 —— 一个打开了但什么都不会
          发生的开关，比没有这个开关更糟：用户会以为自己订阅了，然后错过一切 */}
      {!canUseEmail() && (
        <p className="t-caption mt-6 px-1 leading-relaxed text-[var(--ink-quaternary)]">
          目前只有站内通知。邮件通道还没接上，所以这里不放邮件开关 ——
          一个打开了却什么都不会发生的开关，比没有它更糟。
        </p>
      )}
    </>
  );
}
