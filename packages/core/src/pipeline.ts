import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { AiOptions } from "./ai.ts";
import { convertTriggers, pendingFromProgramUnits } from "./convert.ts";
import { diagnose } from "./diagnose.ts";
import { enrichRegions, generateLovs, generatePackage, generateRegionQueries } from "./generate.ts";
import { IRSchema, type IR } from "./ir.ts";
import { bindMapper, planApplication } from "./plan.ts";
import { resolveProfile, type RawProfile } from "./profile.ts";
import { decisionsReport, pendingReport, testScript, traceReport } from "./report.ts";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
export const parserPath = () => process.env.F2A_PARSER ?? resolve(here, "../../../parser/forms_parser.py");

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
  outDir: string;
  profile?: RawProfile;
  ai?: AiOptions;
  limits?: Limits;
  onEvent?: (e: PipelineEvent) => void;
}

export interface PipelineResult {
  files: Record<string, string>;
  stats: { blocks: number; items: number; triggers: number; converted: number; pending: number; blocking: number; tokensIn: number; tokensOut: number };
}

export async function extractIR(xmlPath: string): Promise<IR> {
  const { stdout } = await run("python3", ["-I", parserPath(), xmlPath], { maxBuffer: 20 * 1024 * 1024 });
  return IRSchema.parse(JSON.parse(stdout));
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
  const findings = diagnose(ir);
  const blueprint = planApplication(ir, profile);
  const binds = bindMapper(blueprint);
  emit({ phase: "classificacao", status: findings.some((f) => f.severity === "bloqueante") ? "aviso" : "ok", message: `${findings.length} risco(s) encontrado(s), ${blueprint.pages.length} página(s) planejada(s)`, stats: { riscos: findings.length, paginas: blueprint.pages.length } });

  emit({ phase: "conversao", status: "rodando", message: "Convertendo triggers" });
  let done = 0;
  const conv = await convertTriggers(ir, profile, binds, o.ai, {
    onTrigger: (r) => {
      done += 1;
      emit({ phase: "conversao", status: "rodando", message: `${r.trigger.owner} / ${r.trigger.name}: ${r.conversion ? `${r.conversion.apexComponent} via ${r.conversion.source}` : "pendente"}`, stats: { feitos: done, total: ir.triggers.length } });
    },
  });
  const pending = [...conv.pending, ...pendingFromProgramUnits(ir, conv.pending.length)];
  const converted = conv.results.filter((r) => r.conversion).length;
  emit({ phase: "conversao", status: pending.length ? "aviso" : "ok", message: `${converted} convertido(s), ${pending.length} pendência(s)`, stats: { convertidos: converted, pendencias: pending.length, tokensIn: conv.tokens.input, tokensOut: conv.tokens.output } });

  emit({ phase: "geracao", status: "rodando", message: "Gerando artefatos APEX" });
  enrichRegions(blueprint, conv.results, binds.fn);
  const conversions = conv.results.map((r) => ({ origem: `${r.trigger.owner} / ${r.trigger.name}`, ...r.conversion, pendencias: r.pendingIds }));
  const files: Record<string, string> = {
    "ir.json": JSON.stringify(ir, null, 2),
    "migration-profile.json": JSON.stringify(profile, null, 2),
    "blueprint.json": JSON.stringify(blueprint, null, 2),
    "conversoes.json": JSON.stringify(conversions, null, 2),
    [`install/01_${ir.form.name.toLowerCase()}_pkg.sql`]: generatePackage(ir),
    "install/02_lovs.sql": generateLovs(blueprint),
    "install/03_queries_regioes.sql": generateRegionQueries(blueprint),
    "PENDENCIAS.md": pendingReport(ir, pending),
    "RASTREABILIDADE.md": traceReport(blueprint, conv.results),
    "DECISOES.md": decisionsReport(profile, findings),
    "ROTEIRO_TESTES.md": testScript(blueprint, conv.results),
  };
  emit({ phase: "geracao", status: "ok", message: `${Object.keys(files).length} arquivos gerados` });

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
    stats: { blocks: ir.blocks.length, items, triggers: ir.triggers.length, converted, pending: pending.length, blocking, tokensIn: conv.tokens.input, tokensOut: conv.tokens.output },
  };
}
