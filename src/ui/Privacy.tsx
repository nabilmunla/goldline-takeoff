// What may leave the PC (electron/privacy.cjs): the user count's pop-up and Settings > Privacy, and the
// problem report sent to the developer, with a preview of exactly what is sent. The work is done in
// electron/counter.cjs and reports.cjs; nothing leaves the PC without a receiver (package.json
// "countEndpoint" / "reportEndpoint"; empty in a build that has none: no pop-up, no switch, no button).
import { useEffect, useRef, useState } from 'react';
import { gt, recentErrors, type CountState } from './api';
import { reportContext } from './Update';
import { useEscClose } from './escape';
import { COUNT_TITLE, COUNT_BODY, COUNT_KEEP, COUNT_OFF, COUNT_SWITCH, COUNT_HINT } from './counttext';

/** ask for the report to the developer from anywhere (the problem-report card, Settings) */
export const askWebReport = () => window.dispatchEvent(new Event('gt:report-web'));

/** is there anything to show in Settings: a count switch, a report button (a receiver is set) */
export function usePrivacyAvailable(): { count: boolean; report: boolean } {
  const [a, setA] = useState({ count: false, report: false });
  useEffect(() => {
    let live = true;
    const b = gt();
    if (!b.count || !b.webReport) return;
    void Promise.all([b.count.get().catch(() => null), b.webReport.available().catch(() => false)]).then(([c, r]) => { if (live) setA({ count: !!c?.available, report: !!r }); });
    return () => { live = false; };
  }, []);
  return a;
}

/** the user count's question, once (nothing is sent before it is answered); only with a receiver */
export function CountAsk() {
  const [ask, setAsk] = useState(false);
  const keep = useRef<HTMLButtonElement>(null);
  useEffect(() => { void gt().count?.get().then((c) => setAsk(c.ask)).catch(() => {}); }, []);
  // (the sign-in form under it may have the keyboard: the pop-up takes it, on "Keep it on")
  // (the form under it can mount after it and take the keyboard: it comes back until the pop-up is answered)
  useEffect(() => {
    if (!ask) return;
    keep.current?.focus();
    const back = (e: FocusEvent) => { if (!(e.target as HTMLElement | null)?.closest?.('.count-ask')) keep.current?.focus(); };
    document.addEventListener('focusin', back);
    return () => document.removeEventListener('focusin', back);
  }, [ask]);
  if (!ask) return null;
  const answer = (on: boolean) => { setAsk(false); void gt().count.set(on); };
  return (
    <div className="scrim">
      <div className="modal count-ask" role="dialog" aria-label={COUNT_TITLE}>
        <h2>{COUNT_TITLE}</h2>
        {COUNT_BODY.map((p) => <p key={p} className="sub">{p}</p>)}
        <div className="actions">
          {/* (both the same weight; Keep it on is the default - the shared text's order) */}
          <button className="btn" ref={keep} autoFocus onClick={() => answer(true)}>{COUNT_KEEP}</button>
          <button className="btn" onClick={() => answer(false)}>{COUNT_OFF}</button>
        </div>
      </div>
    </div>
  );
}

