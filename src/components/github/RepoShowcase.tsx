import { GitFork, Star } from "lucide-react";

import type { RepoFact } from "@/lib/github/repo-rules";

/**
 * 主页上的「GitHub 项目」那一栏。
 *
 * ─────────────────────────────────────────
 * 没有可展示的东西时，返回 null
 * ─────────────────────────────────────────
 *
 * 不是返回一个「暂无项目」的空块。没绑 GitHub 的人占这个站的绝大多数，
 * 而一个挂在所有人主页上的空区块会做两件坏事：让主页变难看，
 * 以及**把「他没绑 GitHub」变成一条公开信息**。
 *
 * 判定收在这一个组件里，页面那边只管把它摆进去 ——
 * 摆在页面里判断的话，两个页面早晚会判断出两套结果。
 */
export function RepoShowcase({
  repos,
  profileUrl,
}: {
  repos: RepoFact[];
  /**
   * 这个人的 GitHub 主页地址。
   *
   * 用绑定时 GitHub 自己给的 `html_url`，**不在这里拿 login 拼一个出来** ——
   * 拼的那一版在改过用户名之后会指向一个已经被别人注册走的地址，
   * 而那是这个站唯一一处会把访客送到「冒充他的人」那里去的链接。
   */
  profileUrl: string;
}) {
  if (repos.length === 0) return null;

  return (
    <div className="inset-group">
      {repos.map((repo) => (
        <a
          key={repo.id}
          href={repo.htmlUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inset-row block px-4 py-3 transition-colors hover:bg-[var(--fill)]"
        >
          <p className="t-subhead flex items-baseline justify-between gap-2">
            <span className="min-w-0 truncate font-medium">{repo.name}</span>
            <span className="tabular t-caption2 flex shrink-0 items-center gap-2 text-[var(--ink-quaternary)]">
              {repo.stars > 0 && (
                <span className="flex items-center gap-0.5">
                  <Star className="h-3 w-3" strokeWidth={2} aria-hidden />
                  {repo.stars}
                </span>
              )}
              {repo.isFork && <GitFork className="h-3 w-3" strokeWidth={2} aria-label="fork 来的" />}
            </span>
          </p>
          {repo.description && (
            <p className="t-caption mt-0.5 line-clamp-2 break-words leading-relaxed text-[var(--ink-secondary)]">
              {repo.description}
            </p>
          )}
          {repo.language && (
            <p className="t-caption2 mt-1 text-[var(--ink-quaternary)]">{repo.language}</p>
          )}
        </a>
      ))}
      <a
        href={profileUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inset-row flex min-h-11 items-center px-4 py-3 transition-colors hover:bg-[var(--fill)]"
      >
        <span className="t-footnote text-[var(--accent)]">在 GitHub 上看全部</span>
      </a>
    </div>
  );
}
