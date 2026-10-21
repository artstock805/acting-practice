"""휴대폰으로 웹 버전을 여는 QR 코드 생성 (python assets/make_qr.py, qrcode[pil] 필요)"""
import qrcode
from PIL import Image

URL = 'https://acting-practice-160629403411.asia-northeast3.run.app/'

qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_H, box_size=12, border=3)
qr.add_data(URL)
qr.make(fit=True)
img = qr.make_image(fill_color='#17130f', back_color='white').convert('RGBA')

# 가운데에 앱 아이콘 (오류 정정 H라 가려져도 인식됨)
icon = Image.open('assets/acting-practice.png').convert('RGBA')
size = img.width // 5
icon = icon.resize((size, size), Image.LANCZOS)
pad = Image.new('RGBA', (size + 16, size + 16), 'white')
pad.alpha_composite(icon, (8, 8))
img.alpha_composite(pad, ((img.width - pad.width) // 2, (img.height - pad.height) // 2))
img.save('assets/qr-mobile.png')
print('saved assets/qr-mobile.png', img.size)
