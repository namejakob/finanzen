"""Erzeugt die App-Icons ohne Zusatzpakete (reines Python, PNG per zlib).
Aufruf: python tools/make_icons.py"""
import struct, zlib, os, math

OUT = os.path.join(os.path.dirname(__file__), '..', 'icons')
TOP = (0x3a, 0x8b, 0xea)
BOTTOM = (0x1c, 0x5c, 0xab)
SS = 4  # Supersampling für glatte Kanten

def rr_inside(x, y, x0, y0, x1, y1, r):
    """Liegt (x,y) in einem Rechteck mit runden Ecken?"""
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r

def render(size, full_bleed, glyph_scale):
    px = bytearray()
    corner = 0 if full_bleed else size * 0.225
    # drei Balken, mittig, Höhen aufsteigend
    g = size * glyph_scale
    bw = g * 0.2
    gap = g * 0.12
    total = 3 * bw + 2 * gap
    left = (size - total) / 2
    base = size / 2 + g * 0.36
    heights = [g * 0.38, g * 0.56, g * 0.76]
    bars = []
    for i, h in enumerate(heights):
        x0 = left + i * (bw + gap)
        bars.append((x0, base - h, x0 + bw, base, bw * 0.32))
    for yy in range(size):
        px.append(0)  # Filter-Byte
        for xx in range(size):
            acc = [0.0, 0.0, 0.0, 0.0]
            for sy in range(SS):
                for sx in range(SS):
                    x = xx + (sx + 0.5) / SS
                    y = yy + (sy + 0.5) / SS
                    if not full_bleed and not rr_inside(x, y, 0, 0, size, size, corner):
                        continue
                    t = y / size
                    col = [TOP[k] + (BOTTOM[k] - TOP[k]) * t for k in range(3)]
                    if any(rr_inside(x, y, *b) for b in bars):
                        col = [255, 255, 255]
                    for k in range(3):
                        acc[k] += col[k]
                    acc[3] += 255
            n = SS * SS
            a = acc[3] / n
            if a > 0:
                px += bytes([round(acc[0] / (acc[3] / 255)), round(acc[1] / (acc[3] / 255)), round(acc[2] / (acc[3] / 255)), round(a)])
            else:
                px += bytes([0, 0, 0, 0])
    return bytes(px)

def write_png(path, size, raw):
    def chunk(t, d):
        c = struct.pack('>I', len(d)) + t + d
        return c + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    data = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(data)

for name, size, bleed, scale in [
    ('icon-192.png', 192, False, 0.62),
    ('icon-512.png', 512, False, 0.62),
    ('icon-maskable-512.png', 512, True, 0.46),
    ('apple-touch-icon.png', 180, True, 0.56),
    ('favicon-32.png', 32, False, 0.7),
]:
    write_png(os.path.join(OUT, name), size, render(size, bleed, scale))
    print('ok', name)
