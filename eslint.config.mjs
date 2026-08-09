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
    "out/**",
    "build/**",
    "next-env.d.ts",
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
