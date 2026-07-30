import { useEffect, useState } from "react";
import * as api from "../api";

// Nightly workflow, one screen:
//   1. drop in flow_master.xlsx / flow_*_master.xlsx / flow_YYYY-MM-DD.csv
//   2. "Ingest" distills them to flow_cache.json, DELETES the uploads, ranks the
//      book and seeds the observe list
//   3. the observe list re-vets itself daily; READY names get traded automatically

export default function FlowUploadView() {
  const [files, setFiles] = useState<FileList | null>(null);
  const [server, setServer] = useState<any>(null);
  const [obs, setObs] = useState<any>(null);
  const [busy, setBusy] = useState("");
  const [result, setResult] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    try {
      setServer(await api.listFlowFiles());
      setObs(await api.getObserve());
    } catch (e: any) { setErr(String(e.message || e)); }
  }
  useEffect(() => { refresh(); }, []);

  async function doUpload() {
    if (!files?.length) return;
    setErr(null); setResult(null);
    try {
      for (let i = 0; i < files.length; i++) {
        setBusy(`uploading ${files[i].name} (${i + 1}/${files.length})…`);
        await api.uploadFlowFile(files[i]);
      }
      setBusy("ingesting — parsing, deleting uploads, ranking…");
      const r = await api.ingestFlow();
      setResult(r);
      await refresh();
    } catch (e: any) { setErr(String(e.message || e)); }
    finally { setBusy(""); }
  }

  async function doAssess() {
    setBusy("re-assessing observe list…"); setErr(null);
    try { setResult(await api.assessObserve(true)); await refresh(); }
    catch (e: any) { setErr(String(e.message || e)); }
    finally { setBusy(""); }
  }

  async function doDrop(t: string) {
    try { await api.dropObserve(t, "manual"); await refresh(); }
    catch (e: any) { setErr(String(e.message || e)); }
  }

  const active = obs?.active || [];
  const dropped = (obs?.all || []).filter((r: any) => r.status === "DROPPED").slice(-10).reverse();

  return (
    <div className="view">
      <h3>Nightly flow upload</h3>
      <p className="sub" style={{ marginTop: 0 }}>
        Upload the workbooks your scraper produced. They're parsed into a compact cache and
        then <b>deleted</b> — nothing bulky is kept. Ranking and the observe list update automatically;
        you never type a ticker.
      </p>

      <div className="card">
        <div className="row">
          <input type="file" multiple accept=".xlsx,.csv"
            onChange={(e) => setFiles(e.target.files)} />
          <button onClick={doUpload} disabled={!files?.length || !!busy}>
            Upload &amp; ingest
          </button>
          <button onClick={doAssess} disabled={!!busy}>Re-assess now</button>
        </div>
        {busy && <p className="sub">{busy}</p>}
        {err && <p className="err">{err}</p>}
        <p className="sub">
          Expected: <code>flow_master.xlsx</code>, <code>flow_unusual_master.xlsx</code>,
          <code> flow_knows_master.xlsx</code>, and/or <code>flow_YYYY-MM-DD.csv</code>.
          {server?.dir && <> Server dir: <code>{server.dir}</code></>}
        </p>
        {!!(server?.files || []).length && (
          <p className="sub">
            currently on server: {server.files.map((f: any) => `${f.name} (${f.sizeMB}MB)`).join(", ")}
          </p>
        )}
      </div>

      {result && (
        <div className="card" style={{ marginTop: 12 }}>
          <h3>Last run</h3>
          <pre style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>
            {result.filesProcessed
              ? `processed: ${result.filesProcessed.join(", ")}\n`
                + `deleted:   ${(result.filesDeleted || []).join(", ") || "(kept)"}\n`
                + `cache:     ${result.cache ? `${result.cache.tickers} tickers` : "not built"}\n`
                + `ranked:    ${result.discovery?.considered ?? 0} considered, `
                + `${result.discovery?.scanned ?? 0} scanned, ${result.discovery?.qualified ?? 0} qualified\n`
                + `observing: +${(result.observe?.added || []).join(", ") || "none new"}`
                + `${result.discovery?.note ? `\nnote:      ${result.discovery.note}` : ""}`
              : `assessed ${result.assessed}\nready: ${(result.ready || []).join(", ") || "-"}\n`
                + `dropped: ${(result.dropped || []).map((d: any) => `${d.ticker} (${d.reason})`).join("; ") || "-"}`}
          </pre>
        </div>
      )}

      <div className="card" style={{ marginTop: 12 }}>
        <h3>Observe list ({active.length})</h3>
        <p className="sub" style={{ marginTop: 0 }}>
          Found from flow, re-checked every day. <b>READY</b> = flow still valid and Vol Desk still
          CONFIRMED — the trader takes these when the intraday trigger fires. <b>OBSERVING</b> = not
          there yet. Names that decay are dropped automatically.
        </p>
        <table className="tbl">
          <thead><tr>
            <th>ticker</th><th>status</th><th>added</th><th>tier</th><th>seed flow</th>
            <th>last check</th><th>why waiting</th><th></th>
          </tr></thead>
          <tbody>
            {active.map((r: any) => {
              const last = (r.assessments || [])[r.assessments.length - 1];
              return (
                <tr key={r.ticker} className={r.status === "READY" ? "confirmed" : ""}>
                  <td><b>{r.ticker}</b></td>
                  <td>{r.status}</td>
                  <td className="sub">{r.addedOn}</td>
                  <td>{r.seed?.tier || "—"}{r.seed?.tierScore ? ` ${r.seed.tierScore}×` : ""}</td>
                  <td>${((r.seed?.netPremium || 0) / 1000).toFixed(0)}k</td>
                  <td>{last ? `${last.date} ${last.tag || ""} g${last.grade ?? "-"}` : "not yet"}</td>
                  <td style={{ fontSize: 11 }}>{last?.reasons?.join("; ") || (r.status === "READY" ? "all clear" : "")}</td>
                  <td><button onClick={() => doDrop(r.ticker)} title="remove manually">✕</button></td>
                </tr>
              );
            })}
            {!active.length && <tr><td colSpan={8} className="sub">nothing being observed — upload flow to seed it</td></tr>}
          </tbody>
        </table>
      </div>

      {!!dropped.length && (
        <div className="card" style={{ marginTop: 12 }}>
          <h3>Recently dropped</h3>
          <table className="tbl">
            <thead><tr><th>ticker</th><th>dropped</th><th>reason</th></tr></thead>
            <tbody>
              {dropped.map((r: any) => (
                <tr key={r.ticker + r.droppedOn}>
                  <td>{r.ticker}</td><td className="sub">{r.droppedOn}</td>
                  <td style={{ fontSize: 11 }}>{r.dropReason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
