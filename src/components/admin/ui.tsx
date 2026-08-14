import type { ReactNode } from "react";
import { buttonClass, type ButtonSize, type ButtonTone } from "@/components/ui/primitives";


/**
 * ─────────────────────────────────────────────────────────────
 * 后台自己的构件层
 * ─────────────────────────────────────────────────────────────
 *
 * 站长的原话是「整个管理模块 ui布局都是灾难」。2026-08 的普查
 * 找到了那句话的具体出处 —— 不是缺构件，是**同一个构件被 39 个
 * 组件各写了一遍**：
 *
 *   · 按钮：60 种不同的 class 串。内边距有 px-4 py-2 / px-4 py-2.5 /
 *     px-3 py-1.5 / px-3.5 py-2 / px-2.5 py-1 / px-2 py-1 六派，
 *     圆角有 radius-control / radius-pill / rounded-[var(--radius-chip)] / rounded-[var(--radius-chip)] 四派，
 *     字号有 t-subhead / t-footnote / t-caption / 裸 text-[13px] 四派。
 *   · 输入框：`inputClass` 这个常量在六个文件里被**逐字复制**了六遍，
 *     另有两处改用了「border + canvas 底」的第二套长相。
 *   · 「危险」有五种画法：实心红+白字、实心红+canvas 字、
 *     12% 淡红底、fill 底红字、红描边 hover 反白 —— 而收回称号
 *     这种同样是收权限的操作干脆一点危险色都没有。
 *   · 列表行：`inset-row ... px-4 py-2.5` 手写 15 次，
 *     和 primitives 的 `Row`（px-4 py-3）并存 —— 两种密度。
 *
 * 所以这一层刻意只收**已经重复了 ≥5 次**的东西，一个预防性设计都不做。
 * 它放在 components/admin 而不是 components/ui：这些取舍（比如
 * 「危险操作一律要先看到后果」）只在后台成立，抬进共享层会让前台
 * 也背上后台的包袱。
 *
 * ─────────────────────────────────────────
 * 为什么没有 "use client"
 * ─────────────────────────────────────────
 *
 * 这里全是无状态的纯展示函数。不写 "use client" 的模块两侧都能进 ——
 * 服务端页面直接渲染，客户端组件导入时它跟着进客户端图。
 * 写了反而会把 20 个纯服务端的后台页面整片拖进客户端包。
 */

/* ─────────────────────────────────────────────────────────────
   按钮
   ───────────────────────────────────────────────────────────── */

/**
 * 后台只有五档按钮，多一档就会有人在第六种场合发明第七种。
 *
 * · primary  —— 这一屏的主行动，一屏最多一个（保存、提交、确认结案）
 * · neutral  —— 并列的几个选择。**申诉的「采纳/驳回」是这一档**：
 *   把其中一个做成主色，等于在界面上替人做了决定。
 * · danger   —— 不可逆、且立刻作用在别人身上（封禁、删除、关模块、冲正）。
 *   实心红是为了让手指在按下去之前慢半拍，所以它绝不能用在
 *   「退款」「移除身份组」这种撤得回来的事上，否则红色会贬值。
 * · dangerSoft —— 可撤销的破坏性动作（移除身份组、收回称号、退款、
 *   撤销邀请码）。有红色但不是实心：说明「这是在拿走什么」，
 *   而不是「这一下没法回头」。
 * · quiet    —— 取消、算了、改回去。**它必须比旁边任何一个都轻**：
 *   一个和确认键一样重的取消键，会让人在犹豫时点错方向。
 */

/**
 * 两个尺寸。
 *
 * md 是默认：44px 高，正好是一根手指的落点，也是 iOS 的最小命中区。
 * sm 只给**行内**的那些（列表行尾的「重试」「停用」）—— 它们在
 * 视觉上必须让位给行本身的内容，所以做小；但小了就点不中，
 * 于是一律带 tap-target 把可点范围撑回 44px（视觉尺寸不变，
 * 见 globals.css 里那条伪元素规则）。
 *
 * 之前后台一个 tap-target 都没有，而 py-1 的按钮实测只有 26px 高 ——
 * 在手机上是每三次点中两次，而点不中的人不会来报 bug。
 */

