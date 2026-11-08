"""生成应用图标：暗黑底 + 金色 M（与应用内 favicon 一致）。"""
from PIL import Image, ImageDraw

SIZE = 256
img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# 圆角底板
r = 56
d.rounded_rectangle((0, 0, SIZE - 1, SIZE - 1), radius=r, fill=(11, 10, 9, 255))
d.rounded_rectangle((2, 2, SIZE - 3, SIZE - 3), radius=r - 2, outline=(212, 175, 106, 46), width=2)

# 金色 M 折线
pts = [(68, 180), (68, 76), (128, 136), (188, 76), (188, 180)]
d.line(pts, fill=(212, 175, 106, 255), width=15, joint="curve")
for p in (pts[0], pts[-1]):
    d.ellipse((p[0] - 8, p[1] - 8, p[0] + 8, p[1] + 8), fill=(212, 175, 106, 255))

img.save("assets/icon.ico", sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)])
img.save("assets/icon.png")
print("icon ok")
