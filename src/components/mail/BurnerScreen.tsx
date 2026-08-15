"use client";

import { Check, ChevronDown, Copy, Loader2, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";

import { Card, Empty, buttonClass } from "@/components/ui/primitives";
import { createBurner, discardBurner, openMessage } from "@/lib/mail/burner-actions";
import type { MailMessageDetail } from "@/lib/mail/message";
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
      {/*
        * ⚠️ 地址用 `t-body`，不再是 `t-title3`。
        *
        * 原来的注释写着「地址是这一页最大的两样东西之一」——
        * 那个判断在域名短的时候成立。而池子里有
        * `pneumonoultramicroscopicsilicovolcanoconiosis.icu` 这种，
        * 加上前缀之后 `t-title3 + break-all` 会占**四行**，
        * 把整屏顶满，而那串随机前缀根本没人会读。
        *
        * 真正要大的是**验证码**（下面那个 `t-title1`）：
        * 地址是拿去粘贴的，码是拿眼睛读的。
        */}
      <div className="flex items-start gap-2">
        <code className="t-body min-w-0 flex-1 break-all font-mono font-semibold">
          {box.displayAddress}
        </code>
        {/*
          * ⚠️ 这两个按钮之间是 `gap-4`（16px），不是别处的 `gap-2`。
          *
          * 它们各自只有 28px 见方，靠 `.tap-target` 的 `::after`
          * 把命中区撑到 44 —— 也就是每边往外吃 8px。
          * 隔 8px 摆的话，两个命中区在中间**撞在一起**，
          * 谁在上面谁赢，实测复制键的有效宽度只剩 36。
          *
          * 而这件事在 rect 上完全看不出来（两个按钮都规规矩矩 28×28），
          * 也没法靠看截图发现 —— 它是 mobile-audit 探出来的。
          */}
        <div className="flex shrink-0 items-start gap-4">
        <CopyButton value={box.displayAddress} label="复制地址" />
        {/*
          * ⚠️ 这个键原来是**图标 + `--ink-quaternary`**，而站长的反馈是
          * 「还没法删除」—— 按钮一直在，只是没人找得到它。
          *
          * quaternary 那一档量出来对比度 1.4:1（我拿工具扫过全站），
          * 一个灰到几乎看不见的垃圾桶图标，在一堆文字里等于不存在。
          * **一个动作永远不该用全站最淡的那一档。**
          *
          * 改成带字的按钮：图标能省地方，但省下的地方不值得
          * 让人找不到怎么扔掉一个地址。
          */}
        <button
          className="tap-target t-caption shrink-0 rounded-[var(--radius-chip)] px-1.5 text-[var(--ink-secondary)] transition-colors hover:bg-[var(--fill)] hover:text-[var(--danger)]"
          title="扔掉这个地址"
          onClick={() =>
            startTransition(async () => {
              await discardBurner({ id: box.id });
            })
          }
          disabled={pending}
        >
          <Trash2 className="mr-0.5 inline size-3.5 align-[-2px]" aria-hidden />
          扔掉
        </button>
        </div>
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
export function MessageRow({ message }: { message: BurnerMessageView }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<MailMessageDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, startLoad] = useTransition();

  /*
   * ─────────────────────────────────────────
   * 展开，而不是跳转到另一个页面
   * ─────────────────────────────────────────
   *
   * 这一页的用途是**等一封信**，而等的人多半还要等第二封
   * （改密码、二次验证）。跳走再回来的话，地址、倒计时、
   * 其它几封信全部要重新找一遍。
   *
   * 展开的代价是长页面，而这一页本来就只有一两封信。
   */
  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (detail || loading) return;
    startLoad(async () => {
      const r = await openMessage({ id: message.id });
      if (r.ok) setDetail(r.message);
      else setLoadError(r.error);
    });
  };

  return (
    <div className="rounded-[var(--radius-control)] bg-[var(--fill)]">
      {/*
        * 整条可点。
        *
        * 原来这里是个死的 `<div>` —— 收到信、看得见主题、**点不开**。
        * 而抽不出验证码的时候恰恰最需要看正文（`extractOtp` 宁可不抽
        * 也不猜），所以那正好是这个功能最尴尬的形状。
        *
        * 用 `<button>` 而不是给 div 加 onClick：键盘要能到，
        * 读屏要念得出「按钮，已展开」。
        */}
      <button
        type="button"
        className="tap-target w-full rounded-[var(--radius-control)] p-3 text-left"
        aria-expanded={open}
        onClick={toggle}
      >
        <p className="t-caption flex items-center gap-1.5 text-[var(--ink-secondary)]">
          <span className="min-w-0 truncate font-medium">
            {message.fromName ?? message.from ?? "（未知发件人）"}
          </span>
          {!message.readAt && !open && (
            <span
              className="size-1.5 shrink-0 rounded-full"
              style={{ background: "var(--accent)" }}
              aria-label="未读"
            />
          )}
          <span className="tabular ml-auto shrink-0 text-[var(--ink-quaternary)]">
            <RelativeTime at={message.receivedAt} />
          </span>
          <ChevronDown
            className={`size-3.5 shrink-0 text-[var(--ink-quaternary)] transition-transform ${open ? "rotate-180" : ""}`}
          />
        </p>

        {/*
          * 验证码仍然是最大的那一样，展开与否都不变。
          *
          * 抽到了就 34px 铺开、带复制；抽不到就老老实实显示主题 ——
          * **不猜**。抽错一个数字比不抽糟得多：用户会复制、粘贴、
          * 提交、被拒，然后怀疑是网站的问题再试一次，
          * 而很多网站试错三次就锁定。
          */}
        {message.otpCode ? (
          <span className="mt-1.5 flex items-center gap-2">
            <code className="t-title1 tabular font-mono tracking-[0.2em]">{message.otpCode}</code>
            <CopyButton value={message.otpCode} label="复制验证码" />
          </span>
        ) : (
          <p className="t-footnote mt-1">{message.subject ?? "(无主题)"}</p>
        )}

        {message.otpCode && message.subject && (
          <p className="t-caption2 mt-1 truncate text-[var(--ink-quaternary)]">{message.subject}</p>
        )}
      </button>

      {open && (
        <div className="border-t border-[var(--separator)] px-3 pb-3 pt-2">
          {loading && !detail && (
            <p className="t-caption flex items-center gap-2 py-2 text-[var(--ink-tertiary)]">
              <Loader2 className="size-3.5 animate-spin" />
              正在打开…
            </p>
          )}
          {loadError && (
            <p className="t-caption py-2" style={{ color: "var(--danger)" }}>
              {loadError}
            </p>
          )}
          {detail && <MessageBody detail={detail} />}
        </div>
      )}
    </div>
  );
}

