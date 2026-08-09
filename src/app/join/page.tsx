import type { Metadata } from "next";
import Link from "next/link";

import { JoinForm } from "@/components/join/JoinForm";
import { env } from "@/lib/env";

export const metadata: Metadata = {
  title: "申请加入",
  description: "Agentic Lab 是一个微信社群的站点，成员身份跟着群走。",
};

/**
 * 申请加入社群。
 *
 * ─────────────────────────────────────────
 * 这一页在外壳之外
 * ─────────────────────────────────────────
 *
 * 放进 (app) 分组的话会带上侧栏和 tab 栏 —— 那些是给成员看的导航，
 * 里面列着这个人还进不去的板块。给陌生人看一排点不动的入口，
 * 比不给他看更让人不舒服。
 *
 * ─────────────────────────────────────────
 * 要把「为什么不能直接注册」说清楚
 * ─────────────────────────────────────────
 *
 * 一个没有注册按钮的站，默认观感是「做得不完整」。
 * 而这里是刻意的：账号跟着群成员身份走，站本身没有独立的注册。
 * 不解释的话，人会以为是 bug，然后去别处找注册入口。
 */
export default function JoinPage() {
  return (
    <main className="mx-auto min-h-dvh w-full max-w-[32rem] px-5 py-14">
      <h1 className="t-title1">申请加入 {env.site.name}</h1>

      <div className="mt-4 space-y-3">
        <p className="t-body leading-relaxed text-[var(--ink-secondary)]">
          这个站是一个微信社群的沉淀 ——{" "}
          <strong className="text-[var(--ink)]">账号跟着群成员身份走，没有单独的注册</strong>。
          所以「加入」这件事发生在微信里，不在这个页面上。
        </p>
        <p className="t-subhead leading-relaxed text-[var(--ink-tertiary)]">
          如果你<strong>已经在群里</strong>，不用填下面这些 ——
          直接去{" "}
          <Link href="/login" className="text-[var(--accent)]">
            登录页
          </Link>{" "}
          拿一个验证码，在群里发出来就进来了。
        </p>
      </div>

      <div className="mt-8">
        <JoinForm />
      </div>

      <p className="t-caption mt-8 leading-relaxed text-[var(--ink-quaternary)]">
        提交之后管理员会在群里核对。这里不会告诉你审核进度 ——
        重复提交也不会让它变快。
      </p>

      <Link
        href="/"
        className="t-subhead mt-10 inline-block text-[var(--accent)] transition active:opacity-60"
      >
        先随便看看
      </Link>
    </main>
  );
}
