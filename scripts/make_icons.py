# -*- coding: utf-8 -*-
"""生成扩展图标（纯 Python，无第三方依赖）：深色圆角方块 + 白圈红点 REC"""
import os
import struct
import zlib

BG = (28, 32, 44)      # 深蓝灰底
DOT = (229, 72, 77)    # REC 红
RING = (255, 255, 255) # 白圈


def chunk(tag, data):
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def clamp01(v):
    return max(0.0, min(1.0, v))


def render(size, ss=4):
    n = size * ss
    corner = n * 0.22
    r_out = n * 0.30
    r_in = n * 0.215
    cx = cy = (n - 1) / 2

    def cov(dist, edge):
        # 边缘半源像素抗锯齿覆盖度
        return clamp01(edge - dist + 0.5)

    def sq_dist(x, y):
        dx = abs(x - cx) - (n / 2 - corner)
        dy = abs(y - cy) - (n / 2 - corner)
        ax, ay = max(dx, 0.0), max(dy, 0.0)
        return (ax * ax + ay * ay) ** 0.5 + min(max(dx, dy), 0.0) - corner

    src = []
    for y in range(n):
        row = bytearray()
        for x in range(n):
            d_sq = sq_dist(x, y)
            dc = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
            a_bg = cov(d_sq, 0.0)                                # 方块内部
            a_ring = clamp01(cov(dc, r_out) - cov(dc, r_in))      # 白环带
            a_dot = cov(dc, r_in)                                 # 红点
            # 从底到顶合成：底 → 环 → 点
            r = BG[0] * a_bg
            g = BG[1] * a_bg
            b = BG[2] * a_bg
            a = a_bg
            for col, la in ((RING, a_ring), (DOT, a_dot)):
                k = la * (1 - a)
                r += col[0] * k; g += col[1] * k; b += col[2] * k
                a += k
            row += bytes((int(r), int(g), int(b), int(a * 255)))
        src.append(bytes(row))

    # box 降采样 ss×ss -> 1
    out = bytearray()
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            R = G = B = A = 0.0
            for sy in range(ss):
                line = src[y * ss + sy]
                for sx in range(ss):
                    o = (x * ss + sx) * 4
                    a = line[o + 3] / 255.0
                    R += line[o] * a; G += line[o + 1] * a; B += line[o + 2] * a; A += a
            k = ss * ss
            R /= k; G /= k; B /= k; A /= k
            if A <= 0:
                row += b"\x00\x00\x00\x00"
            else:
                row += bytes((min(255, int(R / A)), min(255, int(G / A)), min(255, int(B / A)), min(255, int(A * 255 + 0.5))))
        out += bytes(row)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(bytes(out), 9)) + chunk(b"IEND", b"")


d = r"C:\Users\Admin\.zcode\workspace\default\tab-recorder\icons"
os.makedirs(d, exist_ok=True)
for s in (16, 48, 128):
    p = os.path.join(d, f"icon{s}.png")
    with open(p, "wb") as f:
        f.write(render(s))
    print("written", p)
