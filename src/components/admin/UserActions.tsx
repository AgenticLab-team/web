"use client";

import { useRouter } from "next/navigation";
import { PRESETS } from "@/lib/moderation/duration-rules";
import { useState, useTransition } from "react";

import {
  AdminActions,
  AdminButton,
  AdminChip,
  AdminConfirm,
  AdminNote,
  AdminPanel,
  adminFieldClass,
  adminNumberFieldClass,
} from "@/components/admin/ui";
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
          <AdminChip
            key={panel.key}
            active={open === panel.key}
            aria-expanded={open === panel.key}
            onClick={() => setOpen(open === panel.key ? null : panel.key)}
          >
            {panel.label}
          </AdminChip>
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
  return <AdminPanel className="animate-rise space-y-2.5">{children}</AdminPanel>;
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
      className={adminFieldClass}
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
      {/* 手机上竖着排 —— 375px 里横着放「数字框 + 理由框」的结果是
          理由框只剩五个字的宽度，而理由是必填的 */}
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          type="number"
          value={delta || ""}
          onChange={(e) => setDelta(Number(e.target.value))}
          placeholder="正数加分，负数扣分"
          className={`sm:w-40 ${adminNumberFieldClass}`}
        />
        <div className="flex-1">
          <ReasonInput value={reason} onChange={setReason} />
        </div>
      </div>
      <AdminButton
        tone="primary"
        block
        disabled={pending || !delta || !reason.trim()}
        onClick={() => run(() => adjustPoints({ userId, delta, reason }), "积分已调整")}
      >
        {/* 按钮上写清楚是加还是扣：数字框里一个负号很容易看漏，
            而「扣 200 分」和「加 200 分」是不同的两件事 */}
        {delta ? `确认${delta > 0 ? "发放" : "扣除"} ${Math.abs(delta)} 分` : "确认调整"}
      </AdminButton>
      <AdminNote className="px-0">调整会写一条积分流水，原有记录不会被修改。</AdminNote>
    </Panel>
  );
}

function StatusPanel({ userId, status }: { userId: string; status: string }) {
  // 默认 7 天：默认值是一种表态，而多数处罚本来就不该是终身的
  const [duration, setDuration] = useState<number | null>(7 * 86_400);
  const { pending, run } = useAction();
  const [reason, setReason] = useState("");
  /*
   * 确认那一步。
   *
   * 封禁以前是**点一下就生效**的 —— 而它比这个后台里任何一个
   * 带二次确认的动作（关模块、批量删帖、冲正）影响都大：
   * 对方立刻被下线、收到通知、进处罚记录。
   *
   * 现在和它们走同一条路：先看到「会发生什么」，再点第二下。
   * 「恢复正常」不走这一步 —— 那是在**撤销**处罚，
   * 给撤销加摩擦只会让人懒得撤。
   */
  const [confirming, setConfirming] = useState<"suspended" | "banned" | null>(null);

  const options = [
    { value: "active" as const, label: "恢复正常", danger: false },
    { value: "suspended" as const, label: "暂停", danger: true },
    { value: "banned" as const, label: "封禁", danger: true },
  ].filter((o) => o.value !== status);

  const durationLabel =
    duration === null
      ? "永久，只能由人手动解除"
      : (PRESETS.find((p) => p.seconds === duration)?.label ?? `${duration / 86_400} 天`);

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
          <AdminChip
            key={preset.label}
            active={duration === preset.seconds}
            onClick={() => setDuration(preset.seconds)}
          >
            {preset.label}
          </AdminChip>
        ))}
      </div>

      {confirming ? (
        <AdminConfirm
          title={`确认${confirming === "banned" ? "封禁" : "暂停"}这个账号？`}
          confirmLabel={`确认${confirming === "banned" ? "封禁" : "暂停"}`}
          disabled={pending}
          onCancel={() => setConfirming(null)}
          onConfirm={() =>
            run(
              () =>
                setUserStatus({
                  userId,
                  status: confirming,
                  reason,
                  durationSeconds: duration,
                }),
              "状态已更新",
            )
          }
        >
          {/* 确认块里必须是**具体的后果**，不是「你确定吗」——
              一个没有内容的确认框，第二下和第一下点得一样快 */}
          <ul className="space-y-0.5">
            <li className="t-caption text-[var(--ink-secondary)]">· 期限：{durationLabel}</li>
            <li className="t-caption text-[var(--ink-secondary)]">
              · 立即下线他的全部设备，并给本人发通知
            </li>
            <li className="t-caption text-[var(--ink-secondary)]">
              · 进他的处罚记录，理由原样可见：「{reason.trim()}」
            </li>
          </ul>
        </AdminConfirm>
      ) : (
        <AdminActions>
          {options.map((option) => (
            <AdminButton
              key={option.value}
              tone={option.danger ? "danger" : "neutral"}
              className="flex-1"
              disabled={pending || !reason.trim()}
              title={reason.trim() ? undefined : "先写一句理由 —— 它会原样进他的处罚记录"}
              onClick={() =>
                option.danger
                  ? setConfirming(option.value as "suspended" | "banned")
                  : run(
                      // 「恢复正常」没有期限可言，也不需要再确认一次
                      () => setUserStatus({ userId, status: "active", reason, durationSeconds: null }),
                      "状态已更新",
                    )
              }
            >
              {option.label}
            </AdminButton>
          ))}
        </AdminActions>
      )}
      <AdminNote className="px-0">
        封禁会立即下线该用户的全部设备，并通知本人。他可以在「处罚与申诉」里申诉。
        {duration === null
          ? "选了永久的话，只能由人手动解除。"
          : "到期会自动解除，并通知本人 —— 他在「处罚与申诉」里看得到还剩多久。"}
      </AdminNote>
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
              {/* 收权限用 dangerSoft：它是破坏性的，但再授一次就回来了 ——
                  和封禁那种收不回来的事不该长得一样重 */}
              <AdminButton
                tone="dangerSoft"
                size="sm"
                disabled={pending || !reason.trim()}
                title={reason.trim() ? "移除这个身份组" : "先写一句理由"}
                onClick={() => run(() => revokeRole({ userRoleId: role.id, reason }), "已移除")}
              >
                移除
              </AdminButton>
            </div>
          ))}
        </div>
      )}

      <ReasonInput value={reason} onChange={setReason} />

      <div className="flex gap-2">
        <select
          value={roleKey}
          onChange={(e) => setRoleKey(e.target.value)}
          aria-label="要授予的身份组"
          className={`flex-1 ${adminFieldClass}`}
        >
          {assignable.map((role) => (
            <option key={role.key} value={role.key}>
              {role.name}
            </option>
          ))}
        </select>
        <AdminButton
          tone="primary"
          disabled={pending || !roleKey || !reason.trim()}
          onClick={() => run(() => grantRole({ userId, roleKey, reason }), "已授予")}
        >
          授予
        </AdminButton>
      </div>
    </Panel>
  );
}