/*
 * ═════════════════════════════════════════
 * 两张表搬到共享层去了
 * ═════════════════════════════════════════
 *
 * 这套 tone/size 原来在这里自成一份，而开放 API 那几个页面
 * **同时**也有一份自己的（三档 tone + 一个 CONTROL 常量）——
 * 两套 kit 各自都很合理，合起来的效果是全站按钮比重构之前更多样。
 *
 * 现在长相统一由 `ui/primitives.tsx` 的 `buttonClass` 出，
 * 这里只留后台自己的语义封装（`AdminButton`、确认流程、
 * 「危险操作必须先看到后果」那套）—— 那些取舍只在后台成立，
 * 抬进共享层会让前台背上后台的包袱。
 *
 * 分工是：**共享层管长相，这里管规矩。**
 */
export type AdminButtonTone = ButtonTone;
export type AdminButtonSize = ButtonSize;

/**
 * 按钮的 class。
 *
 * 单独导出成函数而不是只给组件，是因为后台有一批「长得是按钮、
 * 其实是链接」的东西（下载 CSV 的 `<a download>`、跳去流水页的
 * `<Link>`）。让它们复用同一个字符串，比让它们各自再抄一遍近似的
 * class 要可靠 —— 上一轮就是这么裂开的。
 */
export function adminButtonClass({
  tone = "neutral",
  size = "md",
  block = false,
  className = "",
}: {
  tone?: AdminButtonTone;
  size?: AdminButtonSize;
  /** 撑满一行。表单底部的主按钮基本都要 */
  block?: boolean;
  className?: string;
} = {}) {
  // 长相全部来自共享层；这里只补后台特有的「撑满一行」
  return buttonClass(tone, size, [block ? "w-full" : "", className].filter(Boolean).join(" "));
}

export function AdminButton({
  tone,
  size,
  block,
  className,
  children,
  ...rest
}: {
  tone?: AdminButtonTone;
  size?: AdminButtonSize;
  block?: boolean;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...rest}
      className={adminButtonClass({ tone, size, block, className })}
    >
      {children}
    </button>
  );
}

/**
 * 一排按钮。
 *
 * 手机上换行而不是挤 —— 三个按钮横着塞进 375px 的结果是每个都只剩
 * 一个字的宽度，而它们恰恰是「封禁 / 暂停 / 恢复正常」这种一点也
 * 不能点错的东西。flex-wrap 在窄屏上让它们各占一行。
 */
export function AdminActions({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`flex flex-wrap items-center gap-2 ${className}`}>{children}</div>;
}

/* ─────────────────────────────────────────────────────────────
   表单
   ───────────────────────────────────────────────────────────── */

/**
 * 输入框、下拉、多行框共用的长相。
 *
 * 这个字符串以前叫 `inputClass`，在六个文件里被逐字复制了六份；
 * 另外两个文件（LevelEditor、FlagList 的灰度编辑器）改用了
 * 「1px 边框 + canvas 底」的第二套 —— 于是同一个后台里，
 * 敏感词页和等级页的输入框长得不是一个东西。
 *
 * 统一成无边框的 fill 底：后台的表单密度高，一屏十几个 1px 边框
 * 会把版面切得很碎；fill 底靠色块区分，安静得多。
 * min-h-11 是因为这些框在手机上真的会被点。
 */
export const adminFieldClass =
  "t-subhead min-h-11 w-full rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2 outline-none transition-colors placeholder:text-[var(--ink-quaternary)] focus:bg-[var(--fill-strong)] disabled:opacity-50";

/** 数字要等宽，否则一列金额会随着位数抖 */
export const adminNumberFieldClass = `tabular ${adminFieldClass}`;

/**
 * 带标题的表单行。
 *
 * 除了排版，它还解决一件无障碍的事：`<label>` 包住输入框之后，
 * 读屏才念得出这个框是干什么的。后台里有一批框只有 placeholder，
 * 而 placeholder 一旦开始打字就消失了 —— 那时候连眼睛看得见的人
 * 都不记得这一栏是什么。
 */
export function AdminField({
  label,
  hint,
  children,
  className = "",
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="t-caption2 mb-1 block text-[var(--ink-quaternary)]">{label}</span>
      {children}
      {hint && <span className="t-caption2 mt-1 block text-[var(--ink-tertiary)]">{hint}</span>}
    </label>
  );
}

