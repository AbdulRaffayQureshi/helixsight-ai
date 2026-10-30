import math, struct, sys, zlib
from pathlib import Path

def smooth(x):
    x = 0.0 if x < 0 else 1.0 if x > 1 else x
    return x * x * (3 - 2 * x)

def render(size):
    rows = bytearray()
    turns, amp, w = 1.5, 0.22, 0.045 * size
    aa = 1.6
    for y in range(size):
        rows.append(0)
        for x in range(size):
            u, v = x / size, y / size
            r, g, b = 7.0, 11.0, 20.0
            glow = max(0.0, 1.0 - math.hypot(u - 0.5, v - 0.5) * 1.6)
            r, g, b = r + 10 * glow, g + 26 * glow, b + 44 * glow
            if 0.1 < u < 0.9:
                t = (u - 0.1) / 0.8
                th = 2 * math.pi * turns * t
                c1 = 0.5 + amp * math.sin(th)
                c2 = 0.5 + amp * math.sin(th + 2.2176)
                fade = smooth(min(t, 1 - t) * 12)
                for yc, col, depth in ((c2, (255, 43, 214), math.cos(th + 2.2176)), (c1, (34, 211, 238), math.cos(th))):
                    d = abs(v - yc) * size
                    cov = (1 - smooth((d - w) / aa)) * fade * (0.55 + 0.45 * (depth > 0))
                    r, g, b = r + (col[0] - r) * cov, g + (col[1] - g) * cov, b + (col[2] - b) * cov
                rung = abs(((t * 12) % 1) - 0.5) * (0.8 * size / 12)
                lo, hi = sorted((c1, c2))
                if lo < v < hi and rung < 0.012 * size:
                    cov = fade * 0.55
                    r, g, b = r + (203 - r) * cov, g + (213 - g) * cov, b + (225 - b) * cov
            rows += bytes((int(r), int(g), int(b), 255))
    return bytes(rows)

def png(path, size):
    raw = render(size)
    def chunk(tag, data): return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    Path(path).write_bytes(data)

if __name__ == "__main__":
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "frontend/public/icons")
    out.mkdir(parents=True, exist_ok=True)
    for s in (192, 512):
        target = out / f"icon-{s}.png"
        if not target.exists():
            png(target, s)
            print("wrote", target)
