import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { DataExportPanel } from "@/components/me/DataExportPanel";
import { PageHeader } from "@/components/shell/PageHeader";
import { BackLink, Callout, Group, PageNote, Row, Section } from "@/components/ui/primitives";
import { csvTime } from "@/lib/activities/export-rules";
import { getCurrentUser } from "@/lib/auth/session";
import { exportPreview, myRecentExports } from "@/lib/export/self-export";
import { MAX_OWN_MESSAGES } from "@/lib/export/self-export-rules";

export const metadata: Metadata = { title: "导出我的数据" };
export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, string> = {
  started: "未完成",
  completed: "已完成",
  failed: "失败",
};

/**
 * 导出我的数据。
 *
 * 页面的顺序是刻意的：**先说这份东西里有别人的话，再给按钮。**
 * 反过来的话，绝大多数人会先点，下完才发现里面有别人的发言 ——
 * 那时候这份文件已经在他硬盘上了，说什么都晚了。
 */
export default async function ExportPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/me/export");

  const preview = exportPreview(user);
  const history = myRecentExports(user.id);

  return (
    <>
      <BackLink href="/me">我的</BackLink>

      <PageHeader title="导出我的数据" subtitle="聊天记录与论坛内容，打包成 zip" />

      <Callout tone="warning" title="这份文件里会有别人说的话">
        <p className="t-caption mt-1 leading-relaxed text-[var(--ink-secondary)]">
          群聊是很多人一起说的，只留你那几条谁也读不懂。所以导出会附上你每段发言
          前后的对话 —— 范围限定在<strong>你现在仍然在的群</strong>，别人的
          微信 ID 和昵称一律换成代号，但<strong>正文原样保留</strong>。
          这份东西怎么用，责任在你。
        </p>
      </Callout>

      <Section title="这次大概会导出">
        <Group>
          <Row>
            <span className="t-body min-w-0 flex-1">我发的群消息</span>
            <span className="tabular t-body text-[var(--ink-secondary)]">
              {preview.ownMessages.toLocaleString("zh-CN")} 条
            </span>
          </Row>
          <Row>
            <span className="t-body min-w-0 flex-1">当前可见的群</span>
            <span className="tabular t-body text-[var(--ink-secondary)]">
              {preview.visibleGroups} 个
            </span>
          </Row>
          <Row>
            <span className="t-body min-w-0 flex-1">我发的帖子</span>
            <span className="tabular t-body text-[var(--ink-secondary)]">{preview.posts} 篇</span>
          </Row>
          <Row>
            <span className="t-body min-w-0 flex-1">我发的回复</span>
            <span className="tabular t-body text-[var(--ink-secondary)]">
              {preview.replies} 条
            </span>
          </Row>
        </Group>
        {preview.ownMessages === 0 && preview.posts === 0 && preview.replies === 0 && (
          <p className="t-caption mt-2 px-1 leading-relaxed text-[var(--ink-tertiary)]">
            还没有可导出的内容。包里仍会有账号信息和说明文件。
          </p>
        )}
      </Section>

      <Section title="下载">
        <DataExportPanel willTruncate={preview.willTruncate} />
      </Section>

      {history.length > 0 && (
        <Section title="最近几次">
          <Group>
            {history.map((row) => (
              <Row key={row.id}>
                <span className="t-body min-w-0 flex-1">
                  {csvTime(row.startedAt)}
                  <span className="t-caption ml-2 text-[var(--ink-tertiary)]">
                    {row.withContext ? "含上下文" : "仅自己"}
                  </span>
                </span>
                <span className="tabular t-caption text-[var(--ink-secondary)]">
                  {row.status === "completed"
                    ? `${row.ownMessages.toLocaleString("zh-CN")} 条 · ${(row.bytes / 1024 / 1024).toFixed(1)} MB`
                    : (STATUS_LABEL[row.status] ?? row.status)}
                </span>
              </Row>
            ))}
          </Group>
        </Section>
      )}

      <PageNote>
        每半小时可以导一次，一天最多三次 —— 打包一份是重活，
        限流是为了别让它把站拖垮。单次最多
        {MAX_OWN_MESSAGES.toLocaleString("zh-CN")}
        条消息，超出时保留最近的那一批。每次导出都会记在这里，也会进站内的操作日志。
      </PageNote>
    </>
  );
}
