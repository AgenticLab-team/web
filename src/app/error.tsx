"use client";

import { useEffect } from "react";

/**
 * 页面出错时的兜底。
 *
 * ─────────────────────────────────────────
 * 在这之前，这一层根本不存在
 * ─────────────────────────────────────────
 *
 * 任何一个页面在渲染时抛异常，用户看到的是 Next 自带的那一屏：
 * 白底、英文、一句 "Application error: a client-side exception has
 * occurred"，没有任何出口，连刷新按钮都没有。
 *
 * 而这个站的主力访问环境是**微信内置浏览器** —— 那里没有地址栏，
 * 没有刷新按钮，没有开发者工具。撞上这一屏的人**只能退出去**，
 * 而且多半不会再点第二次。
 *
 * ─────────────────────────────────────────
 * 「再试一次」是真的能救回来的
 * ─────────────────────────────────────────
 *
 * `reset()` 会重新渲染这一段，不是刷新整页。而这一类错误里
 * 相当一部分是**一次性的**（数据库刚好被写锁住、上游超时），
 * 重试一下就过去了 —— 这个按钮的存在能让那一批人根本不必知道
 * 刚才出过事。
 *
 * ─────────────────────────────────────────
 * 不把 message 显示出来
 * ─────────────────────────────────────────
 *
 * 异常信息里可能带着表名、路径、SQL 片段。对普通成员来说它既看不懂
 * 也帮不上忙，而对别有用心的人是一份免费的情报。
 *
 * 只显示 `digest` —— 那是 Next 给这次错误生成的短哈希，
 * 服务端日志里能按它精确定位到这一次。报错的人念出这串字符，
 * 就够查了。
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    /*
     * 送到浏览器控制台，方便本地开发和「让他把控制台截个图」。
     * 生产环境里 message 已经被 Next 抹成通用文案了，这里不会多泄露什么。
     */
    console.error("页面渲染出错：", error);
  }, [error]);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[26rem] flex-col justify-center px-6 py-12">
      <p className="t-subhead text-[var(--danger)]">出错了</p>
      <h1 className="t-title1 mt-1">这一页没能打开</h1>
      <p className="t-body mt-3 leading-relaxed text-[var(--ink-secondary)]">
        大多数时候再试一次就好了。要是一直这样，说明是站里的问题，不是你操作的问题。
      </p>

      <div className="mt-8 flex flex-col gap-2">
        <button
          type="button"
          onClick={reset}
          className="t-subhead inline-flex min-h-11 items-center justify-center rounded-[var(--radius-control)] bg-[var(--accent)] px-5 font-medium text-[var(--accent-ink)] transition active:scale-[0.97]"
        >
          再试一次
        </button>
        {/*
          用 <a> 而不是 <Link>：**出错的可能正是路由这一层**，
          客户端跳转有概率跟着一起坏 —— 而这是最后一道出口，
          它必须在整个前端都不可靠的前提下仍然有效。
          整页重新加载最笨，也最靠得住。

          eslint 那条规则默认是对的（站内跳转该用 Link），
          这里是它唯一不该适用的地方。
        */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a
          href="/"
          className="t-subhead inline-flex min-h-11 items-center justify-center rounded-[var(--radius-control)] bg-[var(--fill)] px-5 text-[var(--ink)] transition active:scale-[0.97]"
        >
          回首页
        </a>
      </div>

      {error.digest && (
        <p className="t-caption mt-8 text-[var(--ink-tertiary)]">
          {/* 报错的人念出这串字符就够查了 —— 服务端日志里能按它精确定位 */}
          出错编号 <code className="tabular-nums">{error.digest}</code>
          <br />
          反馈时带上它，我们能直接查到这一次。
        </p>
      )}
    </main>
  );
}
