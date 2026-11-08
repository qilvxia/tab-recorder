# -*- coding: utf-8 -*-
"""check_mirror.py — 识别规则镜像一致性校验（审计 M3，v2.8.22）

识别规则在多处手工镜像（历史上发生过 v2.8.6→v2.8.7 diag_bili 漏改）：
  ① ACTIVE_SELS    content-detect.js ↔ diag_bili.py（逐元素有序比对）
  ② NOISE_PATTERNS  content-detect.js ↔ offscreen.js ↔ diag_bili.py（正则源串集合比对）
  ③ GENERIC_WORDS   content-detect.js ↔ diag_bili.py（词表集合比对）
任一不一致即非零退出并打印差异项。改识别规则时必须同步三处，本脚本是守门员。

用法：python scripts/check_mirror.py
"""
import io
import re
import sys
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read(p):
    return io.open(os.path.join(ROOT, p), encoding="utf-8").read()


def extract_array(src, name):
    """提取 JS `const NAME = [ ... ];` 数组的字符串元素列表（支持单引号/双引号）。"""
    m = re.search(r"const\s+" + name + r"\s*=\s*\[(.*?)\];", src, re.S)
    if not m:
        raise SystemExit("未找到 %s 数组声明" % name)
    return re.findall(r"'([^']*)'|\"([^\"]*)\"", m.group(1))


def norm_array(items):
    return [a if a else b for (a, b) in items]


def extract_noise(src, tag):
    """提取 NOISE_PATTERNS 的正则字面量源串列表（/…/ 形式，忽略注释）。"""
    m = re.search(r"const\s+NOISE_PATTERNS\s*=\s*\[(.*?)\];", src, re.S)
    if not m:
        raise SystemExit("未找到 NOISE_PATTERNS（%s）" % tag)
    body = re.sub(r"//[^\n]*", "", m.group(1))  # 去行注释
    return re.findall(r"/([^/\n]+?)/[a-z]*\s*,", body + ",")


def extract_generic(src, tag):
    """提取 GENERIC_WORDS Set 的全部字符串字面量。"""
    m = re.search(r"GENERIC_WORDS\s*=\s*new Set\(\[(.*?)\]\)", src, re.S)
    if not m:
        if "GENERIC" in src:  # diag_bili 是普通 Set 构造
            m = re.search(r"const GENERIC\s*=\s*new Set\(\[(.*?)\]\)", src, re.S)
        if not m:
            raise SystemExit("未找到 GENERIC_WORDS（%s）" % tag)
    return set(re.findall(r'"([^"]+)"', m.group(1)))


def main():
    det = read("extension/content-detect.js")
    off = read("extension/offscreen.js")
    bili = read("scripts/diag_bili.py")
    fails = []

    # ① ACTIVE_SELS：content-detect ↔ diag_bili（有序逐元素）
    a1 = norm_array(extract_array(det, "ACTIVE_SELS"))
    a2 = norm_array(extract_array(bili, "ACTIVE_SELS"))
    if a1 != a2:
        fails.append("ACTIVE_SELS 不一致：content-detect=%r diag_bili=%r" % (a1, a2))
    else:
        print("PASS: ACTIVE_SELS %d 项一致（content-detect ↔ diag_bili）" % len(a1))

    # ② NOISE_PATTERNS：三方（集合）
    n1, n2, n3 = extract_noise(det, "content-detect"), extract_noise(off, "offscreen"), extract_noise(bili, "diag_bili")
    if not (n1 == n2 == n3):
        fails.append("NOISE_PATTERNS 不一致：content-detect=%r offscreen=%r diag_bili=%r" % (n1, n2, n3))
    else:
        print("PASS: NOISE_PATTERNS %d 条一致（三方）" % len(n1))

    # ③ GENERIC_WORDS：content-detect ↔ diag_bili（集合）
    g1, g2 = extract_generic(det, "content-detect"), extract_generic(bili, "diag_bili")
    if g1 != g2:
        fails.append("GENERIC_WORDS 不一致：仅 content-detect=%r 仅 diag_bili=%r"
                     % (sorted(g1 - g2), sorted(g2 - g1)))
    else:
        print("PASS: GENERIC_WORDS %d 词一致（content-detect ↔ diag_bili）" % len(g1))

    if fails:
        print("\n".join(["FAIL: " + f for f in fails]))
        print("MIRROR: FAIL —— 改识别规则必须同步三处镜像！")
        sys.exit(1)
    print("MIRROR: PASS")


if __name__ == "__main__":
    main()