/**
 * 信的正文。
 *
 * ─────────────────────────────────────────
 * 只渲染纯文本，而这不是偷懒
 * ─────────────────────────────────────────
 *
 * HTML 那一份**根本没落盘**（`ingest.ts` 里 `bodyHtmlPath` 恒为 null）。
 * 而那是个有意的选择：渲染陌生人发来的 HTML 要么塞进 iframe
 * 沙箱、要么过一遍消毒器，两条路都得为「一次性验证码」这个用途
 * 养一份长期要跟着 CVE 走的代码。
 *
 * 验证码邮件的纯文本部分几乎总是够用的 —— 而这一页的用途就是它。
 */
function MessageBody({ detail }: { detail: MailMessageDetail }) {
  return (
    <>
      <dl className="t-caption2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[var(--ink-quaternary)]">
        <dt>发件人</dt>
        <dd className="min-w-0 truncate font-mono">{detail.from ?? "（未知）"}</dd>
        <dt>收件地址</dt>
        <dd className="min-w-0 truncate font-mono">{detail.toAddress}</dd>
        {detail.subject && (
          <>
            <dt>主题</dt>
            <dd className="min-w-0">{detail.subject}</dd>
          </>
        )}
      </dl>

      {detail.bodyText ? (
        <pre className="t-footnote mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-chip)] bg-[var(--surface)] p-2.5 font-sans leading-relaxed">
          {detail.bodyText}
        </pre>
      ) : (
        <p className="t-caption mt-2 text-[var(--ink-tertiary)]">
          这封信没有纯文本正文 —— 多半整封都是 HTML，而 HTML 这一份不留存
        </p>
      )}

      {detail.attachments.length > 0 && (
        <div className="mt-2 space-y-0.5">
          {detail.attachments.map((a) => (
            <p key={a.id} className="t-caption2 text-[var(--ink-tertiary)]">
              <span className="font-mono">{a.filename}</span>
              <span className="ml-1.5">{fileSize(a.size)}</span>
              {/*
                * 存了就说存了，没存就说**为什么**没存。
                *
                * 只显示「未保存」的话，人会以为是出错了然后来问；
                * 而那几种原因里多数他自己能处理。
                */}
              {a.stored ? (
                /*
                  * 存了就给一条真的能下的链接。
                  *
                  * 只显示「已保存」而没有入口的话，那句话等于在
                  * **描述我们自己的内部状态** —— 而用户要的是那个文件。
                  */
                <a
                  className="ml-1.5"
                  style={{ color: "var(--accent)" }}
                  href={`/api/mail/attachments/${a.id}`}
                  download={a.filename}
                >
                  下载
                </a>
              ) : (
                <span className="ml-1.5">· {a.skipNote ?? "未保存"}</span>
              )}
            </p>
          ))}
        </div>
      )}
    </>
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
/*
 * ═════════════════════════════════════════
 * 渲染期读 `Date.now()` 会把整棵子树炸掉重建
 * ═════════════════════════════════════════
 *
 * 服务端渲染时算一次「还剩多久」，浏览器水合时**再算一次** ——
 * 中间隔着网络和解析，两个数必然不同。React 发现服务端给的文字
 * 和客户端算出来的对不上，就会把这一整棵子树丢掉重建。
 *
 * 报错原文：「Hydration failed because the server rendered text
 * didn't match the client. As a result this tree will be regenerated
 * on the client.」而页面看上去**一切正常** —— 它只在控制台里说一句。
 *
 * `suppressHydrationWarning` 是 React 专门给时间戳留的口子：
 * 保留服务端那一版文字、不重建，随后由下面的 interval 接管。
 *
 * 不在 effect 里立刻校准一次：那会同步 setState、触发一次级联渲染
 * （eslint 有规则专门拦它），而换来的只是**最多一秒**的新鲜度。
 * 服务端那一版本来就是刚刚算出来的。
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
    <p className="t-caption tabular mt-1 text-[var(--ink-tertiary)]" suppressHydrationWarning>
      {text} 后销毁
    </p>
  );
}

function RelativeTime({ at }: { at: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(id);
  }, []);

  const s = Math.max(0, Math.floor((now - at) / 1000));
  const text = s < 60 ? `${s} 秒前` : s < 3600 ? `${Math.floor(s / 60)} 分钟前` : `${Math.floor(s / 3600)} 小时前`;
  /*
   * 要一个真元素包着，`suppressHydrationWarning` 才有地方挂 ——
   * 它是元素上的属性，而原来这里返回的是个 Fragment。
   * 「X 秒前」每一秒都在变，服务端和客户端必然对不上。
   */
  return <span suppressHydrationWarning>{text}</span>;
}

/**
 * 文件大小。
 *
 * 超过 1024K 就换成 M —— `8789K` 是要人自己心算的写法，
 * 而这一行的用途是「这个附件大概多大」，不是精确计量。
 */
function fileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    const m = bytes / 1024 / 1024;
    // 10M 以上不给小数：`12.3M` 里那个 .3 不带任何判断价值
    return m >= 10 ? `${Math.round(m)}M` : `${m.toFixed(1)}M`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))}K`;
}
