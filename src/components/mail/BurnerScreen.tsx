"use client";

import { Check, Copy, Loader2, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";

import { Card, Empty, buttonClass } from "@/components/ui/primitives";
import { createBurner, discardBurner } from "@/lib/mail/burner-actions";
import type { BurnerMessageView, BurnerView } from "@/lib/mail/burner";

/**
 * 模式①：一次性箱 —— **重点是「等一封信」，不是「管理邮件」**。
 *
 * ═════════════════════════════════════════
 * 它不该长得像邮件客户端
 * ═════════════════════════════════════════
 *
 * 它该长得像一个**取件码屏幕**：页面上最大的两个东西是
 * **地址本身**和**验证码本身**，各带一个复制按钮。
 * 别的都是配角 —— 用户来这一页只做两件事：拿地址、等码。
 *
 * 三条从这个判断推出来的决定：
 *   · **没有「刷新」按钮**。他唯一想做的事就是等，那就让他等到
 *   · **收到之后不跳转**。他多半还要等第二封（改密码、二次验证）
 *   · 倒计时用 tabular-nums，否则数字跳动时整行会左右抖
 */

export interface BurnerScreenProps {
  boxes: BurnerView[];
  messages: Record<string, BurnerMessageView[]>;
  concurrentLimit: number;
  customMinLength: number;
  /** 能开一次性箱的域名，给「换一个域名」用 */
  domains: { domain: string; allowCustom: boolean }[];
}

export function BurnerScreen({
  boxes,
  messages,
  concurrentLimit,
  customMinLength,
  domains,
}: BurnerScreenProps) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [showCustom, setShowCustom] = useState(false);
  const [localPart, setLocalPart] = useState("");
  const [domain, setDomain] = useState("");

  const atLimit = boxes.length >= concurrentLimit;

  const open = useCallback(
    (custom: boolean) => {
      setError(null);
      startTransition(async () => {
        const result = await createBurner(
          custom ? { localPart, domain: domain || undefined } : {},
        );
        if (!result.ok) setError(result.error ?? "开不出来");
        else {
          setLocalPart("");
          setShowCustom(false);
        }
      });
    },
    [localPart, domain],
  );

  return (
    <div className="space-y-4">
      {boxes.length === 0 ? (
        <Empty
          title="还没有一次性邮箱"
          hint="开一个，24 小时后自动销毁 —— 拿去注册那些你不想给真邮箱的网站"
        />
      ) : (
        boxes.map((box) => (
          <BurnerCard key={box.id} box={box} messages={messages[box.id] ?? []} />
        ))
      )}

      {error && (
        <p className="t-caption" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      )}

      {atLimit ? (
        <p className="t-caption text-[var(--ink-tertiary)]">
          同时最多 {concurrentLimit} 个（网页和 API 共用这个额度）。
          扔掉一个再开，或者等它到期。
        </p>
      ) : showCustom ? (
        <Card>
          <div className="flex flex-wrap items-center gap-2">
            <input
              className="t-body min-w-0 flex-1 rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2 font-mono"
              placeholder={`至少 ${customMinLength} 个字符`}
              value={localPart}
              onChange={(e) => setLocalPart(e.target.value)}
              autoFocus
            />
            <span className="t-body text-[var(--ink-tertiary)]">@</span>
            <select
              className="t-body rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
            >
              <option value="">随机挑一个</option>
              {domains
                .filter((d) => d.allowCustom)
                .map((d) => (
                  <option key={d.domain} value={d.domain}>
                    {d.domain}
                  </option>
                ))}
            </select>
          </div>
          <p className="t-caption2 mt-2 text-[var(--ink-quaternary)]">
            自选前缀要 {customMinLength} 个字符以上 —— 更短的留给正式申领，
            否则好地址会被一次性箱反复占着。
          </p>
          <div className="mt-3 flex gap-2">
            <button
              className={buttonClass("primary")}
              onClick={() => open(true)}
              disabled={pending || localPart.trim().length < customMinLength}
            >
              {pending ? <Loader2 className="size-4 animate-spin" /> : null}
              开这个
            </button>
            <button className={buttonClass("quiet")} onClick={() => setShowCustom(false)}>
              取消
            </button>
          </div>
        </Card>
      ) : (
        <div className="flex flex-wrap gap-2">
          {/*
            * 随机是主按钮。
            *
            * 来这一页的人九成只想要「一个能收信的地址」——
            * 让他先想一个名字是多余的一步，而这一步会劝退一部分人。
            */}
          <button
            className={buttonClass("primary")}
            onClick={() => open(false)}
            disabled={pending}
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            开一个随机地址
          </button>
          <button className={buttonClass("quiet")} onClick={() => setShowCustom(true)}>
            自己起名字
          </button>
        </div>
      )}
    </div>
  );
}

