import { Laptop, ShieldAlert, Terminal } from "lucide-react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { DeviceLinkPanel } from "@/components/tui/DeviceLinkPanel";
import { PageHeader } from "@/components/shell/PageHeader";
import { BackLink, Callout, Group, Row, buttonClass } from "@/components/ui/primitives";
import { getRealUser } from "@/lib/auth/session";
import { explainBadCode, formatUserCode, normalizeUserCode } from "@/lib/tui/device-rules";
import { lookupByUserCode } from "@/lib/tui/device";

export const metadata: Metadata = { title: "确认终端登录" };
export const dynamic = "force-dynamic";

/**
 * 设备码流程的浏览器那一半。
 *
 * ═════════════════════════════════════════
 * 这一页的内容是安全设计，不是文案
 * ═════════════════════════════════════════
 *
 * 设备码流程挡不住「攻击者把自己屏幕上的码念给你听」这一类社工 ——
 * 这是它的固有弱点，没有协议层的解法（见 `lib/tui/device-rules.ts` 顶上）。
 *
 * 唯一的缓解手段就是这一页上显示的东西。所以每一块的取舍如下：
 *
 * ① **先说「如果你现在没在终端里登录，关掉这一页」**，而不是先展示设备名。
 *    先展示设备名的话，人的第一个动作是「核对一下这是不是我的机器」——
 *    而攻击者可以把设备名填成任何东西。真正的判据是
 *    「我此刻有没有在做这件事」，那个攻击者伪造不了。
 *
 * ② **发起 IP 单独一行**。设备名、系统、终端类型全都是客户端自报的，
 *    只有 IP 不是。它是这一页上唯一一件攻击者控制不了的事实。
 *
 * ③ **SSH 来源要单独说明**：令牌会存在网关那台机器上。
 *    这是它和本地二进制唯一的实质差别，不说的话人会以为两者一样。
 */
export default async function LinkPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const user = await getRealUser();
  /*
   * 没登录就跳登录页。**绝不建号、绝不发会话** ——
   * 和 GitHub 回调那条同源（`docs/OAUTH-PROVIDER.md` 第二节第①条）。
   *
   * 带上 next 回来的时候把码也带回来，否则人登录完要重新输一遍，
   * 而那串码可能已经从终端屏幕上滚走了。
   */
  const params = await searchParams;
  const raw = params.code?.trim() ?? "";

  if (!user) {
    const next = raw ? `/link?code=${encodeURIComponent(raw)}` : "/link";
    redirect(`/login?next=${encodeURIComponent(next)}`);
  }

  const code = normalizeUserCode(raw);

  if (!raw) return <CodeForm />;
  if (!code) return <CodeForm hint={explainBadCode(raw) ?? "这串码看起来不对"} value={raw} />;

  const found = lookupByUserCode(code);
  if (!found.ok) {
    const hint =
      found.reason === "expired"
        ? "这串码过期了。回终端里按一下重新生成 —— 它只活 10 分钟"
        : found.reason === "used"
          ? "这串码已经处理过了。如果那台终端还在等，让它重新要一串"
          : "没有这串码。核对一下终端上显示的那几位";
    return <CodeForm hint={hint} value={formatUserCode(code)} />;
  }

  const { device } = found;
  const isSsh = device.source === "ssh";

  return (
    <>
      <BackLink href="/me">我的</BackLink>

      <PageHeader title="确认终端登录" subtitle="有一台设备想以你的身份使用这个站" />

      <Callout
        tone="warning"
        icon={<ShieldAlert size={18} aria-hidden />}
        title="如果你现在没有在终端里登录，关掉这一页"
      >
        <p className="t-caption mt-1" style={{ color: "var(--ink-secondary)" }}>
          下面那些设备信息是那台机器自己报上来的，也就是说它们可以被填成任何样子。
          唯一靠得住的判据是：这件事是不是你此刻正在做的。
        </p>
      </Callout>

      <Group className="mb-5">
        <Row>
          <span className="shrink-0" style={{ color: "var(--ink-tertiary)" }}>
            {isSsh ? <Terminal size={18} aria-hidden /> : <Laptop size={18} aria-hidden />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="t-body block truncate font-medium">{device.deviceLabel}</span>
            <span className="t-caption block" style={{ color: "var(--ink-secondary)" }}>
              {isSsh ? "通过 SSH 网关" : "本地终端客户端"}
            </span>
          </span>
        </Row>
        <Row>
          <span className="t-subhead" style={{ color: "var(--ink-secondary)" }}>
            发起地址
          </span>
          <span className="t-subhead ml-auto tabular-nums">{device.requestIp ?? "未知"}</span>
        </Row>
        <Row>
          <span className="t-subhead" style={{ color: "var(--ink-secondary)" }}>
            验证码
          </span>
          <span className="t-subhead ml-auto font-mono tracking-widest">
            {formatUserCode(code)}
          </span>
        </Row>
      </Group>

      {isSsh && (
        <Callout tone="warning" title="这是 SSH 网关，令牌会存在那台机器上">
          <p className="t-caption mt-1" style={{ color: "var(--ink-secondary)" }}>
            本地客户端的令牌只在你自己的电脑上；SSH 网关必须替你调接口，
            所以它握着一份。它绑在你这次连接用的公钥上、7 天到期，
            在「我的 → 开放 API」里可以随时一键撤掉。
          </p>
        </Callout>
      )}

      <DeviceLinkPanel code={formatUserCode(code)} asked={device.scopes} isSsh={isSsh} />

      <p className="t-caption mt-6 px-1" style={{ color: "var(--ink-tertiary)" }}>
        这不是「用某个应用登录本站」—— 它是把你在这个站的身份借给一台设备。
        同意和拒绝都会记进审计日志。
      </p>
    </>
  );
}