function SessionPanel({ userId }: { userId: string }) {
  const { pending, run } = useAction();
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  return (
    <Panel>
      <ReasonInput value={reason} onChange={setReason} />
      {confirming ? (
        <AdminConfirm
          title="确认把他的全部设备下线？"
          confirmLabel="确认下线"
          disabled={pending}
          onCancel={() => setConfirming(false)}
          onConfirm={() => run(() => revokeUserSessions({ userId, reason }), "已下线全部设备")}
        >
          <p className="t-caption leading-relaxed text-[var(--ink-secondary)]">
            他手上每一台正在用的设备都会立刻退出登录，包括手机上那台 ——
            如果他此刻正在打字，那段草稿多半就没了。
          </p>
        </AdminConfirm>
      ) : (
        <AdminButton
          tone="danger"
          block
          disabled={pending || !reason.trim()}
          title={reason.trim() ? undefined : "先写一句理由"}
          onClick={() => setConfirming(true)}
        >
          下线全部设备
        </AdminButton>
      )}
      <AdminNote className="px-0">
        用户需要重新登录。Passkey 不受影响，仍然可以一步进来。
      </AdminNote>
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
        className={`resize-none ${adminFieldClass}`}
      />
      <AdminButton
        tone="primary"
        block
        disabled={pending || !content.trim()}
        onClick={() => run(() => addUserNote({ userId, content }), "备注已保存")}
      >
        保存备注
      </AdminButton>
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
              {/*
                * 收回称号原来是一个中性灰按钮 —— 它是这一页上唯一
                * 「在拿走东西却没有任何危险色」的动作。而收回称号
                * 比授予更伤人（下面那句注释里自己写着这句话）。
                * 归到 dangerSoft：有红色，但不是实心红。
                */}
              <AdminButton
                tone="dangerSoft"
                size="sm"
                disabled={pending || !reason.trim()}
                title={reason.trim() ? "收回这个称号" : "先写一句理由"}
                onClick={() =>
                  run(() => revokeTitle({ userTitleId: t.userTitleId, reason }), "已收回")
                }
              >
                收回
              </AdminButton>
            </div>
          ))}
        </div>
      )}

      {grantable.length > 0 && (
        <select
          value={titleKey}
          onChange={(e) => setTitleKey(e.target.value)}
          aria-label="要授予的称号"
          className={adminFieldClass}
        >
          {grantable.map((t) => (
            <option key={t.key} value={t.key}>
              {t.icon} {t.name}
              {t.remaining !== null && `（剩 ${t.remaining} 个名额）`}
            </option>
          ))}
        </select>
      )}

      <ReasonInput value={reason} onChange={setReason} placeholder="理由（必填，会通知本人）" />

      <AdminButton
        tone="primary"
        block
        disabled={pending || !titleKey || !reason.trim()}
        onClick={() => run(() => grantTitle({ userId, titleKey, reason }), "已授予并通知本人")}
      >
        授予称号
      </AdminButton>
      <AdminNote className="px-0">
        授予会通知本人 —— 悄悄发一个称号等于没发，没人会主动去个人页翻有没有新东西。
      </AdminNote>
    </Panel>
  );
}
