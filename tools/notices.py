#!/usr/bin/env python3
# Writes THIRD-PARTY-NOTICES.txt (the repository root: LF) and public/THIRD-PARTY-NOTICES.txt (copied into
# dist/ by vite: it ships with the app and with every update: CRLF, for Notepad): Goldline Takeoff's own
# licence and the licence of every open-source part inside it. Run again when a part is added or updated:
#   python3 tools/notices.py
import json, os, re, subprocess, sys
R = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
def ver(m):
    return json.load(open(os.path.join(R, 'node_modules', m, 'package.json')))['version']
def text(*p):
    return open(os.path.join(R, *p), encoding='utf-8', errors='replace').read().strip()
goroot = subprocess.run(['go', 'env', 'GOROOT'], capture_output=True, text=True).stdout.strip()
parts = [
  # (name, what for, licence, [licence files])
  (f"MuPDF (mupdf.js {ver('mupdf')})", 'simplifying the line work of monster sheets (a background job only)', 'GNU Affero General Public License v3 or later', [('node_modules', 'mupdf', 'LICENSE')]),
  (f"PDFium (in @embedpdf/pdfium {ver('@embedpdf/pdfium')})", 'drawing sheets, their text and line work (snapping)', 'BSD-3-Clause / Apache-2.0', [('node_modules', '@embedpdf/pdfium', 'LICENSE.pdfium')]),
  (f"@embedpdf/pdfium {ver('@embedpdf/pdfium')}", 'PDFium built for WebAssembly', 'MIT', [('node_modules', '@embedpdf/pdfium', 'LICENSE')]),
  (f"React, React DOM {ver('react')}, Scheduler {ver('scheduler')}", 'the interface', 'MIT', [('node_modules', 'react', 'LICENSE')]),
  (f"fflate {ver('fflate')}", 'reading and writing Excel files, backups, pictures turned into PDFs', 'MIT', [('node_modules', 'fflate', 'LICENSE')]),
  (f"fractional-indexing {ver('fractional-indexing')}", 'the order of rows', 'CC0-1.0 (public domain)', [('node_modules', 'fractional-indexing', 'LICENSE')]),
  (f"Inter (font, @fontsource-variable/inter {ver('@fontsource-variable/inter')})", 'interface font', 'SIL Open Font License 1.1', [('node_modules', '@fontsource-variable/inter', 'LICENSE')]),
  (f"polygon-clipping {ver('polygon-clipping')}", 'where drop panels lie under a slab (its soffit formwork)', 'MIT', [('node_modules', 'polygon-clipping', 'LICENSE.md')]),
  (f"splaytree {ver('splaytree')}", 'used by polygon-clipping', 'MIT', [('tools', 'licences', 'splaytree-LICENSE.txt')]),
  (f"robust-predicates {ver('robust-predicates')}", 'used by polygon-clipping', 'Unlicense (public domain)', [('node_modules', 'robust-predicates', 'LICENSE')]),
  (f"Electron {ver('electron')} (Chromium, Node.js)", 'the app runtime', 'MIT (Electron); Chromium and Node.js: LICENSE and LICENSES.chromium.html in the app folder', [('node_modules', 'electron', 'LICENSE')]),
  ('Goldline Takeoff Setup: Go standard library', 'installer and updater', 'BSD-3-Clause', [(goroot, 'LICENSE')] if goroot else []),
  ('Goldline Takeoff Setup: golang.org/x/sys', 'Windows functions', 'BSD-3-Clause', [('installer', 'third_party', 'sys', 'LICENSE')]),
  ('Goldline Takeoff Setup: go-webview2', 'the setup window', 'MIT', [('installer', 'third_party', 'go-webview2', 'LICENSE')]),
  ('Goldline Takeoff Setup: go-winloader', 'loading WebView2Loader', 'MIT', [('installer', 'third_party', 'go-winloader', 'LICENSE.md')]),
  ('Goldline Takeoff Setup: WebView2Loader (Microsoft)', 'starting Edge WebView2', 'Microsoft WebView2 SDK licence (BSD-style)', [('installer', 'third_party', 'go-webview2', 'webviewloader', 'sdk', 'LICENSE.txt')]),
  ('Goldline Takeoff Setup: klauspost/compress', 'unpacking the app', 'BSD-3-Clause / Apache-2.0 / MIT parts', [('installer', 'third_party', 'compress', 'LICENSE')]),
]
# every package the app code imports (src/, electron/) is shipped inside the app, so it needs its entry above
# (a new one added without it stops here, instead of going out with its notice missing)
COVERED = {'mupdf', '@embedpdf/pdfium', 'react', 'react-dom', 'fflate', 'fractional-indexing', 'polygon-clipping', '@fontsource-variable/inter', 'electron'}
used = set()
for d in ('src', 'electron'):
    for r, _, fs in os.walk(os.path.join(R, d)):
        for f in fs:
            if f.endswith(('.ts', '.tsx', '.cjs', '.mjs', '.js')):
                t = open(os.path.join(r, f), encoding='utf-8', errors='replace').read()
                for m in re.finditer(r"""(?:from|require\(|import\()\s*['"]([^./'"][^'"]*)['"]""", t):
                    q = m.group(1)
                    if q.startswith('node:'):
                        continue
                    q = '/'.join(q.split('/')[:2]) if q.startswith('@') else q.split('/')[0]
                    # (only what is really a package of node_modules: a string like '%PDF-' after "from" is not)
                    if os.path.isfile(os.path.join(R, 'node_modules', q, 'package.json')):
                        used.add(q)
missing = sorted(used - COVERED)
if missing:
    sys.exit('notices.py: no licence entry for ' + ', '.join(missing) + ' - add it to the list')
out = ["GOLDLINE TAKEOFF - LICENCES", "===========================",
  "Goldline Takeoff is free software: you can redistribute it and/or modify it under the terms of the",
  "GNU Affero General Public License as published by the Free Software Foundation, version 3 or",
  "(at your option) any later version (the LICENSE file). It comes WITHOUT ANY WARRANTY.", "",
  "It is built on the open-source parts listed below; each keeps its own licence. MuPDF is licensed",
  "under the AGPL v3 or later, so anyone who passes a copy of Goldline Takeoff on must also make its",
  "complete source code available under the same licence. The source code of every version is at",
  "https://github.com/nabilmunla/goldline-takeoff (and as source-v<version>.zip with each release).", "",
  "PARTS", "-----"]
for n, w, l, _ in parts:
    out += [f"- {n}: {w}.", f"  Licence: {l}"]
out += ["", "", "LICENCE TEXTS", "============="]
for n, w, l, fs in parts:
    for f in fs:
        out += ["", "-" * 78, n, "-" * 78, "", text(*f)]
body = '\n'.join(out) + '\n'
open(os.path.join(R, 'THIRD-PARTY-NOTICES.txt'), 'w', encoding='utf-8', newline='\n').write(body)
open(os.path.join(R, 'public', 'THIRD-PARTY-NOTICES.txt'), 'w', encoding='utf-8', newline='\r\n').write(body)
print('wrote THIRD-PARTY-NOTICES.txt and public/THIRD-PARTY-NOTICES.txt', len(body.encode('utf-8')), 'bytes')
