"use client";

import { useState } from "react";

import { parseRepoRef, repoRefKey } from "@/lib/github/link-refs";

/**
 * 发帖时那一行「这篇聊的是哪个项目」。
 *
 * ═════════════════════════════════════════
 * 认没认出来，**当场就说**
 * ═════════════════════════════════════════
 *
 * 这一栏收两种写法（`owner/repo` 和一整条 GitHub 地址），
 * 而认不出来时服务端是**静默当没填**的 —— 不为一个可选字段
 * 把一篇写好的帖子挡回去。
 *
 * 静默的代价必须在这里补上：不当场显示的话，人填了一个自己以为
 * 有效的值、发出去、帖子上什么都没有，而没有任何地方告诉过他。
 * 所以校验用的是**和服务端同一个 `parseRepoRef`**（纯函数，
 * 客户端也 import 得进来）—— 两边各写一份判断，迟早会出现
 * 「这里说认得、发出去却没了」。
 *
 * ═════════════════════════════════════════
 * 一篇只能关联一个
 * ═════════════════════════════════════════
 *
 * 不做成多选：能挂三个的话它就变成了第二套标签，而标签已经有了。
 * 这一栏回答的是更窄的一个问题 —— **这篇帖子属于哪个项目**。
 */
export function RepoField({
  name,
  defaultValue = "",
  onChange,
}: {
  /** 表单字段名（受控用法下可不填） */
  name?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
}) {
  const [raw, setRaw] = useState(defaultValue);
  const trimmed = raw.trim();
  const parsed = trimmed ? parseRepoRef(trimmed) : null;

  return (
    <div className="inset-group px-4 py-3">
      <label className="block">
        <span className="t-subhead font-medium">关联项目</span>
        <span className="t-caption2 ml-1.5 text-[var(--ink-quaternary)]">可不填</span>
        <input
          name={name}
          value={raw}
          onChange={(e) => {
            setRaw(e.target.value);
            onChange?.(e.target.value);
          }}
          placeholder="owner/repo，或者直接粘 GitHub 地址"
          /* 输入项目名时自动大写、自动纠错只会碍事 */
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="t-body mt-2 min-h-11 w-full rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2 outline-none placeholder:text-[var(--ink-quaternary)]"
        />
      </label>

      {/*
        * 三种状态说三句不同的话。空着的时候说的是**它有什么用**——
        * 一个只写着「可不填」的输入框，没有人会去填。
        */}
      {!trimmed ? (
        <p className="t-caption2 mt-1.5 leading-relaxed text-[var(--ink-tertiary)]">
          填了之后，这篇会出现在那个项目的页面上 ——
          同一个项目的讨论现在散在几十篇帖子里，谁也串不起来
        </p>
      ) : parsed ? (
        <p className="t-caption2 mt-1.5 text-[var(--ink-tertiary)]">
          认出来了：<span className="font-medium text-[var(--ink)]">{repoRefKey(parsed)}</span>
        </p>
      ) : (
        /*
         * role="status" 而不是 alert：这不是错误，帖子照样发得出去。
         * 用 alert 会打断读屏用户正在做的事，而这里只是一句提醒。
         */
        <p className="t-caption2 mt-1.5 leading-relaxed text-[var(--warning)]" role="status">
          认不出来这是哪个项目，这一栏会被忽略（帖子照发）。
          要写成 <code>owner/repo</code> 或者 github.com 上的地址
        </p>
      )}
    </div>
  );
}