/**
 * 可切换的药丸（筛选、档位、期限预设）。
 *
 * 和 primitives 的 `Pill` 是两件事：那个是**链接**（服务端筛选，
 * 翻页即导航），这个是**按钮**（客户端本地状态）。之前八个组件
 * 各自手写了这个按钮态，选中色有 `bg-ink` / `bg-accent` 两派。
 * 统一成 `bg-ink`：accent 在后台已经被主按钮占了，
 * 一个选中的筛选条和一个「保存」长得一样重是会点错的。
 */
export function AdminChip({
  active,
  className = "",
  children,
  ...rest
}: { active?: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      aria-pressed={active}
      {...rest}
      /*
        * `max-w-full` + `truncate`：标签的长度**不受控**。
        *
        * 群发那一页拿它列群名，而群名里有「把群名起得很长的那个群 ·
        * 二零二六年秋季 · 仅限内部讨论」这种 —— 加上 `shrink-0`，
        * 一颗药丸就把整页顶到 435px 宽（视口 390），
        * 连固定的顶栏和底部导航都跟着被拽出去。
        *
        * ⚠️ **不能用 `truncate`。**
        *
        * 第一版加了它，页面确实不横滚了，而命中区从 44 掉回 32 ——
        * `truncate` 带着 `overflow: hidden`，而 `.tap-target` 靠一个
        * 往外撑的伪元素扩大可点范围，正好被它剪掉。
        * 一个修 A 的改动顺手废掉了 B，两边都在同一个 className 里。
        *
        * 所以只给宽度上限，让长标签在药丸里换行 —— 高一点没关系，
        * 顶出视口才有关系。
        */
      className={`tap-target t-footnote inline-flex min-h-8 max-w-full shrink-0 items-center gap-1 rounded-[var(--radius-pill)] px-3 font-medium transition-colors disabled:opacity-40 ${
        active
          ? "bg-[var(--ink)] text-[var(--canvas)]"
          : "bg-[var(--fill)] text-[var(--ink-secondary)] hover:bg-[var(--fill-strong)]"
      } ${className}`}
    >
      {children}
    </button>
  );
}

/* ─────────────────────────────────────────────────────────────
   状态的三种画法
   ───────────────────────────────────────────────────────────── */

/**
 * 带色的小标签（「已封禁」「已超时」「人工」「未生效」）。
 *
 * 手写过 12 次，混合比例在 14% / 15% 之间摇摆，还有三处直接写
 * `bg-[var(--danger)]/15` —— Tailwind 的 `/15` 和 color-mix 在
 * 暗色下算出来不是一个颜色，两种写法并排时看得出深浅不一。
 *
 * 收成一处之后，「哪里该染色」也跟着变成一个能回答的问题：
 * 只有**偏离正常**的状态染色。正常态一律不染 ——
 * 满屏都是彩色标签的时候，红色就不再意味着任何事。
 */
export function AdminTag({
  color,
  children,
  className = "",
  title,
}: {
  /** 直接给 CSS 颜色值（var(--danger) 之类）。不给就是中性灰 */
  color?: string;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`t-caption2 shrink-0 rounded-[var(--radius-pill)] px-1.5 py-0.5 font-medium ${
        color ? "" : "bg-[var(--fill)] text-[var(--ink-tertiary)]"
      } ${className}`}
      style={
        color
          ? { background: `color-mix(in srgb, ${color} 15%, transparent)`, color }
          : undefined
      }
    >
      {children}
    </span>
  );
}

/**
 * 状态圆点。
 *
 * 手写过 6 次，直径在 1.5 和 2 之间摇摆。它永远带一个文字说明 ——
 * 只靠颜色传达状态的话，红绿色盲看到的是两个一模一样的灰点，
 * 而这几处点的正是「同步挂了没有」。所以 label 是必填的：
 * 它进 aria-label，也进 title。
 */
export function AdminDot({ color, label }: { color: string; label: string }) {
  return (
    <span
      className="h-2 w-2 shrink-0 rounded-full"
      style={{ background: color }}
      title={label}
      aria-label={label}
      role="img"
    />
  );
}

