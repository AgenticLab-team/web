"use client";

import { Switch } from "@/components/ui/Switch";
import { FolderGit2, RefreshCw } from "lucide-react";
import { useState, useTransition } from "react";

import {
  refreshGithubAction,
  setGithubPromptEnabledAction,
  setGithubVisibilityAction,
  unlinkGithubAction,
} from "@/lib/github/actions";

/**
 * 「登录与安全」页上的 GitHub 那一块。
 *
 * ─────────────────────────────────────────
 * 三个开关是三件独立的事
 * ─────────────────────────────────────────
 *
 * 绑定 / 展示 / 提醒。做成一个开关的话，
 * 「我想要新项目提醒，但不想让同群的人看到我的 GitHub」这个
 * 完全合理的组合就表达不出来 —— 而这个站的用户是同一个微信群里的人，
 * 「让谁看到什么」在这里比在一个陌生人社区里敏感得多。
 *
 * 默认是：绑定后**展示关着、提醒开着**。
 * 展示要多点一下，因为它对别人可见；提醒只对自己可见，
 * 而它正是大多数人来绑定的理由。
 */

export interface GithubPanelProps {
  connected: boolean;
  login: string | null;
  htmlUrl: string | null;
  repoCount: number;
  showOnProfile: boolean;
  promptEnabled: boolean;
  /** 上次抓取时间，0 表示还没抓过 */
  fetchedAt: number;
  lastError: string | null;
}

export function GitHubPanel(props: GithubPanelProps) {
  const [show, setShow] = useState(props.showOnProfile);
  const [prompt, setPrompt] = useState(props.promptEnabled);
  const [note, setNote] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();

  if (!props.connected) {
    return (
      <div>
        <div className="inset-group">
          {/*
            必须是真的跳转，不能是 fetch —— OAuth 要求用户的浏览器
            自己走到 github.com 上去看到那个授权页面。
            用 <a> 而不是 next/link：跨站地址不该进路由预取
          */}
          <a
            href="/api/auth/github/start?return=/me/security"
            className="inset-row flex min-h-11 items-center gap-3 px-4 py-3 transition-colors hover:bg-[var(--fill)]"
          >
            <FolderGit2 className="h-4 w-4 shrink-0" strokeWidth={2} aria-hidden />
            <span className="t-body flex-1">绑定 GitHub</span>
          </a>
        </div>
        <p className="t-caption mt-2 px-1 leading-relaxed text-[var(--ink-tertiary)]">
          只申请读取<strong>公开信息</strong>的权限 —— 拿不到私有仓库，也发不了任何东西。
          绑定之后可以选择在主页上展示自己的项目。
        </p>
      </div>
    );
  }

  function run(fn: () => Promise<{ ok: boolean; error?: string; message?: string }>, undo: () => void) {
    setNote(null);
    startTransition(async () => {
      const result = await fn();
      if (result.ok) setNote(result.message ?? null);
      else {
        undo();
        setNote(result.error ?? "保存失败");
      }
    });
  }

  return (
    <div>
      <div className="inset-group">
        <div className="inset-row flex items-center gap-3 px-4 py-3">
          <FolderGit2 className="h-4 w-4 shrink-0" strokeWidth={2} aria-hidden />
          <span className="t-body min-w-0 flex-1 truncate">{props.login}</span>
          <a
            href={props.htmlUrl ?? "#"}
            target="_blank"
            rel="noopener noreferrer"
            className="t-footnote text-[var(--accent)]"
          >
            去看看
          </a>
        </div>

        <div className="inset-row flex items-start gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="t-body">在我的主页上展示项目</p>
            <p className="t-caption mt-0.5 leading-relaxed text-[var(--ink-tertiary)]">
              同群的人打开你的主页时能看到，只展示公开仓库
              {props.repoCount > 0 && `（现在有 ${props.repoCount} 个）`}
            </p>
          </div>
          <Switch
            label="在我的主页上展示项目"
            on={show}
            disabled={pending}
            onToggle={() => {
              const next = !show;
              const prev = show;
              setShow(next);
              run(
                () => setGithubVisibilityAction(next),
                () => setShow(prev),
              );
            }}
          />
        </div>

        <div className="inset-row flex items-start gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="t-body">有新项目或新 PR 时提醒我</p>
            <p className="t-caption mt-0.5 leading-relaxed text-[var(--ink-tertiary)]">
              只在你自己的「我的」页出现，别人看不到。同一个项目只会提醒一次
            </p>
          </div>
          <Switch
            label="有新项目或新 PR 时提醒我"
            on={prompt}
            disabled={pending}
            onToggle={() => {
              const next = !prompt;
              const prev = prompt;
              setPrompt(next);
              run(
                () => setGithubPromptEnabledAction(next),
                () => setPrompt(prev),
              );
            }}
          />
        </div>

        <button
          type="button"
          disabled={pending}
          onClick={() => run(refreshGithubAction, () => {})}
          className="inset-row flex min-h-11 w-full items-center gap-3 px-4 py-3 transition-colors hover:bg-[var(--fill)] disabled:opacity-45"
        >
          <RefreshCw className="h-4 w-4 shrink-0 text-[var(--ink-tertiary)]" strokeWidth={2} aria-hidden />
          <span className="t-body flex-1 text-left">刷新仓库列表</span>
          <span className="t-footnote text-[var(--ink-tertiary)]">
            {props.fetchedAt ? new Date(props.fetchedAt).toLocaleString("zh-CN", { hour12: false }) : "还没抓过"}
          </span>
        </button>

        {/*
          解绑要点两下。这是个会<strong>删掉数据</strong>的动作（缓存和提示记录一起清），
          而它就摆在几个可以随手拨来拨去的开关旁边
        */}
        {confirming ? (
          <div className="inset-row flex min-h-11 items-center gap-2 px-4 py-3">
            <span className="t-footnote flex-1 text-[var(--ink-secondary)]">
              解绑会清掉已同步的仓库和提醒
            </span>
            <button
              type="button"
              disabled={pending}
              onClick={() => setConfirming(false)}
              className="t-footnote px-2 py-1 text-[var(--ink-secondary)]"
            >
              取消
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => run(unlinkGithubAction, () => {})}
              className="t-footnote px-2 py-1 font-medium text-[var(--danger)]"
            >
              确认解绑
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="inset-row flex min-h-11 w-full items-center px-4 py-3 transition-colors hover:bg-[var(--fill)]"
          >
            <span className="t-body text-[var(--danger)]">解绑 GitHub</span>
          </button>
        )}
      </div>

      {props.lastError && (
        <p className="t-caption mt-2 px-1 leading-relaxed" style={{ color: "var(--warning)" }}>
          上次没抓到最新数据（{props.lastError}）—— 页面上还是之前那一份，没有丢。
        </p>
      )}
      {note && <p className="t-caption mt-2 px-1 text-[var(--ink-tertiary)]">{note}</p>}
    </div>
  );
}

