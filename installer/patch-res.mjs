// Icon, version details and (for the setup) a manifest in a Windows .exe.
// node installer/patch-res.mjs <exe> <ico> <version> <description> <originalName> [manifest.xml]
import * as ResEdit from 'resedit';
import * as PELibrary from 'pe-library';
import { readFileSync, writeFileSync } from 'node:fs';
const [exePath, icoPath, version, desc, original, manifest] = process.argv.slice(2);
const exe = PELibrary.NtExecutable.from(readFileSync(exePath), { ignoreCert: true });
const res = PELibrary.NtExecutableResource.from(exe);
const ico = ResEdit.Data.IconFile.from(readFileSync(icoPath));
// the exe's own icon group (Electron's is 1; a Go program has none yet)
const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
const gid = groups.length ? groups[0].id : 1;
const glang = groups.length ? groups[0].lang : 1033;
ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, gid, glang, ico.icons.map((i) => i.data));
const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0] || ResEdit.Resource.VersionInfo.createEmpty();
const [a, b, c] = version.split(/[.-]/).map((x) => Number(x) || 0);
vi.setFileVersion(a, b, c, 0, 1033);
vi.setProductVersion(a, b, c, 0, 1033);
vi.setStringValues({ lang: 1033, codepage: 1200 }, {
  FileDescription: desc, ProductName: 'Goldline Takeoff', InternalName: original.replace(/\.exe$/i, ''), OriginalFilename: original,
  CompanyName: 'Goldline', LegalCopyright: '', FileVersion: version, ProductVersion: version,
});
vi.outputToResourceEntries(res.entries);
if (manifest) {
  const xml = readFileSync(manifest, 'utf8').replace(/\{\{VERSION\}\}/g, `${a}.${b}.${c}.0`);
  res.replaceResourceEntry({ type: 24, id: 1, lang: 1033, codepage: 0, bin: new TextEncoder().encode(xml).buffer });
}
res.outputResource(exe);
writeFileSync(exePath, Buffer.from(exe.generate()));
console.log('resources set:', exePath);
