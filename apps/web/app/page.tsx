"use client";

import { useState } from "react";
import { QUESTIONS } from "@forms2apex/core/src/profile.ts";
import { zip } from "../lib/zip";

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
type Stats = { blocks: number; items: number; triggers: number; converted: number; pending: number; blocking: number; tokensIn: number; tokensOut: number; forms?: number; apexPages?: number; doubts?: number };

export default function Home() {
  const [picked, setPicked] = useState<File[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [accepted, setAccepted] = useState(false);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<Record<string, Status>>({});
  const [log, setLog] = useState<string[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [files, setFiles] = useState<Record<string, string>>({});
  const [tab, setTab] = useState("PENDENCIAS.md");
  const [mode, setMode] = useState<"form" | "app">("form");
  const [error, setError] = useState("");

  const answered = QUESTIONS.every((q) => answers[q.id]);

  const sources = picked.filter((f) => /\.(xml|pld)$/i.test(f.name));
  const isApp = sources.length > 1 || sources.some((f) => /\.pld$/i.test(f.name));

  async function useSample() {
    const xml = await (await fetch("/api/sample")).text();
    setPicked([new File([xml], "clientes.xml", { type: "application/xml" })]);
  }

  async function useSampleApp() {
    const { files } = (await (await fetch("/api/sample?app=1")).json()) as { files: { name: string; content: string }[] };
    setPicked(files.map((f) => new File([f.content], f.name, { type: "text/plain" })));
  }

  async function start() {
    if (!sources.length) return;
    setRunning(true); setError(""); setLog([]); setStats(null); setFiles({}); setStatus({});
    const body = new FormData();
    for (const f of picked) body.append("file", f);
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
          setStats(msg.stats); setFiles(msg.files); setMode(msg.mode);
          setTab(msg.mode === "app" ? "PROXIMOS_PASSOS.md" : "PENDENCIAS.md");
        } else if (msg.type === "error") {
          setError(msg.message);
        }
      }
    }
    setRunning(false);
  }

  function downloadAll() {
    const url = URL.createObjectURL(zip(files));
    const a = document.createElement("a");
    a.href = url; a.download = mode === "app" ? "forms2apex-aplicacao.zip" : "forms2apex-form.zip"; a.click();
    URL.revokeObjectURL(url);
  }

  // Documentos primeiro (na ordem de leitura), depois scripts, depois JSON.
  const DOC_ORDER = ["PROXIMOS_PASSOS.md", "DUVIDAS_DE_REGRA.md", "MAPA_DA_APLICACAO.md", "COMO_IMPORTAR.md", "PENDENCIAS.md"];
  const rank = (f: string) => (DOC_ORDER.includes(f) ? DOC_ORDER.indexOf(f) : f.endsWith(".md") ? 10 : f.startsWith("install/") ? 20 : 30);
  const rootFiles = Object.keys(files).filter((f) => !f.startsWith("forms/")).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const formFolders = [...new Set(Object.keys(files).filter((f) => f.startsWith("forms/")).map((f) => f.split("/")[1]))];

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
        <h2>1. Envie um form ou a aplicação inteira</h2>
        <p className="note">
          Gere os XMLs com <code>frmf2xml</code> (forms .fmb e menu .mmb). Bibliotecas .pll entram como texto: <code>frmcmp module=LIB.pll module_type=library script=yes</code> gera o .pld.
          Com vários arquivos, sai uma aplicação APEX única, com menu, navegação entre forms e o roteiro de próximos passos.
          Opcional: o export da aplicação APEX de destino (.sql) para herdar tema e menu. Tudo é apagado ao fim da migração.
        </p>
        <div className="row">
          <input type="file" multiple accept=".xml,.pld,.sql" onChange={(e) => setPicked([...(e.target.files ?? [])])} style={{ maxWidth: 360 }} />
          <button className="ghost" onClick={useSampleApp}>Usar aplicação de exemplo</button>
          <button className="ghost" onClick={useSample}>Usar form de exemplo</button>
        </div>
        {picked.length > 0 && (
          <p className="note" id="selected">
            {isApp ? `Aplicação: ${sources.length} arquivo(s)` : "Form"}: {picked.map((f) => f.name).join(", ")}
          </p>
        )}
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
        <button id="start" disabled={!sources.length || !answered || !accepted || running} onClick={start}>{running ? "Migrando..." : isApp ? "Migrar aplicação" : "Iniciar migração"}</button>
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
          <div className="stats" id="stats">
            {mode === "app" ? (
              <>
                <div><strong>{stats.forms}</strong>forms</div>
                <div><strong>{stats.apexPages}</strong>páginas APEX</div>
                <div><strong>{stats.converted}/{stats.triggers}</strong>triggers convertidos</div>
                <div><strong>{stats.doubts}</strong>dúvidas de regra</div>
                <div><strong>{stats.blocking}</strong>bloqueantes</div>
                <div><strong>{stats.tokensIn + stats.tokensOut}</strong>tokens de IA</div>
              </>
            ) : (
              <>
                <div><strong>{stats.blocks}</strong>blocos</div>
                <div><strong>{stats.triggers}</strong>triggers</div>
                <div><strong>{stats.converted}</strong>convertidos</div>
                <div><strong>{stats.pending}</strong>pendências</div>
                <div><strong>{stats.blocking}</strong>bloqueantes</div>
                <div><strong>{stats.tokensIn + stats.tokensOut}</strong>tokens de IA</div>
              </>
            )}
          </div>
          {stats.blocking > 0 && <p className="err">Há pendências bloqueantes. Não publique antes de resolvê-las.</p>}
          <div className="tabs" style={{ marginTop: 16 }}>
            {rootFiles.map((f) => <button key={f} data-file={f} className={tab === f ? "on" : ""} onClick={() => setTab(f)}>{f}</button>)}
          </div>
          {formFolders.length > 0 && (
            <div className="row" style={{ marginBottom: 10 }}>
              <span className="note">Por form:</span>
              <select value={tab.startsWith("forms/") ? tab : ""} onChange={(e) => setTab(e.target.value)} style={{ maxWidth: 360 }}>
                <option value="" disabled>Escolha um arquivo...</option>
                {formFolders.map((d) => (
                  <optgroup key={d} label={d}>
                    {Object.keys(files).filter((f) => f.startsWith(`forms/${d}/`)).map((f) => <option key={f} value={f}>{f.split("/").pop()}</option>)}
                  </optgroup>
                ))}
              </select>
            </div>
          )}
          <pre id="pre">{files[tab]}</pre>
          <div className="row">
            <button onClick={downloadAll}>Baixar tudo (.zip)</button>
            <button className="ghost" onClick={() => download(tab)}>Baixar {tab.split("/").pop()}</button>
          </div>
        </section>
      )}

      <p className="note">Código aberto (Apache 2.0). Não afiliado à Oracle. Oracle, Forms e APEX são marcas da Oracle.</p>
    </main>
  );
}
