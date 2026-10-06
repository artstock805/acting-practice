"""앱 아이콘 생성: 어두운 무대 + 스포트라이트 + 🎭 (python assets/make_icon.py)"""
from PIL import Image, ImageDraw, ImageFont, ImageFilter

SIZE = 512
img = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
mask = Image.new('L', (SIZE, SIZE), 0)
ImageDraw.Draw(mask).rounded_rectangle((0, 0, SIZE - 1, SIZE - 1), radius=110, fill=255)

bg = Image.new('RGBA', (SIZE, SIZE), (23, 19, 15, 255))
glow = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
ImageDraw.Draw(glow).ellipse((60, 40, 452, 432), fill=(245, 185, 66, 150))
bg = Image.alpha_composite(bg, glow.filter(ImageFilter.GaussianBlur(70)))
img.paste(bg, (0, 0), mask)

font = ImageFont.truetype('C:/Windows/Fonts/seguiemj.ttf', 109)  # 컬러 이모지는 109px 기준으로 렌더 후 확대
emoji = Image.new('RGBA', (160, 160), (0, 0, 0, 0))
ImageDraw.Draw(emoji).text((80, 80), '🎭', font=font, embedded_color=True, anchor='mm')
emoji = emoji.crop(emoji.getbbox()).resize((340, int(340 * emoji.height / emoji.width)), Image.LANCZOS)
img.alpha_composite(emoji, ((SIZE - emoji.width) // 2, (SIZE - emoji.height) // 2 + 10))

img.save('assets/acting-practice.png')
img.save('assets/acting-practice.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
