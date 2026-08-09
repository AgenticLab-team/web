import type { Metadata } from "next";

import { SettingItem } from "@/components/admin/SettingRow";
import { relativeTime } from "@/components/forum/PostList";
import { PageHeader } from "@/components/shell/PageHeader";
import { Section } from "@/components/ui/primitives";
import { requireAdmin } from "@/lib/admin/guard";
import { listSettings, modifiedCount, settingHistoryOf } from "@/lib/admin/settings";
import { passkeyLockoutRisk } from "@/lib/auth/passkey-enforcement";
import { describeRisk } from "@/lib/auth/passkey-policy";

export const metadata: Metadata = { title: "系统设置" };
export const dynamic = "force-dynamic";

/**
 * 系统设置。
 *
 * 「代码里零魔法数字」这条规则的另一面是：**所有阈值都在这一页上**，
 * 而一页几十个数字里，真正被动过的只有三五个 —— 那三五个才是
 * 排查问题时该看的。所以被改过的项要标出来，最近的变更要摆在最前。
 *
 * 危险项（改错会静默影响所有人）2026-08 起也能直接改（站长指令：
 * 不强制复核）—— 危险性用常驻警告表达，不再用锁输入框表达。
 */
export default async function AdminSettingsPage() {
  await requireAdmin("system.settings");

  const categories = listSettings();
  const changed = modifiedCount();
  const history = settingHistoryOf(undefined, 8);

  const total = categories.reduce((n, c) => n + c.items.length, 0);
  const passkeyRisk = passkeyLockoutRisk();

  return (
    <>
      <PageHeader title="系统设置" subtitle={`${total} 项 · ${changed} 项被改过`} />

      {history.length > 0 && (
        <Section title="最近的变更">
          <div className="inset-group">
            {history.map((h) => (
              <div key={h.id} className="inset-row flex flex-wrap items-baseline gap-1.5 px-4 py-2.5">
                <span className="t-subhead">{h.label ?? h.key}</span>
                <span className="tabular t-caption text-[var(--ink-tertiary)]">
                  {h.oldValue ?? "—"} → {h.newValue ?? "—"}
                </span>
                <span className="t-caption ml-auto text-[var(--ink-quaternary)]">
                  {h.changedByName} · {relativeTime(h.createdAt)}
                </span>
                {h.reason && (
                  <p className="t-caption2 w-full text-[var(--ink-tertiary)]">{h.reason}</p>
                )}
              </div>
            ))}
          </div>
          <p className="t-caption mt-2 px-1 leading-relaxed text-[var(--ink-tertiary)]">
            每次改动都进变更历史，含改前改后的值和理由。
            <strong>回滚本身也是一次变更</strong>，同样进历史 ——
            历史里不能出现空洞，否则事后复盘会看到值凭空变了。
          </p>
        </Section>
      )}

      {categories.map((category) => (
        <Section key={category.category} title={category.label}>
          <div className="inset-group">
            {category.items.map((item) => (
              <SettingItem key={item.key} row={item} />
            ))}
          </div>

          {/*
            * 「管理员强制 Passkey」这一项要把后果摆出来。
            *
            * 一个安全开关最危险的时刻不是它没生效，
            * 而是它生效了但没人知道会有什么后果 ——
            * 等某个管理员某天登不进来再去查，那时他已经在门外了。
            */}
          {category.category === "auth" && (
            <div
              className={`mt-2 rounded-lg border px-3 py-2 ${
                passkeyRisk.active
                  ? "border-[#b91c1c]/40 bg-[#b91c1c]/8 text-[#b91c1c]"
                  : "border-[var(--hairline)] text-[var(--ink-tertiary)]"
              }`}
            >
              <p className="t-caption leading-relaxed">
                <strong>管理员强制 Passkey：</strong>
                {describeRisk(passkeyRisk)}
              </p>
            </div>
          )}
        </Section>
      ))}

      <p className="t-caption px-1 pb-4 leading-relaxed text-[var(--ink-tertiary)]">
        写入侧会校验类型与上下限 —— 读取侧遇到非法值虽然会退回代码默认值，
        但那会造成<strong>后台显示的和实际生效的不是一回事</strong>：
        把上限填成 6O（字母 O）会保存成功、页面显示 6O，而系统一直在用 60，
        没有任何地方报错。所以拒绝发生在保存的那一刻。
      </p>
    </>
  );
}
