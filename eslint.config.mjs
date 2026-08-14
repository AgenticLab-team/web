import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    // ── 构建产物不止 .next 一个目录 ──────────────────────────
    //
    // 这一段用行注释，不用块注释。写块注释的话，正文里只要出现一次
    // 「星号紧跟斜杠」就会把注释提前终结掉 —— 而这条规则要讲的东西
    // 恰恰是一串带星号的路径通配符。第一版就是这么写的，
    // 结果 eslint 直接 `SyntaxError: Unexpected end of input` 起不来，
    // 而报错里一个字都不会提到注释。
    //
    // 正题：next.config.ts 的 distDir 是按环境变量走的，线上是蓝绿两份
    // .next-blue / .next-green；临时排查时也常见 .next-check、.next-verify
    // 这种目录。它们都不在上面那条 ".next/**" 里。
    //
    // 于是 eslint 会去查 Turbopack 生成的 chunk：满屏
    // "require() style import is forbidden"、"Do not assign to module"、
    // "no-this-alias" —— 全部来自机器生成的代码，一条都不是人写的。
    // 而一份几千条的报告等于没有报告，真问题会淹在里面
    // （和下面 worktree 那条是同一个理由）。
    //
    // .gitignore 里早就把这些目录一起排掉并解释过同一件事了，
    // 只是这边没跟着改 —— 两处规则必须同时存在，漏一处就等于没有。
    ".next-*/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // 本地看界面时下载的无头浏览器（npx @puppeteer/browsers install chrome@stable，
    // 默认就装在项目目录下）。它自带的 inspector_overlay 是一行几万字符的压缩 JS，
    // lint 一次报 195 条 no-unused-expressions —— 又一份把真问题淹掉的报告。
    //
    // .gitignore 里排过它了，但**那个不算数**：ESLint 9 的 flat config
    // 默认不读 .gitignore（要读得显式用 includeIgnoreFile）。
    // 这是本文件第二次踩「两处规则必须同时存在」这件事。
    "chrome/**",
    /*
     * agent 的临时工作区。
     *
     * 它们是这个仓库的独立 worktree —— 里面是同一份代码的副本，
     * 不排掉的话 lint 会把每个文件查 N 遍，
     * 而**一份 18000 条的报告等于没有报告**：真问题会淹在里面。
     */
    ".claude/worktrees/**",
  ]),
]);

export default eslintConfig;
