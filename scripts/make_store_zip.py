# -*- coding: utf-8 -*-
"""生成 Chrome Web Store 上架包：extension/ 打包为项目根 tab-recorder-<版本>.zip。
排除测试页（不得随包上架——审计定下的清单）：e2e-test.html/e2e-page.js/advance-test*。
zip 名称带版本号，重复执行覆盖旧包。

用法：python scripts/make_store_zip.py
"""
import json
import os
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXT = os.path.join(ROOT, "extension")
EXCLUDE = {"e2e-test.html", "e2e-page.js", "advance-test.html", "advance-test-page.js"}


def main():
    manifest = json.load(open(os.path.join(EXT, "manifest.json"), encoding="utf-8"))
    version = manifest["version"]
    out = os.path.join(ROOT, "tab-recorder-%s.zip" % version)

    entries = []
    for dirpath, dirnames, filenames in os.walk(EXT):
        for fn in sorted(filenames):
            if fn in EXCLUDE:
                continue
            full = os.path.join(dirpath, fn)
            arc = os.path.relpath(full, EXT).replace("\\", "/")
            entries.append((full, arc))

    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for full, arc in entries:
            z.write(full, arc)
    print("已生成 %s（%d 个文件）" % (out, len(entries)))
    for _, arc in entries:
        print("  " + arc)


if __name__ == "__main__":
    main()
