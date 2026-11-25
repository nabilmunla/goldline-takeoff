# Build "Goldline-Takeoff-Setup-<version>.exe" (no spaces: GitHub turns a space in a release file's name into a dot):
# the setup program + the whole app (Electron runtime +
# resources\app in the versioned layout) compressed inside it.
#   python3 installer/build.py <electron-v44.5.1-win32-x64.zip> <resources-app-<version>.zip> <outdir> [SHASUMS256.txt]
# The resources-app zip comes from `node tools/make-payload.cjs <out>` (after `npm run build`).
# Needs: Go (cross-compiles for Windows), node with resedit / pe-library / @electron/fuses (npm ci),
# python zstandard (pip install zstandard).
import base64, hashlib, io, json, os, re, shutil, struct, subprocess, sys, tarfile, zipfile
import zstandard

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if len(sys.argv) < 4:
    sys.exit(__doc__ or 'usage: python3 installer/build.py <electron-win32-x64.zip> <resources-app-<version>.zip> <outdir> [SHASUMS256.txt]')
# (absolute: the stub is built from inside installer/)
ez, az, out = (os.path.abspath(a) for a in sys.argv[1:4])
shasums = os.path.abspath(sys.argv[4]) if len(sys.argv) > 4 else None
os.makedirs(out, exist_ok=True)
ver = json.load(open(os.path.join(ROOT, 'package.json')))['version']
m = re.match(r'electron-v([\d.]+)-win32-x64\.zip$', os.path.basename(ez))
assert m, 'the runtime must be electron-v<version>-win32-x64.zip'
runtime = m.group(1)
want_rt = json.load(open(os.path.join(ROOT, 'node_modules', 'electron', 'package.json')))['version']
assert runtime == want_rt, f'runtime zip is {runtime}, the app is built with Electron {want_rt}'
if shasums:
    # the runtime exactly as Electron published it
    h = hashlib.sha256(open(ez, 'rb').read()).hexdigest()
    line = next((l for l in open(shasums) if l.strip().endswith(os.path.basename(ez))), '')
    assert line.split(' ')[0] == h, f'{os.path.basename(ez)} does not match {shasums}'
work = os.path.join(out, '_setup-build')
shutil.rmtree(work, ignore_errors=True)
os.makedirs(work)
ico = os.path.join(HERE, 'app.ico')

# 1. the page of the setup window, with the app's font and logo inside it
html = open(os.path.join(HERE, 'ui.src.html'), encoding='utf-8').read()
font = next(f for f in os.listdir(os.path.join(ROOT, 'dist', 'assets')) if f.startswith('inter-latin-wght-normal'))
html = html.replace('{{INTER}}', base64.b64encode(open(os.path.join(ROOT, 'dist', 'assets', font), 'rb').read()).decode())
html = html.replace('{{LOGO}}', base64.b64encode(open(os.path.join(ROOT, 'dist', 'gmark.svg'), 'rb').read()).decode())
open(os.path.join(HERE, 'ui.html'), 'w', encoding='utf-8').write(html)

# 2. the setup program (Windows, no console window)
stub = os.path.join(work, 'setup.exe')
env = dict(os.environ, GOOS='windows', GOARCH='amd64', CGO_ENABLED='0', GOPROXY='off', GOFLAGS='-mod=mod', GOTOOLCHAIN='local', GOSUMDB='off')
subprocess.run(['go', 'build', '-trimpath', '-ldflags', f'-s -w -H windowsgui -X main.version={ver}', '-o', stub, '.'], cwd=HERE, env=env, check=True)
subprocess.run(['node', os.path.join(HERE, 'patch-res.mjs'), stub, ico, ver, 'Goldline Takeoff Setup', 'Goldline Takeoff Setup.exe', os.path.join(HERE, 'setup.manifest')], cwd=ROOT, check=True)

