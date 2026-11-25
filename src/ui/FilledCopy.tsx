// v0.16.2 "Filled copy": the consultant's own Excel BOQ with the take-off quantities written in, as a NEW file
// (engine/boqfill.ts). Never into an existing file: a name that is already there is refused.
import { useState } from 'react';
import { gt } from './api';
import { Modal } from './takeoff/Dialogs';
import { fillWorkbook, filledName, type FillResult, type FillTarget } from '../engine/boqfill';

const base = (p: string) => p.split(/[\\/]/).pop() ?? p;
const dirOf = (p: string) => { const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')); return i > 0 ? p.slice(0, i) : ''; };

type Done = { file: string; out: string; r: FillResult };

export function FilledCopyDialog({ targets, from, note, onClose }: {
  targets: FillTarget[];
  /** combined: every take-off on the BOQ added up · takeoff: what this take-off project measured */
  from: 'combined' | 'takeoff';
  /** said above the files (a take-off that could not be read) */
  note?: string;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<Done[]>([]);
  const make = async (t: FillTarget) => {
    if (busy) return;
    setErr(null);
    const picked = (await gt().pickFiles({ title: `The consultant's file: ${t.file.name}` }))[0];
    if (!picked) return;
    if (/\.xls$/i.test(picked)) { setErr('That is the old .xls format. Open it in Excel, Save As .xlsx, and pick that file.'); return; }
    if (!/\.(xlsx|xlsm)$/i.test(picked)) { setErr('Pick the consultant\'s Excel file (.xlsx or .xlsm).'); return; }
    setBusy(t.key);
    try {
      const bytes = await gt().files.readBytes(picked);
      if (!bytes) throw new Error('That file could not be read.');
      const r = fillWorkbook(bytes, t);
      if (!r.filled && !r.added) throw new Error(r.skipped.length ? `None of its rows holds the lines imported from ${t.file.name} (is it the same file?). Nothing was written.` : 'Nothing is measured on these lines yet. Nothing was written.');
      const out = await gt().saveFile({ title: 'Save the filled copy', name: filledName(base(picked)), dir: dirOf(picked), filters: [{ name: 'Excel workbook', extensions: [picked.toLowerCase().endsWith('.xlsm') ? 'xlsm' : 'xlsx'] }] });
      if (!out) return;
      // never into an existing file - the consultant's own or an earlier copy
      if (await gt().files.stat(out)) throw new Error(`${base(out)} is already there. Goldline Takeoff never writes over a file: give the copy another name.`);
      await gt().files.writeBytes(out, r.bytes);
      setDone((d) => [...d.filter((x) => x.file !== t.key), { file: t.key, out, r }]);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally { setBusy(null); }
  };
  return (
    <Modal title="Filled copy of the consultant's BOQ" onClose={onClose} sub={<>
      A new copy of the consultant's own Excel file with <b>Measured Qty</b> and <b>Difference</b> added after the last used column, and the lines their BOQ doesn't have on a sheet of their own. Their file is never changed.
      {' '}{from === 'combined' ? 'Quantities: every take-off on this BOQ added up.' : 'Quantities: what this take-off measured.'}{note ? <><br /><span className="warn">{note}</span></> : null}
    </>}>
      <div className="fillrows" data-fillcopy>
        {targets.map((t) => {
          const measured = t.lines.filter((l) => l.qs !== null).length;
          const d = done.find((x) => x.file === t.key);
          return (
            <div key={t.key} className="fillrow">
              <div className="grow">
                <b>{t.file.name}</b>
                <div className="faint">{t.lines.length} line{t.lines.length === 1 ? '' : 's'} from it · {measured} measured{t.adds.length ? ` · ${t.adds.length} not in their BOQ` : ''}</div>
                {d && (
                  <div className="filldone" data-filldone>
                    Saved {base(d.out)}: {d.r.filled} filled, {d.r.blank} not measured (blank){d.r.added ? `, ${d.r.added} on “${d.r.addSheet}”` : ''}.
                    {d.r.skipped.length > 0 && <div className="warn">{d.r.skipped.length} line{d.r.skipped.length === 1 ? '' : 's'} left out: {d.r.skipped.slice(0, 4).map((s) => `${s.sheet} row ${s.row}${s.ref ? ` (${s.ref})` : ''}`).join(', ')}{d.r.skipped.length > 4 ? '…' : ''} — {d.r.skipped[0].why}.</div>}
                    {' '}<button className="btn sm ghost" onClick={() => gt().openPath(d.out)}>Open it</button>
                  </div>
                )}
              </div>
              {/* (not disabled while busy: a disabled button lets the keyboard go, and Esc no longer closes the dialog) */}
              <button className="btn primary sm" aria-busy={!!busy} data-fillpick onClick={() => make(t)}>{busy === t.key ? 'Writing…' : d ? 'Again…' : 'Pick their file…'}</button>
            </div>
          );
        })}
        {!targets.length && <div className="faint">No line of this BOQ came from an Excel file (it was not imported), so there is nothing to fill.</div>}
      </div>
      {err && <div className="err" data-fillerr>{err}</div>}
      <div className="actions"><button className="btn" onClick={onClose}>Close</button></div>
    </Modal>
  );
}
