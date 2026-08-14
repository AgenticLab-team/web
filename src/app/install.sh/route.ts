import { installScript } from "@/lib/tui/install-script";

export const dynamic = "force-dynamic";

/**
 * 安装脚本。
 *
 * 两个地址都到这儿：
 *   · `curl -Ls agenticlab.sh`        —— proxy 按 UA/Accept 改写过来的
 *   · `curl -Ls agenticlab.sh/install.sh` —— 直接敲这个
 *
 * 后者存在的理由是**可读性**：一个谨慎的人会先
 * `curl agenticlab.sh/install.sh | less` 看一眼再决定要不要跑，
 * 而那个地址要能被直接说出来。
 */
export async function GET() {
  return new Response(installScript(), {
    headers: {
      /*
       * `text/plain` 而不是 `application/x-sh`。
       *
       * 后者会让浏览器**下载**这个文件而不是显示它 ——
       * 而「先看一眼再跑」是这类脚本唯一的安全习惯，
       * 不该被一个 Content-Type 挡住。
       */
      "Content-Type": "text/plain; charset=utf-8",
      /*
       * 不缓存。发布新版本之后，下一秒装的人就该拿到新的 sha256 ——
       * 缓存住的话，他会下到新二进制、拿旧校验和去比，然后装不上，
       * 而错误信息是「校验和对不上」，最像被人做了手脚的那一句。
       */
      "Cache-Control": "no-store",
    },
  });
}
