import { NotFoundBody } from "@/components/NotFoundBody";

/**
 * `(app)` 分组里的 404。
 *
 * 这一条边界存在的唯一理由：**外壳已经给了一个 `<main>`**。
 *
 * 一个存在的路由里调 `notFound()`（被功能开关关掉的 `/shop`、
 * 找不到的那篇帖子、看不见的那个人），渲染出来的 404 是**带外壳的** ——
 * 侧栏、底部导航一个不少。没有这一条边界的话，用的是根布局那份，
 * 而那份自带 `<main>`，于是一页上出现两个 main 地标，
 * 读屏用户的「跳到正文」变成一次猜。
 *
 * 内容和根布局那份**是同一个组件**，只差最外面那层容器 ——
 * 各写一份的话，改了一处忘了另一处，而两处的差别没有人会去看。
 */
export default function AppNotFound() {
  return (
    <div className="mx-auto flex w-full max-w-[26rem] flex-col justify-center py-12">
      <NotFoundBody />
    </div>
  );
}
