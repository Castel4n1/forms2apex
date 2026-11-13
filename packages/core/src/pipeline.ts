import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { AiOptions } from "./ai.ts";
import { generateApexScript, parseApexBase, type ApexBase } from "./apex.ts";
import { convertTriggers, pendingFromProgramUnits, type Pending, type TriggerResult } from "./convert.ts";
import { diagnose, type Finding } from "./diagnose.ts";
import { enrichRegions, generateLovs, generatePackage, generateRegionQueries, packagedUnits, packageName, qualifyCalls } from "./generate.ts";
import { IRSchema, MenuIRSchema, type IR, type MenuIR } from "./ir.ts";
import { bindMapper, planApplication, type Blueprint, type PlanOptions } from "./plan.ts";
import { resolveProfile, type RawProfile, type ResolvedProfile } from "./profile.ts";
import { decisionsReport, pendingReport, testScript, traceReport } from "./report.ts";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
export const parserPath = () => process.env.F2A_PARSER ?? resolve(here, "../../../parser/forms_parser.py");

/** Python do parser: F2A_PYTHON, senão o .venv do projeto (npm run setup), senão python3 do sistema. */
export function pythonPath(): string {
  if (process.env.F2A_PYTHON) return process.env.F2A_PYTHON;
  const venv = resolve(dirname(parserPath()), "../.venv/bin/python");
  return existsSync(venv) ? venv : "python3";
}

export type Phase = "upload" | "preorientacao" | "extracao" | "classificacao" | "conversao" | "geracao" | "validacao" | "entrega";
export const PHASES: Phase[] = ["upload", "preorientacao", "extracao", "classificacao", "conversao", "geracao", "validacao", "entrega"];

export interface PipelineEvent {
  phase: Phase;
  status: "rodando" | "ok" | "aviso" | "erro";
  message: string;
  stats?: Record<string, number>;
}

export interface Limits {
  maxBlocks?: number;
  maxTriggers?: number;
}

export interface PipelineOptions {
  xmlPath: string;
  /** Export da aplicação APEX de destino (fNNN.sql): herda workspace, offset, templates e evita IDs de página em uso. */
  apexBasePath?: string;
  outDir: string;
  profile?: RawProfile;
  ai?: AiOptions;
  limits?: Limits;
  onEvent?: (e: PipelineEvent) => void;
}

export interface PipelineResult {
  files: Record<string, string>;
  stats: { blocks: number; items: number; triggers: number; converted: number; pending: number; blocking: number; apexPages: number; manualSteps: number; tokensIn: number; tokensOut: number };
}

export type Module = { kind: "form"; ir: IR } | { kind: "menu"; menu: MenuIR };

/** Lê um XML do frmf2xml: form (.fmb) ou menu (.mmb). */
export async function extractModule(xmlPath: string): Promise<Module> {
  // -E ignora PYTHONPATH e afins, mas mantém os pacotes do usuário (o -I escondia o lxml instalado com pip --user).
  const py = pythonPath();
  let json: { kind?: string };
  try {
    const { stdout } = await run(py, ["-E", parserPath(), xmlPath], { maxBuffer: 20 * 1024 * 1024 });
    json = JSON.parse(stdout);
  } catch (err) {
    const stderr = String((err as { stderr?: string }).stderr ?? "");
    if (/No module named 'lxml'/.test(stderr)) throw new Error(`lxml não encontrado para ${py}. Rode "npm run setup" (cria .venv com as dependências) ou defina F2A_PYTHON.`);
    if (stderr.trim()) throw new Error(stderr.trim().split("\n").slice(-1)[0]);
    throw err;
  }
  return json.kind === "menu" ? { kind: "menu", menu: MenuIRSchema.parse(json) } : { kind: "form", ir: IRSchema.parse(json) };
}

export async function extractIR(xmlPath: string): Promise<IR> {
  const m = await extractModule(xmlPath);
  if (m.kind !== "form") throw new Error("O arquivo é um menu (.mmb). Menus entram no modo aplicação, junto com os forms.");
  return m.ir;
}

// ---------- etapas de um form, reaproveitadas pelo modo aplicação ----------

