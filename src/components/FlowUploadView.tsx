import { useEffect, useState } from "react";
import * as api from "../api";

// This tab adapts to how the app is running, because the two modes have genuinely
// different workflows and showing the wrong one is confusing (and was mildly
// dangerous — an "Upload & ingest" button next to your accumulated masters).
//
//   LOCAL  (npm start)  the scraper writes flow_master.xlsx here itself and the
//                       watcher ingests automatically, so the tab leads with status
//                       + a manual rebuild. File import stays available as a normal
//                       section — flow can legitimately arrive from another machine
//                       or another source — and nothing is ever deleted here.
//   CLOUD  (Render)     no browser, so you upload the workbooks your local scraper
//                       produced; they're parsed to a cache and then deleted.

export default function FlowUploadView() {
  const [files, setFiles] = useState<FileList | null>(null);
  const [server, setServer] = useState<any>(null);
  const [local, setLocal] = useState<any>(null);
  const [obs, setObs] = useState<any>(null);
  const [busy, setBusy] = useState("");
  const [diag, setDiag] = useState<any>(null);
  const [result, setResult] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    try {
      setServer(await api.listFlowFiles());
      setObs(await api.getObserve());
      try { setLocal(await api.getLocal()); } catch { setLocal({ enabled: false }); }
    } catch (e: any) { setErr(String(e.message || e)); }
  }
  useEffect(() => { refresh(); const t = setInterval(refresh, 20000); return () => clearInterval(t); }, []);

  const isLocal = local?.enabled === true;

  async function doUpload() {
    if (!files?.length) return;
    setErr(null); setResult(null);
    try {
      for (let i = 0; i < files.length; i++) {
        setBusy(`importing ${files[i].name} (${i + 1}/${files.length})…`);
        await api.uploadFlowFile(files[i]);
      }
      setBusy("parsing, ranking, seeding the observe list…");
      setResult(await api.ingestFlow());
      await refresh();
    } catch (e: any) { setErr(String(e.message || e)); }
    finally { setBusy(""); }
  }

  async function doRebuild() {
    setBusy("re-reading master workbooks…"); setErr(null); setResult(null);
    try { setResult({ rebuild: await api.localRebuild() }); await refresh(); }
    catch (e: any) { setErr(String(e.message || e)); }
    finally { setBusy(""); }
  }

  async function doAssess() {
    setBusy("re-assessing observe list…"); setErr(null);
    try { setResult(await api.assessObserve(true)); await refresh(); }
    catch (e: any) { setErr(String(e.message || e)); }
    finally { setBusy(""); }
  }

  async function doDiag() {
    setBusy("running diagnostics (~30s)…"); setErr(null); setDiag(null);
    try { setDiag(await api.runDiagnostics()); }
    catch (e: any) { setErr(String(e.message || e)); }
    finally { setBusy(""); }
  }

  async function doDrop(t: string) {
    try { await api.dropObserve(t, "manual"); await refresh(); }
    catch (e: any) { setErr(String(e.message || e)); }
  }

  const active = obs?.active || [];
  const dropped = (obs?.all || []).filter((r: any) => r.status === "DROPPED").slice(-10).reverse();
  const masters = (server?.files || []).filter((f: any) => /master\.xlsx$/i.test(f.name));
  const cache = (server?.files || []).find((f: any) => f.name === "flow_cache.json");

  return (
    <div className="view">
      {/* ---------------- LOCAL ---------------- */}
      {isLocal ? (
        <>
          <h3>Flow — automatic</h3>
          <p className="sub" style={{ marginTop: 0 }}>
            The scraper runs inside this app and writes the workbooks itself.
            <b> You don't upload anything.</b> After the close it folds the day into
            <code> flow_master.xlsx</code>, rebuilds the cache, and the observe list reseeds on its own.
          </p>

          <div className="card" style={{ borderLeft: `4px solid ${local.scraperRunning ? "#1b7f3b" : "#c77700"}` }}>
            <div className="row">
              <b>{local.scraperRunning ? "✓ Scraper running" : local.scraperDisabled
                ? "Scraper disabled (LOCAL_SCRAPER=off)"
                : "Scraper idle — outside 09:25–16:40 ET, or starting up"}</b>
              {local.scraperPid ? <span className="sub">pid {local.scraperPid}</span> : null}
            </div>
            <div className="sub">
              flow folder: <code>{local.flowDir}</code><br />
              watching for cache changes: {local.watching ? "yes" : "no"} ·
              last auto-ingest: {local.lastAutoIngest ? new Date(local.lastAutoIngest).toLocaleString() : "not yet"}
            </div>
            {local.wakelock && (
              <div className="sub">
                sleep prevention: {local.wakelock.held ? `held (${local.wakelock.mode})` : `NOT held — ${local.wakelock.note}`}
              </div>
            )}
          </div>

          <div className="card" style={{ marginTop: 12 }}>
            <h3>Flow data on disk</h3>
            {masters.length ? (
              <table className="tbl">
                <thead><tr><th>file</th><th>size</th><th>updated</th></tr></thead>
                <tbody>
                  {masters.map((f: any) => (
                    <tr key={f.name}>
                      <td>{f.name}</td><td>{f.sizeMB} MB</td>
                      <td className="sub">{new Date(f.modified).toLocaleString()}</td>
                    </tr>
                  ))}
                  {cache && (
                    <tr className="confirmed">
                      <td>{cache.name} <span className="sub">(what the bot reads)</span></td>
                      <td>{cache.sizeMB} MB</td>
                      <td className="sub">{new Date(cache.modified).toLocaleString()}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            ) : (
              <p className="sub">
                No master workbooks yet — they're created after the first close.
                {cache ? " A cache exists, so discovery can already run." : ""}
              </p>
            )}
            <div className="row" style={{ marginTop: 8 }}>
              <button onClick={doRebuild} disabled={!!busy}>Re-read masters now</button>
              <button onClick={doAssess} disabled={!!busy}>Re-assess observe list</button>
              <button onClick={doDiag} disabled={!!busy}>Why nothing found?</button>
            </div>
            <p className="sub">
              Masters are your accumulated history and are <b>never deleted</b> in local mode.
              They're also re-read automatically on every startup.
            </p>
          </div>

          {/* Import stays a normal, visible section — flow can legitimately come
              from elsewhere (another machine, a friend's export, a manual pull). */}
          <div className="card" style={{ marginTop: 12 }}>
            <h3>Import flow from elsewhere</h3>
            <p className="sub" style={{ marginTop: 0 }}>
              Optional — the local scraper already feeds this. Use it to bring in masters or day-CSVs
              from another machine or another source. Files land in the flow folder above and are
              ingested immediately; <b>nothing is deleted</b> in local mode.
            </p>
            <div className="row">
              <input type="file" multiple accept=".xlsx,.csv"
                onChange={(e) => setFiles(e.target.files)} />
              <button onClick={doUpload} disabled={!files?.length || !!busy}>Import &amp; ingest</button>
            </div>
            <p className="sub">
              Heads-up: a file with the same name as an existing master <b>replaces</b> it. If you
              mean to merge rather than replace, back up <code>flow_master.xlsx</code> first.
            </p>
          </div>
        </>
      ) : (
        /* ---------------- CLOUD ---------------- */
        <>
          <h3>Nightly flow upload</h3>
          <p className="sub" style={{ marginTop: 0 }}>
            This instance has no scraper, so upload the workbooks your local scraper produced.
            They're parsed into a compact cache and then <b>deleted</b> — only the cache is kept.
          </p>
          <div className="card">
            <div className="row">
              <input type="file" multiple accept=".xlsx,.csv"
                onChange={(e) => setFiles(e.target.files)} />
              <button onClick={doUpload} disabled={!files?.length || !!busy}>Upload &amp; ingest</button>
              <button onClick={doAssess} disabled={!!busy}>Re-assess now</button>
              <button onClick={doDiag} disabled={!!busy}>Why nothing found?</button>
            </div>
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
        </>
      )}

      {busy && <p className="sub">{busy}</p>}
      {err && <p className="err">{err}</p>}

      {result && (
        <div className="card" style={{ marginTop: 12 }}>
          <h3>Last run</h3>
          <pre style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>
            {result.rebuild
              ? `rebuild: ${result.rebuild.ok ? "ok" : "no masters found"}\ndir: ${result.rebuild.dir}\n${result.rebuild.note}`
              : result.filesProcessed
                ? `processed: ${result.filesProcessed.join(", ")}\n`
                  + `deleted:   ${(result.filesDeleted || []).length ? result.filesDeleted.join(", ") : "(kept)"}\n`
                  + (result.keptReason ? `           ${result.keptReason}\n` : "")
                  + `cache:     ${result.cache ? `${result.cache.tickers} tickers` : "not built"}\n`
                  + `ranked:    ${result.discovery?.considered ?? 0} considered, ${result.discovery?.scanned ?? 0} scanned\n`
                  + `tags:      ${Object.entries(result.discovery?.tagCounts || {}).map(([k, v]) => `${v} ${k}`).join(", ") || "n/a"}\n`
                  + `tradeable: ${result.discovery?.qualified ?? 0} (CONFIRMED today)\n`
                  + `watchable: ${result.discovery?.watch ?? 0} (CONFIRMED + PENDING)\n`
                  + `observing: +${(result.observe?.added || []).join(", ") || "none new"}`
                  + `${result.discovery?.note ? `\nnote:      ${result.discovery.note}` : ""}`
                : `assessed ${result.assessed}\nready: ${(result.ready || []).join(", ") || "-"}\n`
                  + `dropped: ${(result.dropped || []).map((d: any) => `${d.ticker} (${d.reason})`).join("; ") || "-"}`}
          </pre>
        </div>
      )}

      {diag && (
        <div className="card" style={{ marginTop: 12,
          borderLeft: `4px solid ${diag.verdict === "healthy" ? "#1b7f3b" : "#b3261e"}` }}>
          <h3>Diagnosis: {diag.verdict}</h3>
          <p className="sub" style={{ marginTop: 0 }}>{diag.explain}</p>
          <table className="tbl">
            <thead><tr><th>check</th><th></th><th>detail</th></tr></thead>
            <tbody>
              {(diag.steps || []).map((s: any) => (
                <tr key={s.name} className={s.ok ? "" : "blocked"}>
                  <td>{s.name}</td><td>{s.ok ? "✓" : "✗"}</td>
                  <td style={{ fontSize: 11 }}>{s.detail}{s.hint ? ` — ${s.hint}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {diag.funnel && (
            <p className="sub">
              funnel: {diag.funnel.considered} considered → {diag.funnel.scanned} scanned → {diag.funnel.qualified} qualified
              {!!(diag.funnel.rejected || []).length &&
                ` · rejected: ${diag.funnel.rejected.map((r: any) => `${r.ticker}(${r.tag})`).join(", ")}`}
            </p>
          )}
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
            <th>ticker</th><th>side</th><th>status</th><th>added</th><th>tier</th>
            <th>seed flow</th><th>last check</th><th>why waiting</th><th></th>
          </tr></thead>
          <tbody>
            {active.map((r: any) => {
              const last = (r.assessments || [])[r.assessments.length - 1];
              return (
                <tr key={r.ticker} className={r.status === "READY" ? "confirmed" : ""}>
                  <td><b>{r.ticker}</b></td>
                  <td>{r.side === "short" ? "put" : "call"}</td>
                  <td>{r.status}</td>
                  <td className="sub">{r.addedOn}</td>
                  <td>{r.seed?.tier || "—"}{r.seed?.tierScore ? ` ${r.seed.tierScore}×` : ""}</td>
                  <td>${((r.seed?.netPremium || 0) / 1000).toFixed(0)}k</td>
                  <td>{last ? `${last.date} ${last.tag || ""} g${last.grade ?? "-"}` : `seeded ${r.seedTag || "?"}`}</td>
                  <td style={{ fontSize: 11 }}>
                    {last?.reasons?.join("; ")
                      || (r.status === "READY" ? "all clear"
                      : (r.blockers || []).length ? `needs: ${r.blockers.slice(0, 3).join(", ")}`
                      : "awaiting first re-check")}
                  </td>
                  <td><button onClick={() => doDrop(r.ticker)} title="remove manually">✕</button></td>
                </tr>
              );
            })}
            {!active.length && (
              <tr><td colSpan={9} className="sub">
                nothing being observed yet{isLocal ? " — the scraper seeds this after the first close" : " — upload flow to seed it"}
              </td></tr>
            )}
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
