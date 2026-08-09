"use client";

import { useRouter } from "next/navigation";
import { PRESETS } from "@/lib/moderation/duration-rules";
import { useState, useTransition } from "react";

import { useToast } from "@/components/ui/Toast";
import { grantTitle, revokeTitle } from "@/lib/titles/actions";
import {
  addUserNote,
  adjustPoints,
  grantRole,
  revokeRole,
  revokeUserSessions,
  setUserStatus,
} from "@/lib/admin/user-actions";

/**
 * 用户管理操作。
 *
 * 所有需要理由的操作，**理由框和按钮放在一起**，
 * 而不是点了按钮再弹框问理由 —— 后者会让人随手敲一个「.」应付过去。
 * 先看到要写理由，写的时候就会想清楚。
 */

interface Props {
  userId: string;
  status: string;
  canAdjustPoints: boolean;
  canSuspend: boolean;
  canGrantRole: boolean;
  canRevokeSessions: boolean;
  canNote: boolean;
  canGrantTitle: boolean;
  assignableRoles: { key: string; name: string }[];
  heldRoles: { id: string; key: string; name: string }[];
  grantableTitles: { key: string; name: string; icon: string | null; remaining: number | null }[];
  heldTitles: { userTitleId: string; name: string; icon: string | null }[];
}

export function UserActions(props: Props) {
  const [open, setOpen] = useState<string | null>(null);

  const panels = [
    props.canAdjustPoints && { key: "points", label: "调整积分" },
    props.canSuspend && { key: "status", label: "状态与封禁" },
    props.canGrantRole && { key: "role", label: "身份组" },
    props.canRevokeSessions && { key: "session", label: "下线设备" },
    props.canGrantTitle && { key: "title", label: "称号" },
    props.canNote && { key: "note", label: "写备注" },
  ].filter(Boolean) as { key: string; label: string }[];

  if (panels.length === 0) {
    return (
      <p className="t-caption px-1 text-[var(--ink-tertiary)]">
        你目前只有查看权限，没有可执行的操作
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {panels.map((panel) => (
          <button
            key={panel.key}
            type="button"
            onClick={() => setOpen(open === panel.key ? null : panel.key)}
            className={`t-footnote rounded-[var(--radius-pill)] px-3 py-1.5 font-medium transition-colors ${
              open === panel.key
                ? "bg-[var(--ink)] text-[var(--canvas)]"
                : "bg-[var(--fill)] text-[var(--ink-secondary)]"
            }`}
          >
            {panel.label}
          </button>
        ))}
      </div>

      {open === "points" && <PointsPanel userId={props.userId} />}
      {open === "status" && <StatusPanel userId={props.userId} status={props.status} />}
      {open === "role" && (
        <RolePanel
          userId={props.userId}
          assignable={props.assignableRoles}
          held={props.heldRoles}
        />
      )}
      {open === "session" && <SessionPanel userId={props.userId} />}
      {open === "title" && (
        <TitlePanel
          userId={props.userId}
          grantable={props.grantableTitles}
          held={props.heldTitles}
        />
      )}
      {open === "note" && <NotePanel userId={props.userId} />}
    </div>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="animate-rise space-y-2.5 rounded-[var(--radius-card)] bg-[var(--surface)] p-4 hairline">
      {children}
    </div>
  );
}

function ReasonInput({
  value,
  onChange,
  placeholder = "理由（必填，会记入审计日志）",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="t-subhead w-full rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2 outline-none placeholder:text-[var(--ink-quaternary)]"
    />
  );
}

function useAction() {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, success: string) => {
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) toast.show({ message: result.error ?? "操作失败", kind: "error" });
      else {
        toast.show({ message: success, kind: "success" });
        router.refresh();
      }
    });
  };

  return { pending, run };
}

function PointsPanel({ userId }: { userId: string }) {
  const { pending, run } = useAction();
  const [delta, setDelta] = useState(0);
  const [reason, setReason] = useState("");

  return (
    <Panel>
      <div className="flex gap-2">
        <input
          type="number"
          value={delta || ""}
          onChange={(e) => setDelta(Number(e.target.value))}
          placeholder="正数加分，负数扣分"
          className="tabular t-subhead w-40 rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2 outline-none"
        />
        <div className="flex-1">
          <ReasonInput value={reason} onChange={setReason} />
        </div>
      </div>
      <button
        type="button"
        disabled={pending || !delta || !reason.trim()}
        onClick={() => run(() => adjustPoints({ userId, delta, reason }), "积分已调整")}
        className="t-subhead w-full rounded-[var(--radius-control)] bg-[var(--accent)] px-4 py-2 font-medium text-[var(--accent-ink)] disabled:opacity-40"
      >
        确认调整
      </button>
      <p className="t-caption text-[var(--ink-tertiary)]">
        调整会写一条积分流水，原有记录不会被修改。
      </p>
    </Panel>
  );
}

