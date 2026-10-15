#!/usr/bin/env python3
"""Turn the exported artifact page into public/index.html for the self-hosted site.

Usage: python3 -I scripts/port.py <path to exported index.html>
"""
import re
import sys
from pathlib import Path

src = Path(sys.argv[1]).read_text(encoding="utf-8")
out_path = Path(__file__).resolve().parent.parent / "public" / "index.html"


def replace_once(s, old, new, label):
    n = s.count(old)
    assert n == 1, f"{label}: expected 1 match, found {n}"
    return s.replace(old, new)


# 1. The artifact wrapper puts <title> and the font links in <body>. Build a proper head.
m = re.match(r"<!doctype html><html><head>(.*?)</head><body>\n", src, re.S)
assert m, "unexpected wrapper"
base_head = m.group(1)
rest = src[m.end():]

# pull the title + font links + main style off the top of the body
head_bits = re.match(
    r'<title>[^<]*</title>\n(<link rel="preconnect"[^\n]*\n<link rel="preconnect"[^\n]*\n<link rel="stylesheet"[^\n]*\n)', rest)
assert head_bits, "title/font block not where expected"
font_links = head_bits.group(1)
rest = rest[head_bits.end():]

head = (
    "<!doctype html>\n<html lang=\"en\">\n<head>\n"
    + base_head.replace("<meta charset=utf8>", '<meta charset="utf-8">')
    + "\n<title>Bubble Sheet</title>\n"
    "<meta name=\"description\" content=\"ACT practice with real timers, a bubble sheet, and Claude-checked explanations.\">\n"
    "<meta name=\"theme-color\" content=\"#f3f4f1\">\n"
    "<link rel=\"icon\" href=\"/favicon.svg\" type=\"image/svg+xml\">\n"
    + font_links
    + "</head>\n<body>\n"
)

# 2. Load the runtime shim before the app script.
rest = replace_once(rest, "</footer>\n<script>\n", "</footer>\n<script src=\"/runtime.js\"></script>\n<script>\n", "shim injection")

# 3. Wording that referred to the Claude account.
rest = replace_once(
    rest,
    '"Your scores and mistakes are saved to your Claude account, so they follow you to any device."',
    '"Your scores and mistakes are saved to this site under your sync code, so they can follow you to any device."',
    "settings copy")
rest = replace_once(rest, '"Saving to your account"', '"Saving to the cloud"', "who label")

# 4. Add a sync-code panel to Settings.
sync_panel = '''    h("div", { class: "panel" },
      h("h2", {}, "Use this on another device"),
      h("p", { class: "muted" }, Store.mode === "cloud"
        ? "Open the link below on another phone or computer and your scores, mistakes and quizzes will show up there too. Keep it private: anyone with the link can see your progress."
        : "Cloud saving is not set up on this site, so progress stays in this browser."),
      Store.mode === "cloud" ? h("div", { class: "row" },
        h("input", { type: "text", readonly: true, class: "mono", value: window.BSP ? window.BSP.syncLink() : "", style: "max-width:520px", onclick: e => e.target.select() }),
        h("button", { class: "btn sm", onclick: async e => { try { await navigator.clipboard.writeText(window.BSP.syncLink()); toast("Link copied"); } catch { toast("Select the link and copy it"); } } }, "Copy link")) : null,
      window.BSP && window.BSP.ownerMode() ? h("p", { class: "small" }, h("span", { class: "chip star" }, "Owner mode"), " ",
        h("button", { class: "btn sm ghost", onclick: () => { window.BSP.leaveOwnerMode(); toast("Owner mode off"); go("settings"); } }, "Turn off")) : null),
'''
rest = replace_once(
    rest,
    '    h("div", { class: "panel" },\n      h("h2", {}, "Start over"),',
    sync_panel + '    h("div", { class: "panel" },\n      h("h2", {}, "Start over"),',
    "sync panel")

out = head + rest
out_path.write_text(out, encoding="utf-8")
print(f"wrote {out_path} ({len(out):,} bytes)")
