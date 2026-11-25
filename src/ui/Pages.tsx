// A new issue of the BOQ: its pages brought in (the BOQ hub's "New issue…").
// (0.23.2, DeepSeek #28: the rest of this file - go to a page, set / renumber pages, the Pages tab - came from the
// estimation app and was never shown in the take-off app: removed)
import { useEffect, useMemo, useRef, useState } from 'react';
import type { BoqModel } from '../engine/boq';
import type { Op, Value } from '../engine/types';
import { billOf } from '../engine/pages';
import { readXlsx } from '../engine/xlsx';
import { analyseFile, tidyFileTitles, type FilePlan } from '../engine/boqimport';
import { issueOps, matchIssue, type IssueUpdate } from '../engine/revise';
import { gt } from './api';
import { IWarn } from './icons';
import { useEscClose } from './escape';

const fmtN = (n: number) => n.toLocaleString('en-US');
const billName = (b: { ref: string; desc: string }) => [b.ref, b.desc].filter(Boolean).join(' ');

export function IssueDialog(p: {
  model: BoqModel;
  store: { get(id: string, f: string): unknown };
  user: string;
  onApply: (ops: Op[], undo: Op[], what: string) => void;
  onReveal: (id: string) => void;
  onClose: () => void;
}) {
  const [files, setFiles] = useState<{ name: string; plan?: FilePlan; error?: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const esc = useEscClose(p.onClose, busy);
  const [refs, setRefs] = useState(true);
  const [qty, setQty] = useState(false);
  const [done, setDone] = useState<{ pages: number; refs: number; qty: number } | null>(null);
  const [show, setShow] = useState<'added' | 'missing' | 'moved' | null>(null);
  const picking = useRef(false);
  const plans = files.filter((f) => f.plan).map((f) => f.plan!);
  const upd: IssueUpdate | null = useMemo(() => (plans.length ? matchIssue(p.model, p.store, plans) : null), [files]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = async () => {
    if (picking.current) return;
    picking.current = true;
    try {
      const paths = await gt().pickFiles({ title: 'Choose the new issue of the BOQ (all its files)' });
      if (!paths.length) { if (!files.length) p.onClose(); return; }
      setBusy(true);
      const out: typeof files = [];
      for (const path of paths) {
        const name = path.split(/[\\/]/).pop() ?? path;
        await new Promise((r) => setTimeout(r, 20));
        try {
          if (/\.xls$/i.test(name)) throw new Error('Old .xls format: save it as .xlsx first.');
          const r = await gt().fs.readFrom(path, 0, 512 * 1024 * 1024);
          if (!r) throw new Error('The file could not be read.');
          out.push({ name, plan: analyseFile(name, readXlsx(r.data)) });
        } catch (err: any) {
          out.push({ name, error: String(err?.message ?? err) });
        }
      }
      tidyFileTitles(out.filter((x) => x.plan).map((x) => x.plan!));
      setFiles(out);
    } finally {
      setBusy(false);
      picking.current = false;
    }
  };
  useEffect(() => { pick(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const stats = useMemo(() => {
    if (!upd) return null;
    const m = upd.matches;
    return {
      matched: m.length,
      page: m.filter((x) => x.pageChanged).length,
      ref: m.filter((x) => x.refChanged).length,
      qty: m.filter((x) => x.qtyChanged).length,
      desc: m.filter((x) => x.descChanged).length,
      moved: m.filter((x) => x.moved).length,
    };
  }, [upd]);

  const apply = () => {
    if (!upd) return;
    const r = issueOps(upd, plans, { refs, qty, by: p.user });
    // what to put back if they change their mind
    const undo: Op[] = [];
    for (const m of upd.matches) {
      const n = m.node;
      undo.push([n.id, 'page', n.page], [n.id, 'pe', n.pageEst || null], [n.id, 'src', n.src]);
      if (refs) undo.push([n.id, 'ref', n.ref]);
      if (qty && n.type === 'item') undo.push([n.id, 'q0', n.q0 as Value], [n.id, 'qty', n.qty as Value]);
    }
    p.onApply(r.ops, undo, 'Pages from a new issue');
    setDone({ pages: r.pages, refs: r.refs, qty: r.qty });
  };

  const moved = upd?.matches.filter((m) => m.moved) ?? [];
  return (
    <div className="scrim" onKeyDown={esc.onKeyDown}>
      <div ref={esc.box} tabIndex={-1} className="modal wide issue">
        <h2>Pages from a new issue</h2>
        <p className="sub">Pick all the files of the consultant’s new issue. Each line of the project is found in it, and takes its <b>page</b> (and item letter). Prices, build-ups and your own quantities stay as they are.</p>
        {busy && <div className="imp-note"><span className="dot busy" /> Reading and matching…</div>}
        {files.some((f) => f.error) && <div className="imp-warn"><IWarn /> {files.filter((f) => f.error).map((f) => `${f.name}: ${f.error}`).join(' · ')}</div>}
        {upd && stats && (
          <>
            <div className="is-pairs">
              {upd.pairs.map((x, k) => (
                <div key={k} className={'is-pair' + (x.bill ? '' : ' none')}>
                  <span className="is-sheet" title={x.file}>{x.sheet}</span>
                  <span className="faint">→</span>
                  <span>{x.bill ? billName(x.bill) : 'not in the project: its lines are new'}</span>
                  <span className="faint r">{fmtN(x.lines)} lines</span>
                </div>
              ))}
            </div>
            <div className="is-stats">
              <span><b>{fmtN(stats.matched)}</b> lines found</span>
              <span className={stats.page ? 'chg' : ''}><b>{fmtN(stats.page)}</b> change page</span>
              <span className={stats.ref ? 'chg' : ''}><b>{fmtN(stats.ref)}</b> change item letter</span>
              {stats.moved > 0 && <button className="linkbtn" onClick={() => setShow(show === 'moved' ? null : 'moved')}><b>{fmtN(stats.moved)}</b> moved to another sheet</button>}
              {stats.desc > 0 && <span title="Kept as they are in the project"><b>{fmtN(stats.desc)}</b> reworded</span>}
              {stats.qty > 0 && <span><b>{fmtN(stats.qty)}</b> with another quantity</span>}
              <button className={'linkbtn' + (upd.added.length ? ' warnc' : '')} onClick={() => setShow(show === 'added' ? null : 'added')}><b>{fmtN(upd.added.length)}</b> new in the issue</button>
              <button className={'linkbtn' + (upd.missing.length ? ' warnc' : '')} onClick={() => setShow(show === 'missing' ? null : 'missing')}><b>{fmtN(upd.missing.length)}</b> not found in it</button>
            </div>
            {show && (
              <div className="pick-list is-list">
                {show === 'added' && upd.added.slice(0, 500).map((l, k) => (
                  <div key={k} className="mt pgrow"><span className="mr pgref">{l.row.page}</span><span className="md"><span className="pp">{l.where}{l.row.ref ? ' · item ' + l.row.ref : ''}</span>{l.row.desc.slice(0, 120)}</span><span className="mc">{l.row.unit}</span></div>
                ))}
                {show === 'missing' && upd.missing.slice(0, 500).map((n) => (
                  <button key={n.id} className="mt pgrow" onClick={() => p.onReveal(n.id)} title="Show it in the BOQ"><span className="mr pgref">{n.page}</span><span className="md"><span className="pp">{billName(billOf(p.model, n))}{n.ref ? ' · item ' + n.ref : ''}</span>{n.desc.slice(0, 120)}</span><span className="mc">{n.unit}</span></button>
                ))}
                {show === 'moved' && moved.slice(0, 500).map((m) => (
                  <button key={m.node.id} className="mt pgrow" onClick={() => p.onReveal(m.node.id)}><span className="mr pgref">{m.line.row.page}</span><span className="md"><span className="pp">now in {m.line.where}</span>{m.node.desc.slice(0, 120)}</span><span className="mc">{m.node.unit}</span></button>
                ))}
                {((show === 'added' && upd.added.length > 500) || (show === 'missing' && upd.missing.length > 500)) && <div className="faint" style={{ padding: 8 }}>First 500 shown.</div>}
              </div>
            )}
            {!done && (
              <div className="is-opts">
                <label className="check"><input type="checkbox" checked={refs} onChange={(e) => setRefs(e.target.checked)} /> Item letters / numbers too</label>
                <label className="check" title="The consultant's quantity follows the new issue; a quantity you typed over it stays"><input type="checkbox" checked={qty} onChange={(e) => setQty(e.target.checked)} /> Quantities too</label>
              </div>
            )}
            {done && <div className="is-done">Done: {fmtN(done.pages)} pages, {fmtN(done.refs)} item letters{done.qty ? `, ${fmtN(done.qty)} quantities` : ''} updated. New and missing lines are listed above; nothing was added or removed.</div>}
          </>
        )}
        <div className="actions">
          {!done && <button className="btn" onClick={pick} disabled={busy}>Pick other files…</button>}
          <span className="grow" />
          <button className="btn" onClick={p.onClose}>{done ? 'Close' : 'Cancel'}</button>
          {!done && (() => {
            const n = upd ? upd.matches.filter((x) => x.pageChanged || (refs && x.refChanged) || (qty && x.qtyChanged)).length : 0;
            return <button className="btn primary" disabled={!upd || !n} onClick={apply}>{!upd ? 'Update' : n ? `Update ${fmtN(n)} line${n === 1 ? '' : 's'}` : 'Nothing to update'}</button>;
          })()}
        </div>
      </div>
    </div>
  );
}
