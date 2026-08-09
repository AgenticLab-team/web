#!/usr/bin/env python3
"""
站点图标。

─────────────────────────────────────────
为什么要有这个脚本
─────────────────────────────────────────

图标一直是 Next.js 脚手架自带的那个（25931 字节，一字节没改）。
它出现在浏览器标签、微信里的分享卡片、加到主屏之后的桌面上 ——
每一处都在说「这个站还没做完」。

用脚本生成而不是塞一个二进制进仓库：几个尺寸、几种用途
（favicon / 主屏 / PWA）必须是同一个图形，手工导出迟早对不上。
改了这里就重跑 `python3 scripts/make-icons.py`。

─────────────────────────────────────────
画什么
─────────────────────────────────────────

一张猫脸。这个站是围绕微信群做的沉淀，群里那只机器人是「群猫娘」。

16 像素是真正的约束，而且是先画完才知道的：
最初画的是「带猫耳的对话气泡」，放到 16px 一看，
耳朵和气泡糊成一个缺了口的方块 —— 像被咬了一口，不像猫。

现在这版能认出来靠的是**那两只眼睛**：有两个点，
人就会把它读成一张脸；没有的话它只是个带角的白方块。
所以眼睛画得比"好看"的比例大一号。
"""

from PIL import Image, ImageDraw

# 品牌绿。与 globals.css 的 --accent 一致
ACCENT = (13, 92, 71, 255)
INK = (255, 255, 255, 255)

# 先在 16 倍的画布上画，再缩下去 —— PIL 没有抗锯齿的绘图 API，
# 超采样是让曲线在 16px 下不发毛的唯一办法
SS = 16


def draw_icon(size: int, *, rounded: bool = True) -> Image.Image:
    n = size * SS
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 底：圆角方块。半径取 22% —— 和 iOS 图标的视觉圆度接近
    if rounded:
        d.rounded_rectangle([0, 0, n - 1, n - 1], radius=int(n * 0.22), fill=ACCENT)
    else:
        d.rectangle([0, 0, n - 1, n - 1], fill=ACCENT)

    # 脸
    fx0, fx1 = n * 0.14, n * 0.86
    fy0, fy1 = n * 0.30, n * 0.78
    d.rounded_rectangle([fx0, fy0, fx1, fy1], radius=int(n * 0.16), fill=INK)

    """
    耳朵。

    三角形的底边要**压进脸里**（fy0 + 0.03n），而不是刚好落在脸的上边缘 ——
    落在边缘上的话，圆角处会留下两道极细的白色楔子，
    在 16 像素下那两道楔子会变成一对说不清是什么的毛刺。
    """
    for cx in (n * 0.31, n * 0.69):
        half = n * 0.155
        d.polygon(
            [
                (cx - half, fy0 + n * 0.03),
                (cx, n * 0.11),
                (cx + half, fy0 + n * 0.03),
            ],
            fill=INK,
        )

    """
    眼睛。

    这两个点是整个图标在 16 像素下还认得出是张脸的原因 ——
    去掉之后就只是一个带角的白方块。
    所以它们画得比"好看"的比例大一号。
    """
    eye_r = n * 0.058
    for cx in (n * 0.375, n * 0.625):
        cy = n * 0.505
        d.ellipse([cx - eye_r, cy - eye_r * 1.15, cx + eye_r, cy + eye_r * 1.15], fill=ACCENT)

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    from pathlib import Path

    app = Path(__file__).resolve().parent.parent / "src" / "app"
    public = Path(__file__).resolve().parent.parent / "public"

    # favicon.ico 里塞三个尺寸 —— 浏览器各挑各的，16 用在标签页，
    # 32 用在书签栏，48 用在 Windows 的桌面快捷方式
    ico_sizes = [16, 32, 48]
    frames = [draw_icon(s) for s in ico_sizes]
    frames[0].save(app / "favicon.ico", format="ICO", sizes=[(s, s) for s in ico_sizes])

    # Next 的约定文件：app/icon.png 与 app/apple-icon.png
    draw_icon(512).save(app / "icon.png")
    # 苹果的主屏图标自己会加圆角，所以给方的 —— 给圆角的会被切两次
    draw_icon(180, rounded=False).save(app / "apple-icon.png")

    # PWA manifest 用的两个尺寸
    draw_icon(192).save(public / "icon-192.png")
    draw_icon(512).save(public / "icon-512.png")

    print("写好了：favicon.ico(16/32/48) icon.png(512) apple-icon.png(180) icon-192 icon-512")


if __name__ == "__main__":
    main()