/**
 * 比例条（沉默比例、积分流向、分层占比）。
 *
 * 社群页、经济页、存储页各写了一份，条高分别是 1 / 1.5 / 1.5，
 * 圆角三种写法。合成一个。
 *
 * 用 translateX 而不是 width —— 动 width 每帧触发布局，
 * 微信 webview 里的低端安卓会明显掉帧（见 globals.css 的 .progress-fill）。
 */
export function AdminMeter({
  label,
  value,
  hint,
  tone = "var(--ink-tertiary)",
}: {
  label: string;
  /** 0~1 */
  value: number;
  hint?: string;
  tone?: string;
}) {
  const ratio = Math.min(1, Math.max(0, value));
  const pct = Math.round(ratio * 100);
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="t-caption text-[var(--ink-secondary)]">{label}</span>
        <span className="tabular t-caption" style={{ color: tone }}>
          {pct}%{hint && <span className="ml-1.5 text-[var(--ink-tertiary)]">{hint}</span>}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-[var(--radius-pill)] bg-[var(--fill)]">
        <div
          className="progress-fill h-full rounded-[var(--radius-pill)]"
          style={{ transform: `translateX(${ratio * 100 - 100}%)`, background: tone }}
        />
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   版面
   ───────────────────────────────────────────────────────────── */

/**
 * 分组列表里的一行。
 *
 * 后台原来有两种密度并存：primitives 的 `Row` 是 px-4 py-3，
 * 而 15 处手写的是 `px-4 py-2.5 gap-2`。差 0.5 个刻度没人会报 bug，
 * 但在存储页那种一屏三张列表的地方，三张表的行高都不一样。
 *
 * 统一到 py-2.5：后台是密集页面，一屏要塞得下更多行；
 * 44px 的命中区由行内那些 sm 按钮各自的 tap-target 保证，
 * 不靠把每一行撑高来换。
 */
export function AdminRow({
  children,
  className = "",
  align = "center",
}: {
  children: ReactNode;
  className?: string;
  /** 一行放得下就 center；带副标题、要换行的用 start */
  align?: "center" | "start";
}) {
  return (
    <div
      className={`inset-row flex gap-2.5 px-4 py-2.5 ${
        align === "center" ? "items-center" : "items-start"
      } ${className}`}
    >
      {children}
    </div>
  );
}

/**
 * 白底面板。
 *
 * 和 primitives 的 `Card` 的区别：Card 是**列表项**（一屏并排很多个），
 * 这个是**表单容器**（一屏一个，里面装输入框和按钮）。
 * 手写过 6 次，内边距 p-4 / p-3.5 / p-3 三派。
 */
export function AdminPanel({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-[var(--radius-card)] bg-[var(--surface)] p-4 hairline ${className}`}>
      {children}
    </div>
  );
}

/**
 * 面板里的小标题（「新增词条」「生成新码」「拿真文本试一下」）。
 *
 * 四个组件各写了一遍 `t-caption2 font-medium uppercase tracking-[0.06em]
 * text-[var(--ink-quaternary)]` —— 那是在手拼 `.t-group-label`，
 * 而且颜色比它淡一档。直接用真的那个类。
 */
export function AdminPanelLabel({ children }: { children: ReactNode }) {
  return <p className="t-group-label mb-2.5">{children}</p>;
}

/**
 * 跟在某一节后面的说明。
 *
 * primitives 的 `PageNote` 是**整页**的页尾注（mt-4 pb-4），
 * 而后台有 14 处需要的是「这一张表底下的一句话」——
 * 于是它们各自手写了 `t-caption mt-2 px-1 leading-relaxed
 * text-[var(--ink-tertiary)]`，其中三处漏了 leading-relaxed，
 * 那三段中文挤成一坨。
 */
export function AdminNote({
  children,
  tone,
  className = "",
}: {
  children: ReactNode;
  /** 只有真的要提醒时才染色 —— 满页黄字等于没有黄字 */
  tone?: "warning" | "danger";
  className?: string;
}) {
  const color =
    tone === "danger" ? "var(--danger)" : tone === "warning" ? "var(--warning)" : undefined;
  return (
    <p
      className={`t-caption mt-2 px-1 leading-relaxed ${
        color ? "" : "text-[var(--ink-tertiary)]"
      } ${className}`}
      style={color ? { color } : undefined}
    >
      {children}
    </p>
  );
}

/**
 * 「你现在做不了这件事」。
 *
 * 后台有九处要说这句话（没权限、利益冲突、已过期、只读）。
 * 它们全都手写了同一个 `t-caption rounded bg-fill px-3 py-2` ——
 * 而这句话的位置恰恰是按钮本来该在的地方，所以长相必须统一：
 * 不统一的话，人分不清「这里没有按钮」和「这里的按钮长得不一样」。
 */
export function AdminBlocked({ children }: { children: ReactNode }) {
  return (
    <p className="t-caption rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2 leading-relaxed text-[var(--ink-tertiary)]">
      {children}
    </p>
  );
}

/**
 * 破坏性操作的确认块。
 *
 * ─────────────────────────────────────────
 * 后台最不一致的就是这一步
 * ─────────────────────────────────────────
 *
 * 普查时数出来：关模块、批量删帖、冲正、矩阵保存有两步确认，
 * 而**封禁、下线全部设备、删敏感词、撤销邀请码没有** ——
 * 后面这几个里，封禁的影响面比关模块大得多。
 *
 * 判据不是「重不重要」，是**「点错之后还能不能收回来」**：
 * 收不回来的一律要先看到后果再点第二下。这一步不是为了防手滑
 * （手滑也确实防了），是为了让人在那一秒里读到自己要做什么。
 *
 * 所以这个块**必须列出具体是谁/哪几条**，不能只写「确定吗」——
 * 一个没有内容的确认框，人点第二下的速度和第一下一样快。
 */
export function AdminConfirm({
  title,
  children,
  confirmLabel,
  onConfirm,
  onCancel,
  disabled,
}: {
  title: string;
  /** 具体是哪几条、会连累谁 —— 这才是这个块存在的理由 */
  children?: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  disabled?: boolean;
}) {
  return (
    <div
      className="animate-rise space-y-2 rounded-[var(--radius-control)] px-3 py-2.5"
      style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)" }}
      role="group"
      aria-label={title}
    >
      <p className="t-subhead font-medium" style={{ color: "var(--danger)" }}>
        {title}
      </p>
      {children}
      <AdminActions>
        <AdminButton tone="danger" onClick={onConfirm} disabled={disabled} className="flex-1">
          {confirmLabel}
        </AdminButton>
        {/* 「再想想」永远比确认轻，而且永远在右边 —— 位置换来换去的话，肌肉记忆会点错 */}
        <AdminButton tone="quiet" onClick={onCancel}>
          再想想
        </AdminButton>
      </AdminActions>
    </div>
  );
}

/**
 * 攒了改动、粘在底部的那一条。
 *
 * 权限矩阵和批量改帖各写了一份，而其中一份把底部偏移写成了
 * `bottom-0` —— 手机上那正好是 Tab Bar 的位置，**保存按钮
 * 整个被压在导航栏下面点不到**。这是这次普查里唯一一个
 * 「功能实际不可用」的布局问题。
 *
 * 偏移统一走 `--tabbar-height` + 安全区，桌面端没有 Tab Bar
 * 所以退回 1rem。
 */
export function AdminStickyBar({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`animate-rise sticky z-20 mt-3 space-y-2.5 rounded-[var(--radius-card)] bg-[var(--surface)] p-3.5 shadow-[var(--shadow-raised)] hairline lg:bottom-4 ${className}`}
      style={{
        bottom: "calc(var(--tabbar-height) + env(safe-area-inset-bottom, 0px) + 0.75rem)",
      }}
    >
      {children}
    </div>
  );
}

/**
 * 一组统计小格（重算预览、批量报告）。
 *
 * 和 primitives 的 `StatTile` 的区别：那个是**页面级**的大数字格
 * （t-title1，一格一个指标），这个是**面板内**的小格，
 * 装在已经是 surface 的容器里，所以底色要更沉一档，
 * 不然就是白底叠白底 —— 那正是积分页现在的样子。
 */
export function AdminFigure({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-[var(--radius-control)] bg-[var(--fill)] px-2.5 py-2">
      <p className="t-caption2 text-[var(--ink-tertiary)]">{label}</p>
      <p className="tabular t-headline mt-0.5">{value}</p>
    </div>
  );
}
