"use client";

import { useState } from "react";
import { QUESTIONS } from "@forms2apex/core/src/profile.ts";

const PHASES = [
  ["upload", "Upload"],
  ["preorientacao", "Pré-orientação"],
  ["extracao", "Extração"],
  ["classificacao", "Classificação"],
  ["conversao", "Conversão"],
  ["geracao", "Geração APEX"],
  ["validacao", "Validação"],
  ["entrega", "Entrega"],
] as const;

type Status = "pendente" | "rodando" | "ok" | "aviso" | "erro";
type Stats = { blocks: number; items: number; triggers: number; converted: number; pending: number; blocking: number; tokensIn: number; tokensOut: number };

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [accepted, setAccepted] = useState(false);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<Record<string, Status>>({});
  const [log, setLog] = useState<string[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [files, setFiles] = useState<Record<string, string>>({});
  const [tab, setTab] = useState("PENDENCIAS.md");
  const [error, setError] = useState("");

  const answered = QUESTIONS.every((q) => answers[q.id]);

  async function useSample() {
    const xml = await (await fetch("/api/sample")).text();
    setFile(new File([xml], "clientes.xml", { type: "application/xml" }));
  }

  async function start() {
    if (!file) return;
    setRunning(true); setError(""); setLog([]); setStats(null); setFiles({}); setStatus({});
    const body = new FormData();
    body.append("file", file);
    body.append("profile", JSON.stringify(answers));
    const res = await fetch("/api/migrate", { method: "POST", body });
    if (!res.ok || !res.body) {
      setError((await res.json().catch(() => ({}))).error ?? "Falha ao iniciar a migração.");
      setRunning(false);
      return;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines.filter(Boolean)) {
        const msg = JSON.parse(line);
        if (msg.type === "event") {
          setStatus((s) => ({ ...s, [msg.phase]: msg.status }));
          setLog((l) => [...l, `[${msg.phase}] ${msg.message}`]);
        } else if (msg.type === "result") {
          setStats(msg.stats); setFiles(msg.files);
        } else if (msg.type === "error") {
          setError(msg.message);
        }
      }
    }
    setRunning(false);
  }

  function download(name: string) {
    const url = URL.createObjectURL(new Blob([files[name]], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.download = name.replace(/\//g, "_"); a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main>
      <h1>forms2apex</h1>
      <p className="sub">Migração de Oracle Forms para Oracle APEX. Regras primeiro, IA só no que é ambíguo, e nada some: o que não for convertido com segurança vira regra pendente.</p>

      <section className="card">
        <h2>1. Envie o form</h2>
        <p className="note">Gere o XML com <code>frmf2xml SEU_FORM.fmb</code> (Forms Builder). A demo aceita até 2 MB, 10 blocos e 60 triggers. O arquivo é apagado ao fim da migração.</p>
        <div className="row">
          <input type="file" accept=".xml" onChange={(e) => setFile(e.target.files?.[0] ?? null)} style={{ maxWidth: 360 }} />
          <button className="ghost" onClick={useSample}>Usar form de exemplo</button>
          {file && <span className="note">Selecionado: {file.name}</span>}
        </div>
      </section>

      <section className="card">
        <h2>2. Pré-orientação</h2>
        <p className="note">Se não souber, escolha "Não sei". Aplicamos um padrão seguro e registramos a dúvida no relatório.</p>
        <div className="grid">
          {QUESTIONS.map((q) => (
            <div key={q.id}>
              <label className="q" htmlFor={q.id}>{q.label}</label>
              <select id={q.id} value={answers[q.id] ?? ""} onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}>
                <option value="" disabled>Escolha...</option>
                {q.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                <option value="nao_sei">Não sei</option>
              </select>
            </div>
          ))}
        </div>
        <p className="row note" style={{ marginTop: 16 }}>
          <input type="checkbox" id="ok" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
          <label htmlFor="ok">Entendo que o resultado exige revisão humana e que não devo enviar código com dados sensíveis de clientes.</label>
        </p>
        <button disabled={!file || !answered || !accepted || running} onClick={start}>{running ? "Migrando..." : "Iniciar migração"}</button>
        {!answered && <span className="note" style={{ marginLeft: 10 }}>Responda todas as perguntas para continuar.</span>}
      </section>

      {(running || log.length > 0) && (
        <section className="card">
          <h2>3. Migração ao vivo</h2>
          <div className="phases">
            {PHASES.map(([id, label]) => (
              <div key={id} className={`phase ${status[id] ?? "pendente"}`}><b>{label}</b>{status[id] ?? "aguardando"}</div>
            ))}
          </div>
          {error && <p className="err">{error}</p>}
          <div className="log">{log.map((l, i) => <div key={i}>{l}</div>)}</div>
        </section>
      )}

      {stats && (
        <section className="card">
          <h2>4. Resultado</h2>
          <div className="stats">
            <div><strong>{stats.blocks}</strong>blocos</div>
            <div><strong>{stats.triggers}</strong>triggers</div>
            <div><strong>{stats.converted}</strong>convertidos</div>
            <div><strong>{stats.pending}</strong>pendências</div>
            <div><strong>{stats.blocking}</strong>bloqueantes</div>
            <div><strong>{stats.tokensIn + stats.tokensOut}</strong>tokens de IA</div>
          </div>
          {stats.blocking > 0 && <p className="err">Há pendências bloqueantes. Não publique antes de resolvê-las.</p>}
          <div className="tabs" style={{ marginTop: 16 }}>
            {Object.keys(files).map((f) => <button key={f} className={tab === f ? "on" : ""} onClick={() => setTab(f)}>{f}</button>)}
          </div>
          <pre>{files[tab]}</pre>
          <button className="ghost" onClick={() => download(tab)}>Baixar {tab}</button>
        </section>
      )}

      <p className="note">Código aberto (Apache 2.0). Não afiliado à Oracle. Oracle, Forms e APEX são marcas da Oracle.</p>
    </main>
  );
}
