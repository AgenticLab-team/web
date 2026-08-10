import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { PrefsPanel } from "@/components/notifications/PrefsPanel";
import { PushManager } from "@/components/notifications/PushManager";
import { PageHeader } from "@/components/shell/PageHeader";
import { BackLink } from "@/components/ui/primitives";
import { getCurrentUser } from "@/lib/auth/session";
import { env } from "@/lib/env";
import { canUseEmail } from "@/lib/notifications/prefs";
import { hasActivePushSubscription } from "@/lib/notifications/push-store";
import { configProblem } from "@/lib/notifications/webpush";
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
  // 配错和没配都当「不可用」传给客户端 —— 公钥有问题时让浏览器订阅
  // 只会得到一个永远收不到东西的订阅，不如从一开始就如实说不可用
  const pushUsable = configProblem() === null;
  const showPush = pushUsable && hasActivePushSubscription(user.id);

  return (
    <>
      <BackLink href="/me">我的</BackLink>

      <PageHeader title="通知设置" subtitle="决定什么事值得打断你" />

      {/*
        设备推送排在最前面。

        它和下面那些开关不是一个层级：**下面每一类的「推送到设备」
        全都依赖这台设备先订阅过**。顺序反过来的话，人会先把一排
        「推送到设备」勾上，然后什么都收不到 —— 而界面上没有任何东西
        告诉他还差一步。

        先问「这台设备要不要收」，再问「收哪些」，是唯一不会让人
        白勾一遍的顺序。
      */}
      <PushManager vapidPublicKey={pushUsable ? env.webpush.publicKey : null} />

      <PrefsPanel initial={prefs} showPush={showPush} />

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