/**
 * 还没有码，或者码不对。
 *
 * 用原生 `method="get"` 的表单：这一页在**微信内置浏览器**里被打开的
 * 概率很高，而那里最稳的就是一次普通的 GET 跳转 —— 不依赖任何 JS，
 * 也不会因为一次白屏让人卡在「输了码没反应」。
 */
function CodeForm({ hint, value }: { hint?: string; value?: string }) {
  return (
    <>
      <BackLink href="/me">我的</BackLink>

      <PageHeader title="确认终端登录" subtitle="输入终端上显示的那串码" />

      {hint && (
        <Callout tone="warning" title={hint}>
          <p className="t-caption mt-1" style={{ color: "var(--ink-secondary)" }}>
            码在终端窗口里，形如 WXYZ-7Q2M。它 10 分钟就过期。
          </p>
        </Callout>
      )}

      <form method="get" className="flex flex-col gap-3">
        <label className="t-group-label px-1" htmlFor="device-code">
          验证码
        </label>
        <input
          id="device-code"
          name="code"
          defaultValue={value}
          autoFocus
          autoComplete="off"
          /*
           * `autoCapitalize` 和 `autoCorrect` 都要关掉。
           *
           * 手机输入法默认会首字母大写、还会自作主张纠正 ——
           * 而这串码全大写、且是随机字符，纠正过之后必然对不上。
           * 人看到的是「码不对」，而他敲的每一个键都是对的。
           */
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          placeholder="WXYZ-7Q2M"
          className="w-full rounded-[var(--radius-control)] bg-[var(--fill)] px-4 py-3 font-mono text-lg tracking-widest"
        />
        <button type="submit" className={buttonClass("primary", "md")}>
          继续
        </button>
      </form>

      <p className="t-caption mt-6 px-1" style={{ color: "var(--ink-tertiary)" }}>
        没有在装终端客户端？那就不该有人让你打开这一页。
      </p>
    </>
  );
}