export interface PlannedForm {
  findings: Finding[];
  blueprint: Blueprint;
  binds: ReturnType<typeof bindMapper>;
}

export function planForm(ir: IR, profile: ResolvedProfile, opts: PlanOptions = {}): PlannedForm {
  const blueprint = planApplication(ir, profile, opts);
  return { findings: diagnose(ir), blueprint, binds: bindMapper(blueprint) };
}

export interface ConvertedForm {
  results: TriggerResult[];
  pending: Pending[];
  tokens: { input: number; output: number };
}

/**
 * Converte triggers e program units. `units` mapeia UNIT -> PACKAGE das bibliotecas anexadas;
 * as units do próprio form que vão para package entram automaticamente.
 */
export async function convertForm(
  ir: IR,
  planned: PlannedForm,
  profile: ResolvedProfile,
  ai: AiOptions | undefined,
  onTrigger?: (r: TriggerResult) => void,
  units: Map<string, string> = new Map(),
): Promise<ConvertedForm> {
  const all = new Map(units);
  for (const u of packagedUnits(ir.programUnits)) all.set(u.name.toUpperCase(), packageName(ir.form.name));
  const context = all.size ? `Rotinas que já estão em package no banco (chame com o prefixo): ${[...all].map(([u, pkg]) => `${u} -> ${pkg}.${u}`).join(", ")}` : undefined;
  const conv = await convertTriggers(ir, profile, planned.binds, ai && context ? { ...ai, context } : context ? { context } : ai, { onTrigger });
  const pending = [...conv.pending, ...pendingFromProgramUnits(ir, conv.pending.length)];
  for (const r of conv.results) if (r.conversion?.code) r.conversion.code = qualifyCalls(r.conversion.code, all);
  enrichRegions(planned.blueprint, conv.results, planned.binds.fn);
  return { results: conv.results, pending, tokens: conv.tokens };
}

/** Documentos e artefatos por form (sem o script APEX). */
export function formDocs(ir: IR, profile: ResolvedProfile, planned: PlannedForm, converted: ConvertedForm): Record<string, string> {
  const conversions = converted.results.map((r) => ({ origem: `${r.trigger.owner} / ${r.trigger.name}`, ...r.conversion, pendencias: r.pendingIds }));
  return {
    "ir.json": JSON.stringify(ir, null, 2),
    "blueprint.json": JSON.stringify(planned.blueprint, null, 2),
    "conversoes.json": JSON.stringify(conversions, null, 2),
    "PENDENCIAS.md": pendingReport(ir, converted.pending),
    "RASTREABILIDADE.md": traceReport(planned.blueprint, converted.results),
    "ROTEIRO_TESTES.md": testScript(planned.blueprint, converted.results),
  };
}