function BurnerCard({ box, messages }: { box: BurnerView; messages: BurnerMessageView[] }) {
  const [pending, startTransition] = useTransition();

  return (
    <Card>
      {/* 地址是这一页最大的两样东西之一 */}
      <div className="flex items-start gap-2">
        <code className="t-title3 min-w-0 flex-1 break-all font-mono font-semibold">
          {box.displayAddress}
        </code>
        <CopyButton value={box.displayAddress} label="复制地址" />
        <button
          className="tap-target shrink-0 rounded-[var(--radius-chip)] p-1.5 text-[var(--ink-quaternary)] transition-colors hover:bg-[var(--fill)] hover:text-[var(--danger)]"
          title="扔掉这个地址"
          aria-label="扔掉这个地址"
          onClick={() =>
            startTransition(async () => {
              await discardBurner({ id: box.id });
            })
          }
          disabled={pending}
        >
          <Trash2 className="size-4" />
        </button>
      </div>

      <Countdown expiresAt={box.expiresAt} />

      <div className="mt-3 space-y-2">
        {messages.length === 0 ? (
          <p className="t-caption flex items-center gap-2 py-6 text-[var(--ink-tertiary)]">
            <Loader2 className="size-4 animate-spin" />
            正在等待邮件…
          </p>
        ) : (
          messages.map((m) => <MessageRow key={m.id} message={m} />)
        )}
      </div>
    </Card>
  );
}

/**
 * 验证码是这一页最大的两样东西之二。
 *
 * 抽到了就用 34px 那一档铺开显示、带复制；抽不到就老老实实显示主题 ——
 * **不猜**。抽错一个数字比不抽糟得多：用户会复制、粘贴、提交、被拒，
 * 然后怀疑是网站的问题再试一次，而很多网站试错三次就锁定。
 */
function MessageRow({ message }: { message: BurnerMessageView }) {
  return (
    <div className="rounded-[var(--radius-control)] bg-[var(--fill)] p-3">
      <p className="t-caption flex items-center gap-1.5 text-[var(--ink-secondary)]">
        <span className="min-w-0 truncate font-medium">
          {message.fromName ?? message.from ?? "（未知发件人）"}
        </span>
        <span className="tabular ml-auto shrink-0 text-[var(--ink-quaternary)]">
          <RelativeTime at={message.receivedAt} />
        </span>
      </p>

      {message.otpCode ? (
        <div className="mt-1.5 flex items-center gap-2">
          <code className="t-title1 tabular font-mono tracking-[0.2em]">{message.otpCode}</code>
          <CopyButton value={message.otpCode} label="复制验证码" />
        </div>
      ) : (
        <p className="t-footnote mt-1">{message.subject ?? "(无主题)"}</p>
      )}

      {message.otpCode && message.subject && (
        <p className="t-caption2 mt-1 truncate text-[var(--ink-quaternary)]">{message.subject}</p>
      )}
    </div>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  return (
    <button
      className="tap-target shrink-0 rounded-[var(--radius-chip)] p-1.5 text-[var(--ink-tertiary)] transition-colors hover:bg-[var(--fill)]"
      title={label}
      aria-label={label}
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? (
        <Check className="size-4" style={{ color: "var(--success)" }} />
      ) : (
        <Copy className="size-4" />
      )}
    </button>
  );
}

/**
 * 倒计时。
 *
 * `tabular` 是必须的：等宽数字之外的字体里，`1` 比 `8` 窄，
 * 于是每秒钟整行都会左右抖一下 —— 而这一行就在地址底下，
 * 抖起来会把注意力从地址上拽走。
 */
function Countdown({ expiresAt }: { expiresAt: number }) {
  const [left, setLeft] = useState(() => expiresAt - Date.now());

  useEffect(() => {
    const id = setInterval(() => setLeft(expiresAt - Date.now()), 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  if (left <= 0) {
    return (
      <p className="t-caption mt-1" style={{ color: "var(--warning)" }}>
        已到期，稍后会被清理
      </p>
    );
  }

  const total = Math.floor(left / 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const text = `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;

  return (
    <p className="t-caption tabular mt-1 text-[var(--ink-tertiary)]">{text} 后销毁</p>
  );
}

function RelativeTime({ at }: { at: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(id);
  }, []);

  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 60) return <>{s} 秒前</>;
  if (s < 3600) return <>{Math.floor(s / 60)} 分钟前</>;
  return <>{Math.floor(s / 3600)} 小时前</>;
}