/** Settings: Privacy (the user count's switch) and Help (the report to the developer) - each only with a receiver */
export function SettingsDlg({ onClose }: { onClose: () => void }) {
  const [c, setC] = useState<CountState | null>(null);
  const av = usePrivacyAvailable();
  useEffect(() => { void gt().count?.get().then(setC).catch(() => {}); }, []);
  const esc = useEscClose(onClose);
  return (
    <div className="scrim" onKeyDown={esc.onKeyDown} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={esc.box} tabIndex={-1} className="modal" style={{ width: 520, outline: 'none', color: 'var(--text)' }} role="dialog" aria-label="Settings">
        <h2>Settings</h2>
        {c?.available && (
          <div className="row" data-privacy>
            <label>Privacy</label>
            <label className="check">
              <input type="checkbox" checked={c.on} onChange={async (e) => { const on = e.target.checked; setC({ ...c, on }); setC(await gt().count.set(on)); }} />
              <span>{COUNT_SWITCH}</span>
            </label>
            <span className="faint">{COUNT_HINT}</span>
          </div>
        )}
        {av.report && (
          <div className="row">
            <label>Help</label>
            <div><button className="btn sm" onClick={() => { onClose(); askWebReport(); }}>Send a problem report to the developer…</button></div>
            <span className="faint">Anonymous, only when you press Send, and you see exactly what is sent first.</span>
          </div>
        )}
        <div className="actions"><button className="btn primary" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}

/**
 * The report to the developer: the person's words, a preview of exactly what is sent (their user and PC
 * names, folders, project and file names taken out - electron/anon.cjs), and Send. `words`: names the
 * window knows are private (the person, the shared folder), taken out of the report too.
 */
export function WebReport({ words }: { words: string[] }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [shown, setShown] = useState<string | null>(null);
  const [res, setRes] = useState<'sending' | 'sent' | 'failed' | null>(null);
  const [err, setErr] = useState('');
  const wordsRef = useRef(words);
  wordsRef.current = words;
  useEffect(() => {
    const h = () => { setText(''); setShown(null); setRes(null); setErr(''); setOpen(true); };
    window.addEventListener('gt:report-web', h);
    return () => window.removeEventListener('gt:report-web', h);
  }, []);
  // the preview follows the words (a moment after typing stops)
  useEffect(() => {
    if (!open) return;
    let live = true;
    setShown(null);
    const t = setTimeout(() => {
      const ctx = { screen: reportContext.screen, errors: [...recentErrors], words: [...wordsRef.current, ...(reportContext.project ? [reportContext.project] : []), ...(reportContext.projectDir ? [reportContext.projectDir] : [])] };
      void gt().webReport.preview(text, ctx).then((j) => { if (live) setShown(j); }).catch((e) => { if (live) { setErr(String(e?.message ?? e)); } });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [open, text]);
  const close = () => setOpen(false);
  const esc = useEscClose(close, res === 'sending', open);
  if (!open) return null;
  const send = async () => {
    if (shown == null) return;
    setRes('sending');
    setErr('');
    try {
      const r = await gt().webReport.send(shown);
      if (r.state === 'sent') setRes('sent');
      else { setRes('failed'); setErr(r.state === 'changed' ? 'The text changed while it was being sent - look it over and press Send again.' : r.state === 'local' ? 'This version sends no reports.' : 'Not sent' + (r.err ? ' (' + r.err + ')' : '') + ' - is the internet reachable? Nothing was kept; press Send to try again.'); }
    } catch (e) { setRes('failed'); setErr(String((e as Error)?.message ?? e)); }
  };
  return (
    <div className="scrim" onKeyDown={esc.onKeyDown} onMouseDown={(e) => e.target === e.currentTarget && res !== 'sending' && close()}>
      <div ref={esc.box} tabIndex={-1} className="modal wide report-web" style={{ outline: 'none' }} role="dialog" aria-label="Report a problem to the developer">
        <h2>Report a problem to the developer</h2>
        {res === 'sent' ? (
          <>
            <p className="sub">Sent anonymously - thank you.</p>
            <div className="actions"><button className="btn primary" onClick={close}>Close</button></div>
          </>
        ) : (
          <>
            <p className="sub">What went wrong, and what did you expect? The more exact, the faster it gets fixed.</p>
            <textarea className="input report-text" autoFocus maxLength={20000} value={text} onChange={(e) => { setText(e.target.value); setRes(null); }} placeholder="e.g. I measured an area on sheet 3 and the quantity in the BOQ did not change." />
            <p className="faint" style={{ margin: '10px 0 4px' }}>This is exactly what is sent, when you press Send. Your user name, the PC's name, folders, project names and file names are taken out; never a drawing, a price or a BOQ.</p>
            <pre className="anon-example" aria-label="What is sent">{shown ?? 'Preparing…'}</pre>
            {err && <p className="err">{err}</p>}
            <div className="actions">
              <button className="btn" disabled={res === 'sending'} onClick={close}>Cancel</button>
              <button className="btn primary" disabled={res === 'sending' || shown == null || !text.trim()} onClick={() => void send()}>{res === 'sending' ? 'Sending…' : 'Send'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
