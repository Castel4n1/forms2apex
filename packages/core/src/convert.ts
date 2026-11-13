import { aiAvailable, convertWithAi, type AiOptions } from "./ai.ts";
import { scanCode, type Finding, type Severity } from "./diagnose.ts";
import type { IR, Trigger } from "./ir.ts";
import type { ResolvedProfile } from "./profile.ts";
import { applyRules, type BindMapper, type Conversion } from "./rules.ts";

export const MIN_CONFIDENCE = 0.75;

export interface Pending {
  id: string;
  origin: string;
  severity: Severity;
  reason: string;
  originalCode: string;
  suggestion: string;
  status: "Aberto";
  /** Dúvidas abertas devolvidas pela IA, para o documento de dúvidas de regra. */
  questions?: string[];
  /** Risco do diagnóstico que gerou a pendência (HOST, GLOBAL...), "SEM_REGRA", "IA" ou "PROGRAM_UNIT". */
  kind?: string;
}

export interface TriggerResult {
  trigger: Trigger;
  conversion?: Conversion;
  findings: Finding[];
  pendingIds: string[];
}

export interface ConvertOutput {
  results: TriggerResult[];
  pending: Pending[];
  tokens: { input: number; output: number };
}

export interface ConvertHooks {
  onTrigger?: (r: TriggerResult) => void;
}

export async function convertTriggers(
  ir: IR,
  profile: ResolvedProfile,
  mapBind: { fn: BindMapper; map: Record<string, string> },
  ai: AiOptions = {},
  hooks: ConvertHooks = {},
): Promise<ConvertOutput> {
  const pending: Pending[] = [];
  const results: TriggerResult[] = [];
  const tokens = { input: 0, output: 0 };
  const useAi = profile.answers.uso_ia === "sim" && aiAvailable(ai);

  const addPending = (p: Omit<Pending, "id" | "status">) => {
    const id = `PEND-${String(pending.length + 1).padStart(3, "0")}`;
    pending.push({ ...p, id, status: "Aberto" });
    return id;
  };

  for (const t of ir.triggers) {
    const origin = `${t.owner} / ${t.name}`;
    const findings = scanCode(t.code, origin);
    const result: TriggerResult = { trigger: t, findings, pendingIds: [] };

    // 1) Riscos bloqueantes nunca são convertidos automaticamente.
    const blocking = findings.find((f) => f.severity === "bloqueante");
    if (blocking) {
      result.pendingIds.push(addPending({ origin, severity: "bloqueante", reason: blocking.reason, originalCode: t.code, suggestion: blocking.suggestion, kind: blocking.riskId }));
    } else {
      // 2) Regra determinística; 3) IA; 4) pendência.
      let conv = applyRules(t, mapBind.fn);
      let questions: string[] = [];
      if (!conv && useAi) {
        try {
          // uma nova tentativa quando a resposta vem sem JSON válido
          const r = await convertWithAi(t, mapBind.map, ai).catch(() => convertWithAi(t, mapBind.map, ai));
          conv = r.conversion;
          questions = r.openQuestions;
          tokens.input += r.usage.input;
          tokens.output += r.usage.output;
        } catch (err) {
          result.pendingIds.push(addPending({ origin, severity: "media", reason: `IA não retornou resultado válido (${(err as Error).message.slice(0, 120)})`, originalCode: t.code, suggestion: "Converter manualmente", kind: "IA" }));
        }
      }
      if (conv) {
        result.conversion = conv;
        if (conv.confidence < MIN_CONFIDENCE || questions.length) {
          result.pendingIds.push(addPending({ origin, severity: "media", reason: `Conversão com confiança ${conv.confidence.toFixed(2)}${questions.length ? `; dúvidas: ${questions.join("; ")}` : ""}`, originalCode: t.code, suggestion: "Revisar a conversão sugerida antes de publicar", kind: "REVISAR", questions: questions.length ? questions : undefined }));
        }
      } else if (!result.pendingIds.length) {
        result.pendingIds.push(addPending({ origin, severity: "alta", reason: useAi ? "Sem regra e sem conversão por IA" : "Nenhuma regra determinística cobre este trigger (IA desativada)", originalCode: t.code, suggestion: "Converter manualmente ou habilitar IA", kind: "SEM_REGRA" }));
      }
    }

    // Riscos não bloqueantes também viram pendência informativa para não se perderem.
    // Navegação e :GLOBAL resolvidas pela regra de navegação não precisam de pendência.
    const covered = result.conversion?.navigation ? new Set(["NAVEGACAO_FORMS", "GLOBAL"]) : new Set<string>();
    for (const f of findings.filter((x) => x.severity !== "bloqueante" && !covered.has(x.riskId))) {
      result.pendingIds.push(addPending({ origin, severity: f.severity, reason: f.reason, originalCode: t.code, suggestion: f.suggestion, kind: f.riskId }));
    }

    results.push(result);
    hooks.onTrigger?.(result);
  }

  return { results, pending, tokens };
}

const FORMS_BUILTINS = /\b(message|go_block|go_item|execute_query|set_item_property|get_item_property|show_lov|clear_form|synchronize|name_in|copy|call_form|new_form|open_form)\b|:\w+\.\w+/i;

/** Problemas que impedem a program unit de ir direto para o package do banco. */
export function programUnitIssues(p: IR["programUnits"][number]): { reasons: string[]; findings: Finding[] } {
  const findings = scanCode(p.code, `Program unit ${p.name}`);
  const reasons = findings.map((f) => f.reason);
  if (FORMS_BUILTINS.test(p.code)) reasons.push("Usa built-ins do Forms ou binds de bloco; não compila em package sem ajuste");
  return { reasons, findings };
}

export function pendingFromProgramUnits(ir: IR, startAt: number): Pending[] {
  const out: Pending[] = [];
  for (const p of ir.programUnits) {
    const { reasons, findings } = programUnitIssues(p);
    for (const reason of reasons) {
      out.push({
        id: `PEND-${String(startAt + out.length + 1).padStart(3, "0")}`,
        origin: `Program unit ${p.name}`,
        severity: findings.some((f) => f.severity === "bloqueante") ? "bloqueante" : "alta",
        reason,
        originalCode: p.code,
        suggestion: "Ajustar antes de compilar o package",
        status: "Aberto",
        kind: findings.find((f) => f.reason === reason)?.riskId ?? "PROGRAM_UNIT",
      });
    }
  }
  return out;
}
