# pad.py <in.png> <out.png> <aspect>: letterboxes a capture to a bezel's screen
# shape (width / height) instead of letting the framer crop it. Top and bottom
# bars take the colour of the capture's own top and bottom rows; with --top the
# whole bar goes on top (the Mac, where the notch sits in it).
import sys
from PIL import Image
src, dst, aspect = sys.argv[1], sys.argv[2], float(sys.argv[3])
s = Image.open(src).convert('RGB')
H = round(s.width / aspect)
if H <= s.height:
    s.save(dst); sys.exit()
c = Image.new('RGB', (s.width, H), s.getpixel((s.width // 2, 2)))
if '--top' in sys.argv:
    c.paste(s, (0, H - s.height))
else:
    c.paste(Image.new('RGB', (s.width, H // 2), s.getpixel((s.width // 2, s.height - 3))), (0, H - H // 2))
    c.paste(s, (0, (H - s.height) // 2))
c.save(dst)
