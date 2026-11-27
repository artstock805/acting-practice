"""링크 미리보기 이미지(카톡·문자·SNS 카드, 1200x630) 생성: python assets/make_og.py"""
from PIL import Image, ImageDraw, ImageFont, ImageFilter

W, H = 1200, 630
BG = (12, 15, 21)          # 앱 배경 #0c0f15
SPOT = (244, 183, 64)      # 앱 강조색 #f4b740
PAPER = (236, 232, 224)

img = Image.new('RGB', (W, H), BG)
glow = Image.new('RGBA', (W, H), (0, 0, 0, 0))
ImageDraw.Draw(glow).ellipse((-120, -80, 620, 660), fill=(245, 185, 66, 90))   # 왼쪽 위 스포트라이트
glow = glow.filter(ImageFilter.GaussianBlur(90))
img.paste(glow, (0, 0), glow)

icon = Image.open('assets/acting-practice.png').convert('RGBA').resize((300, 300), Image.LANCZOS)
img.paste(icon, (110, (H - 300) // 2), icon)

draw = ImageDraw.Draw(img)
bold = ImageFont.truetype('C:/Windows/Fonts/malgunbd.ttf', 76)
regular = ImageFont.truetype('C:/Windows/Fonts/malgun.ttf', 34)
small = ImageFont.truetype('C:/Windows/Fonts/malgun.ttf', 28)
x = 480
draw.text((x, 170), '대사 연습 파트너', font=bold, fill=PAPER)
draw.text((x, 282), '대본을 넣으면 상대역을 읽어 주고,', font=regular, fill=PAPER)
draw.text((x, 332), '내 대사를 들으며 채점해 줘요', font=regular, fill=PAPER)
draw.rounded_rectangle((x, 420, x + 470, 476), radius=28, outline=SPOT, width=3)
draw.text((x + 235, 448), 'PC·휴대폰 브라우저에서 바로', font=small, fill=SPOT, anchor='mm')

img.save('assets/og.png', optimize=True)
print('saved assets/og.png', img.size)