function StatusPanel({ userId, status }: { userId: string; status: string }) {
  // 默认 7 天：默认值是一种表态，而多数处罚本来就不该是终身的
  const [duration, setDuration] = useState<number | null>(7 * 86_400);
  const { pending, run } = useAction();
  const [reason, setReason] = useState("");

  const options = [
    { value: "active" as const, label: "恢复正常", danger: false },
    { value: "suspended" as const, label: "暂停", danger: true },
    { value: "banned" as const, label: "封禁", danger: true },
  ].filter((o) => o.value !== status);

  return (
    <Panel>
      <ReasonInput value={reason} onChange={setReason} />

      {/*
        * 期限。
        *
        * duration_seconds 和 expires_at 两列一直是零引用 ——
        * 也就是说在这之前**每一次封禁都是永久的**，而被封的人
        * 看到的是一句没有期限的「账号被封禁」。一个不知道什么时候
        * 结束的处罚，和永久封禁在心理上是一回事：他不会等，他会走。
        *
        * 默认选 7 天而不是永久 —— 默认值是一种表态，
        * 而多数处罚本来就不该是终身的。
        */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="t-caption shrink-0 text-[var(--ink-tertiary)]">期限</span>
        {PRESETS.map((preset) => (
          <button
            key={preset.label}
            type="button"
            onClick={() => setDuration(preset.seconds)}
            className={`t-caption rounded-[var(--radius-pill)] px-2.5 py-1 font-medium transition ${
              duration === preset.seconds
                ? "bg-[var(--ink)] text-[var(--canvas)]"
                : "bg-[var(--fill)] text-[var(--ink-secondary)]"
            }`}
          >
            {preset.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            disabled={pending || !reason.trim()}
            onClick={() =>
              run(
                () =>
                  setUserStatus({
                    userId,
                    status: option.value,
                    reason,
                    // 「恢复正常」没有期限可言
                    durationSeconds: option.value === "active" ? null : duration,
                  }),
                "状态已更新",
              )
            }
            className={`t-subhead flex-1 rounded-[var(--radius-control)] px-4 py-2 font-medium disabled:opacity-40 ${
              option.danger
                ? "bg-[var(--danger)] text-white"
                : "bg-[var(--fill)] text-[var(--ink)]"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
      <p className="t-caption leading-relaxed text-[var(--ink-tertiary)]">
        封禁会立即下线该用户的全部设备，并通知本人。他可以在「处罚与申诉」里申诉。
        {duration === null
          ? "选了永久的话，只能由人手动解除。"
          : "到期会自动解除，并通知本人 —— 他在「处罚与申诉」里看得到还剩多久。"}
      </p>
    </Panel>
  );
}

function RolePanel({
  userId,
  assignable,
  held,
}: {
  userId: string;
  assignable: { key: string; name: string }[];
  held: { id: string; key: string; name: string }[];
}) {
  const { pending, run } = useAction();
  const [reason, setReason] = useState("");
  const [roleKey, setRoleKey] = useState(assignable[0]?.key ?? "");

  return (
    <Panel>
      {held.length > 0 && (
        <div className="space-y-1.5">
          <p className="t-caption text-[var(--ink-tertiary)]">当前身份组</p>
          {held.map((role) => (
            <div key={role.id} className="flex items-center gap-2">
              <span className="t-subhead flex-1">{role.name}</span>
              <button
                type="button"
                disabled={pending || !reason.trim()}
                onClick={() => run(() => revokeRole({ userRoleId: role.id, reason }), "已移除")}
                className="t-caption rounded-[var(--radius-pill)] bg-[var(--fill)] px-2.5 py-1 text-[var(--danger)] disabled:opacity-40"
              >
                移除
              </button>
            </div>
          ))}
        </div>
      )}

      <ReasonInput value={reason} onChange={setReason} />

      <div className="flex gap-2">
        <select
          value={roleKey}
          onChange={(e) => setRoleKey(e.target.value)}
          className="t-subhead flex-1 rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2 outline-none"
        >
          {assignable.map((role) => (
            <option key={role.key} value={role.key}>
              {role.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={pending || !roleKey || !reason.trim()}
          onClick={() => run(() => grantRole({ userId, roleKey, reason }), "已授予")}
          className="t-subhead rounded-[var(--radius-control)] bg-[var(--accent)] px-4 py-2 font-medium text-[var(--accent-ink)] disabled:opacity-40"
        >
          授予
        </button>
      </div>
    </Panel>
  );
}

function SessionPanel({ userId }: { userId: string }) {
  const { pending, run } = useAction();
  const [reason, setReason] = useState("");
  return (
    <Panel>
      <ReasonInput value={reason} onChange={setReason} />
      <button
        type="button"
        disabled={pending || !reason.trim()}
        onClick={() => run(() => revokeUserSessions({ userId, reason }), "已下线全部设备")}
        className="t-subhead w-full rounded-[var(--radius-control)] bg-[var(--danger)] px-4 py-2 font-medium text-white disabled:opacity-40"
      >
        下线全部设备
      </button>
      <p className="t-caption text-[var(--ink-tertiary)]">
        用户需要重新登录。Passkey 不受影响，仍然可以一步进来。
      </p>
    </Panel>
  );
}

function NotePanel({ userId }: { userId: string }) {
  const { pending, run } = useAction();
  const [content, setContent] = useState("");
  return (
    <Panel>
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={3}
        placeholder="给其他管理员看的备注，用户本人看不到"
        className="t-subhead w-full resize-none rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2 outline-none placeholder:text-[var(--ink-quaternary)]"
      />
      <button
        type="button"
        disabled={pending || !content.trim()}
        onClick={() => run(() => addUserNote({ userId, content }), "备注已保存")}
        className="t-subhead w-full rounded-[var(--radius-control)] bg-[var(--accent)] px-4 py-2 font-medium text-[var(--accent-ink)] disabled:opacity-40"
      >
        保存备注
      </button>
    </Panel>
  );
}

/**
 * 称号面板。
 *
 * 授予下拉里直接标出**剩余名额**。稀有称号发出去就收不回来
 * （收回比不发更伤人），所以剩几个必须在点之前就看见，
 * 而不是点完弹一句「名额已满」。
 */
function TitlePanel({
  userId,
  grantable,
  held,
}: {
  userId: string;
  grantable: { key: string; name: string; icon: string | null; remaining: number | null }[];
  held: { userTitleId: string; name: string; icon: string | null }[];
}) {
  const { pending, run } = useAction();
  const [titleKey, setTitleKey] = useState(grantable[0]?.key ?? "");
  const [reason, setReason] = useState("");

  return (
    <Panel>
      {held.length > 0 && (
        <div className="space-y-1.5">
          {held.map((t) => (
            <div key={t.userTitleId} className="flex items-center gap-2">
              <span className="t-subhead flex-1">
                {t.icon} {t.name}
              </span>
              <button
                type="button"
                disabled={pending || !reason.trim()}
                onClick={() =>
                  run(() => revokeTitle({ userTitleId: t.userTitleId, reason }), "已收回")
                }
                className="t-caption rounded-[var(--radius-control)] bg-[var(--fill)] px-2.5 py-1 text-[var(--ink-secondary)] disabled:opacity-40"
              >
                收回
              </button>
            </div>
          ))}
        </div>
      )}

      {grantable.length > 0 && (
        <div className="flex gap-2">
          <select
            value={titleKey}
            onChange={(e) => setTitleKey(e.target.value)}
            className="t-subhead flex-1 rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2 outline-none"
          >
            {grantable.map((t) => (
              <option key={t.key} value={t.key}>
                {t.icon} {t.name}
                {t.remaining !== null && `（剩 ${t.remaining} 个名额）`}
              </option>
            ))}
          </select>
        </div>
      )}

      <ReasonInput value={reason} onChange={setReason} placeholder="理由（必填，会通知本人）" />

      <button
        type="button"
        disabled={pending || !titleKey || !reason.trim()}
        onClick={() => run(() => grantTitle({ userId, titleKey, reason }), "已授予并通知本人")}
        className="t-subhead w-full rounded-[var(--radius-control)] bg-[var(--accent)] px-4 py-2 font-medium text-[var(--accent-ink)] disabled:opacity-40"
      >
        授予称号
      </button>
      <p className="t-caption text-[var(--ink-tertiary)]">
        授予会通知本人 —— 悄悄发一个称号等于没发，没人会主动去个人页翻有没有新东西。
      </p>
    </Panel>
  );
}
