import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AppealForm } from "@/components/forum/AppealForm";
import { relativeTime } from "@/components/forum/PostList";
import { PageHeader } from "@/components/shell/PageHeader";
import { BackLink, Empty, Group, PageNote } from "@/components/ui/primitives";
import { getCurrentUser } from "@/lib/auth/session";
import { myModerationRecord } from "@/lib/forum/appeals-queries";

export const metadata: Metadata = { title: "处罚与申诉" };
export const dynamic = "force-dynamic";

const ACTION_LABEL: Record<string, string> = {
  warn: "警告",
  hide: "内容被隐藏",
  delete: "内容被删除",
  restore: "内容已恢复",
  lock: "帖子被锁定",
  collapse: "回复被折叠",
  mute: "被禁言",
  suspend: "账号被暂停",
  ban: "账号被封禁",
};

const APPEAL_LABEL: Record<string, string> = {
  open: "申诉处理中",
  accepted: "申诉已采纳",
  rejected: "申诉未采纳",
};

export default async function MyModerationPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const records = myModerationRecord(user.id).filter(
    (r) => !["restore", "unlock", "unpin", "unfeature", "unban"].includes(r.action),
  );

  return (
    <>
      <BackLink href="/me">我的</BackLink>

      <PageHeader title="处罚与申诉" />

      {records.length === 0 ? (
        <Empty title="没有任何处罚记录" hint="保持下去" />
      ) : (
        <Group>
          {records.map((record) => (
            <div key={record.id} className="inset-row space-y-2 px-4 py-3.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="t-body">{ACTION_LABEL[record.action] ?? record.action}</span>
                {record.revertedAt && (
                  <span className="t-caption rounded-[var(--radius-pill)] bg-[var(--success)]/15 px-2 py-0.5 font-medium text-[var(--success)]">
                    已撤销
                  </span>
                )}
                {/*
                  * 还剩多久。
                  *
                  * 在这之前每一次封禁都是永久的（duration_seconds 和
                  * expires_at 两列零引用），被封的人看到的是一句没有期限的
                  * 「账号被封禁」—— 而一个不知道什么时候结束的处罚，
                  * 和永久封禁在心理上是一回事：他不会等，他会走。
                  *
                  * 「还有 3 天」比一个要自己去算的时间戳有用得多。
                  */}
                {!record.revertedAt && record.remaining && (
                    <span
                      className="t-caption rounded-[var(--radius-pill)] px-2 py-0.5 font-medium"
                      style={{
                        background:
                          record.expiresAt === null
                            ? "color-mix(in srgb, var(--danger) 14%, transparent)"
                            : "var(--fill)",
                        color:
                          record.expiresAt === null ? "var(--danger)" : "var(--ink-secondary)",
                      }}
                    >
                      {record.remaining}
                  </span>
                )}
                <span className="flex-1" />
                <span className="tabular t-caption text-[var(--ink-tertiary)]">
                  {relativeTime(record.createdAt)}
                </span>
              </div>

              <p className="t-footnote text-[var(--ink-secondary)]">理由：{record.reason}</p>

              {record.appeal ? (
                <div className="rounded-[var(--radius-control)] bg-[var(--fill)] p-3">
                  <p className="t-caption font-medium text-[var(--ink-secondary)]">
                    {APPEAL_LABEL[record.appeal.status]}
                  </p>
                  <p className="t-footnote mt-1 text-[var(--ink-tertiary)]">
                    你说：{record.appeal.content}
                  </p>
                  {record.appeal.response && (
                    <p className="t-footnote mt-1.5 text-[var(--ink-secondary)]">
                      答复：{record.appeal.response}
                    </p>
                  )}
                </div>
              ) : (
                !record.revertedAt && <AppealForm actionId={record.id} />
              )}
            </div>
          ))}
        </Group>
      )}

      <PageNote>
        每一条处罚都会写明理由，你也随时可以申诉。
        觉得判错了就说出来 —— 申诉会由另一位管理员处理。
      </PageNote>
    </>
  );
}