# 3. the app folder exactly as it will be installed
stage = os.path.join(work, 'app')
with zipfile.ZipFile(ez) as z:
    for mi in z.infolist():
        if mi.is_dir() or mi.filename.endswith('default_app.asar'):
            continue
        # (the same path check as the app zip's below - 0.23.2, DeepSeek #31)
        assert '..' not in mi.filename.replace('\\', '/').split('/') and not mi.filename.startswith(('/', '\\')) and ':' not in mi.filename, mi.filename
        name = 'Goldline Takeoff.exe' if mi.filename == 'electron.exe' else mi.filename
        dst = os.path.join(stage, name)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with z.open(mi) as s, open(dst, 'wb') as d:
            shutil.copyfileobj(s, d)
exe = os.path.join(stage, 'Goldline Takeoff.exe')
subprocess.run(['node', os.path.join(HERE, 'patch-res.mjs'), exe, ico, ver, 'Goldline Takeoff', 'Goldline Takeoff.exe'], cwd=ROOT, check=True)
subprocess.run(['node', os.path.join(HERE, 'fuses.mjs'), exe], cwd=ROOT, check=True)
with zipfile.ZipFile(az) as z:
    for mi in z.infolist():
        if mi.is_dir():
            continue
        assert '..' not in mi.filename.split('/') and not mi.filename.startswith('/'), mi.filename
        dst = os.path.join(stage, 'resources', 'app', mi.filename)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with z.open(mi) as s, open(dst, 'wb') as d:
            shutil.copyfileobj(s, d)
app = os.path.join(stage, 'resources', 'app')
cur = json.load(open(os.path.join(app, 'current.json')))
assert cur['version'] == ver, f'app zip is {cur["version"]}, package.json says {ver}'
assert json.load(open(os.path.join(app, 'package.json')))['main'] == 'boot.cjs'
for f in ['package.json', 'electron/main.cjs', 'electron/preload.cjs', 'electron/boot.cjs', 'dist/index.html']:
    assert os.path.exists(os.path.join(app, 'versions', ver, f)), f

# 4. tar (sorted, plain names) compressed with zstd (long window: the runtime repeats a lot)
files = []
for r, _, fs in os.walk(stage):
    for f in fs:
        files.append(os.path.relpath(os.path.join(r, f), stage).replace(os.sep, '/'))
files.sort()
total = 0
tbuf = io.BytesIO()
with tarfile.open(fileobj=tbuf, mode='w', format=tarfile.GNU_FORMAT) as t:
    for rel in files:
        p = os.path.join(stage, rel)
        ti = tarfile.TarInfo(rel)
        ti.size = os.path.getsize(p)
        ti.mode = 0o644
        ti.mtime = 0
        total += ti.size
        with open(p, 'rb') as f:
            t.addfile(ti, f)
level = int(os.environ.get('SETUP_ZSTD_LEVEL', '19'))
params = zstandard.ZstdCompressionParameters.from_level(level, window_log=27, enable_ldm=True, threads=-1, write_checksum=True)
payload = zstandard.ZstdCompressor(compression_params=params).compress(tbuf.getvalue())
# the setup checks this before it changes anything (a byte changed anywhere in a copy of it)
meta = json.dumps({'version': ver, 'runtime': runtime, 'total': total, 'files': len(files), 'sha256': hashlib.sha256(payload).hexdigest()}).encode()

# 5. program + payload + meta + trailer
setup = os.path.join(out, f'Goldline-Takeoff-Setup-{ver}.exe')
with open(setup, 'wb') as o:
    o.write(open(stub, 'rb').read())
    o.write(payload)
    o.write(meta)
    o.write(struct.pack('<QQ', len(meta), len(payload)))
    o.write(b'GTKSETUP')
shutil.rmtree(work, ignore_errors=True)
print(setup, os.path.getsize(setup) // 1024, 'KB', f'({len(files)} files, {total // 2**20} MB installed, runtime {runtime})')