export async function runPipeline(o: PipelineOptions): Promise<PipelineResult> {
  const emit = (e: PipelineEvent) => o.onEvent?.(e);
  emit({ phase: "upload", status: "ok", message: "Arquivo recebido" });

  const profile = resolveProfile(o.profile);
  emit({ phase: "preorientacao", status: profile.unknown.length ? "aviso" : "ok", message: profile.unknown.length ? `${profile.unknown.length} resposta(s) "não sei": padrões seguros aplicados` : "Perfil de migração definido" });

  emit({ phase: "extracao", status: "rodando", message: "Lendo o XML do Forms" });
  let ir: IR;
  try {
    ir = await extractIR(o.xmlPath);
  } catch (err) {
    emit({ phase: "extracao", status: "erro", message: `Falha na extração: ${(err as Error).message.slice(0, 300)}` });
    throw err;
  }
  const items = ir.blocks.reduce((n, b) => n + b.items.length, 0);
  if (o.limits?.maxBlocks && ir.blocks.length > o.limits.maxBlocks) throw new Error(`Form excede o limite de ${o.limits.maxBlocks} blocos da demo`);
  if (o.limits?.maxTriggers && ir.triggers.length > o.limits.maxTriggers) throw new Error(`Form excede o limite de ${o.limits.maxTriggers} triggers da demo`);
  emit({ phase: "extracao", status: "ok", message: `${ir.blocks.length} blocos, ${items} itens, ${ir.triggers.length} triggers`, stats: { blocos: ir.blocks.length, itens: items, triggers: ir.triggers.length } });

  emit({ phase: "classificacao", status: "rodando", message: "Diagnosticando riscos" });
  let base: ApexBase | undefined;
  if (o.apexBasePath) {
    base = parseApexBase(await readFile(o.apexBasePath, "utf8"));
    emit({ phase: "classificacao", status: "ok", message: `Export base: aplicação ${base.applicationId}, APEX ${base.release}, ${base.usedPages.size} página(s) já existentes` });
  }
  const planned = planForm(ir, profile, { usedPages: base?.usedPages });
  const { findings, blueprint } = planned;
  emit({ phase: "classificacao", status: findings.some((f) => f.severity === "bloqueante") ? "aviso" : "ok", message: `${findings.length} risco(s) encontrado(s), ${blueprint.pages.length} página(s) planejada(s)`, stats: { riscos: findings.length, paginas: blueprint.pages.length } });

  emit({ phase: "conversao", status: "rodando", message: "Convertendo triggers" });
  let done = 0;
  const conv = await convertForm(ir, planned, profile, o.ai, (r) => {
    done += 1;
    emit({ phase: "conversao", status: "rodando", message: `${r.trigger.owner} / ${r.trigger.name}: ${r.conversion ? `${r.conversion.apexComponent} via ${r.conversion.source}` : "pendente"}`, stats: { feitos: done, total: ir.triggers.length } });
  });
  const pending = conv.pending;
  const converted = conv.results.filter((r) => r.conversion).length;
  emit({ phase: "conversao", status: pending.length ? "aviso" : "ok", message: `${converted} convertido(s), ${pending.length} pendência(s)`, stats: { convertidos: converted, pendencias: pending.length, tokensIn: conv.tokens.input, tokensOut: conv.tokens.output } });

  emit({ phase: "geracao", status: "rodando", message: "Gerando artefatos APEX" });
  const apex = generateApexScript(ir, blueprint, conv.results, planned.binds.fn, base);
  const docs = formDocs(ir, profile, planned, conv);
  const files: Record<string, string> = {
    "ir.json": docs["ir.json"],
    "migration-profile.json": JSON.stringify(profile, null, 2),
    "blueprint.json": docs["blueprint.json"],
    "conversoes.json": docs["conversoes.json"],
    [`install/01_${ir.form.name.toLowerCase()}_pkg.sql`]: generatePackage(ir),
    "install/02_lovs.sql": generateLovs(blueprint),
    "install/03_queries_regioes.sql": generateRegionQueries(blueprint),
    "install/04_apex_paginas.sql": apex.sql,
    "COMO_IMPORTAR.md": apex.guide,
    "PENDENCIAS.md": docs["PENDENCIAS.md"],
    "RASTREABILIDADE.md": docs["RASTREABILIDADE.md"],
    "DECISOES.md": decisionsReport(profile, findings),
    "ROTEIRO_TESTES.md": docs["ROTEIRO_TESTES.md"],
  };
  emit({ phase: "geracao", status: "ok", message: `${Object.keys(files).length} arquivos gerados; páginas APEX ${apex.pages.map((p) => p.id).join(", ")}${apex.manualSteps.length ? `, ${apex.manualSteps.length} ajuste(s) manual(is)` : ""}` });

  const blocking = pending.filter((p) => p.severity === "bloqueante").length;
  emit({ phase: "validacao", status: blocking ? "aviso" : "ok", message: blocking ? `${blocking} pendência(s) bloqueante(s): não publicar antes de resolver` : "Schema validado. Compilação no banco: rode install/ no seu DEV" });

  for (const [name, content] of Object.entries(files)) {
    const path = join(o.outDir, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }
  emit({ phase: "entrega", status: "ok", message: `Pacote pronto (${Object.keys(files).length} arquivos)` });

  return {
    files,
    stats: { blocks: ir.blocks.length, items, triggers: ir.triggers.length, converted, pending: pending.length, blocking, apexPages: apex.pages.length, manualSteps: apex.manualSteps.length, tokensIn: conv.tokens.input, tokensOut: conv.tokens.output },
  };
}
