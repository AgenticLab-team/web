import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { MessageRow } from "@/components/mail/BurnerScreen";
import { PageHeader } from "@/components/shell/PageHeader";
import { FloatingBack } from "@/components/ui/FloatingBack";
import { Card, Empty } from "@/components/ui/primitives";
import { getCurrentUser } from "@/lib/auth/session";
import { requireFeature } from "@/lib/flags/server";
import { listBurnerMessages } from "@/lib/mail/burner";
import { db } from "@/lib/db";
import { mailBoxes } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

/**
 * 长期地址（申领来的 / 自有域名上的）的收件页。
 *
 * ═════════════════════════════════════════
 * 这一页补的是「点进去才是信」
 * ═════════════════════════════════════════
 *
 * 长期地址这一栏的每行都带着未读数，而原来的 row 没有任何入口 ——
 * 于是「有 N 封未读」看得见，信却点不开，收到的邮件在整站都读不到。
 * 这里把它补上：从「长期地址」那张卡点地址进来，就能看到这个地址收的信。
 *
 * 复用了一次性箱的 `MessageRow`：邮件本身存在同一张 `mailMessages` 表里，
 * 按 `boxId` 取，与 box 是哪种无关。归属在校验这一层卡死：
 * `box.userId !== user.id` 直接 `notFound()`，而展开单封信时
 * `openMessage` 内部再按 `userId` 过滤一次 —— 双重保险。
 */
export const dynamic = "force-dynamic";

export default async function MailboxPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=/mail/box/${id}`);
  requireFeature("temp_mailbox", user);

  const box = db.select().from(mailBoxes).where(eq(mailBoxes.id, id)).get();
  if (!box || box.userId !== user.id) notFound();

  const messages = listBurnerMessages(box.id);
  const address = `${box.localPart}@${box.domain}`;

  return (
    <>
      <PageHeader title={address} subtitle="这个地址收到的邮件" />
      <FloatingBack href="/mail/burner">回到邮箱</FloatingBack>

      {/*
        * 空态要说清楚「这个地址还没收到过信」，而不是一句冰冷的
        * 「没有邮件」—— 后者会让人以为是出错了。
        */}
      <div className="mt-3">
        {messages.length === 0 ? (
          <Card>
            <Empty title="还没有邮件" hint="寄到这个地址的信会出现在这里" />
          </Card>
        ) : (
          <div className="space-y-2">
            {messages.map((m) => (
              <MessageRow key={m.id} message={m} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}
