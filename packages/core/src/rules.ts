import type { Trigger } from "./ir.ts";

/** Resultado de uma conversão de trigger. */
export interface Conversion {
  apexComponent:
    | "validation"
    | "computation"
    | "process"
    | "dynamic_action"
    | "region_query"
    | "form_pk_sequence"
    | "nativo"
    | "error_handling"
    | "button";
  description: string;
  code?: string;
  source: "regra" | "ia";
  confidence: number; // 0 a 1
  ruleId?: string;
}

export type BindMapper = (block: string, item: string) => string;

/** Troca :BLOCO.ITEM pelo item de página APEX (:P10_ITEM). */
export function translateBinds(code: string, mapBind: BindMapper): string {
  return code.replace(/:(\w+)\.(\w+)/g, (match, block: string, item: string) =>
    block.toLowerCase() === "global" || block.toLowerCase() === "system" || block.toLowerCase() === "parameter"
      ? match
      : `:${mapBind(block.toUpperCase(), item.toUpperCase())}`,
  );
}

interface Rule {
  id: string;
  trigger: RegExp;
  match: RegExp;
  build: (t: Trigger, m: RegExpMatchArray, mapBind: BindMapper) => Omit<Conversion, "source" | "ruleId">;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Regras determinísticas: resolvem os padrões mais comuns sem IA e sem custo de token.
 * Cada regra só dispara se o código inteiro casar com o padrão (âncoras ^ e $).
 */
export const RULES: Rule[] = [
  {
    id: "commit_form_padrao",
    trigger: /^KEY-COMMIT$/,
    match: /^commit_form\s*;?$/i,
    build: () => ({
      apexComponent: "nativo",
      description: "Commit padrão. No APEX o processo automático de linha (Form/IG) já salva.",
      confidence: 0.98,
    }),
  },
  {
    id: "abertura_executa_query",
    trigger: /^WHEN-NEW-FORM-INSTANCE$/,
    match: /^(go_block\s*\(\s*'\w+'\s*\)\s*;\s*)?execute_query\s*;?$/i,
    build: () => ({
      apexComponent: "nativo",
      description: "Abrir e consultar. A região APEX já carrega os dados ao abrir a página.",
      confidence: 0.95,
    }),
  },
  {
    id: "pk_por_sequence",
    trigger: /^PRE-INSERT$/,
    match: /^select\s+(\w+)\.nextval\s+into\s+:(\w+)\.(\w+)\s+from\s+dual\s*;?$/i,
    build: (_t, m) => ({
      apexComponent: "form_pk_sequence",
      description: `Chave primária ${m[3].toUpperCase()} preenchida pela sequence ${m[1].toUpperCase()}. Configurar a PK do Form/IG como "Sequence" (ou coluna identity).`,
      code: `${m[1].toUpperCase()}.NEXTVAL`,
      confidence: 0.95,
    }),
  },
  {
    id: "post_query_descricao",
    trigger: /^POST-QUERY$/,
    match: /^select\s+(\w+)\s+into\s+:(\w+)\.(\w+)\s+from\s+(\w+)\s+where\s+(\w+)\s*=\s*:(\w+)\.(\w+)\s*;?$/i,
    build: (_t, m) => ({
      apexComponent: "region_query",
      description: `Busca de descrição. Vira subconsulta escalar na query da região, preenchendo ${m[3].toUpperCase()}.`,
      code: `(select ${m[1]} from ${m[4]} x where x.${m[5]} = t.${m[7]}) as ${m[3]}`.toLowerCase(),
      confidence: 0.9,
    }),
  },
  {
    id: "validacao_funcao_booleana",
    trigger: /^WHEN-VALIDATE-ITEM$/,
    match: /^if\s+not\s+(.+?)\s+then\s+message\s*\(\s*'([^']*)'\s*\)\s*;\s*raise\s+form_trigger_failure\s*;\s*end\s+if\s*;?$/i,
    build: (_t, m, mapBind) => ({
      apexComponent: "validation",
      description: `Validação "PL/SQL Function Body (returning Boolean)" com mensagem "${m[2]}".`,
      code: `return ${translateBinds(m[1], mapBind)};`,
      confidence: 0.9,
    }),
  },
  {
    id: "validacao_obrigatorio",
    trigger: /^WHEN-VALIDATE-ITEM$/,
    match: /^if\s+:(\w+)\.(\w+)\s+is\s+null\s+then\s+message\s*\(\s*'([^']*)'\s*\)\s*;\s*raise\s+form_trigger_failure\s*;\s*end\s+if\s*;?$/i,
    build: (_t, m) => ({
      apexComponent: "validation",
      description: `Campo obrigatório. Marcar o item como "Value Required" com mensagem "${m[3]}".`,
      confidence: 0.95,
    }),
  },
  {
    id: "on_error_mensagem",
    trigger: /^ON-ERROR$/,
    match: /^message\s*\(.*error_text.*\)\s*;?$/i,
    build: () => ({
      apexComponent: "error_handling",
      description: "Exibição genérica de erro. Coberta pelo tratamento padrão do APEX (opcional: Error Handling Function).",
      confidence: 0.9,
    }),
  },
];

export function applyRules(t: Trigger, mapBind: BindMapper): Conversion | null {
  const code = norm(t.code);
  for (const rule of RULES) {
    if (!rule.trigger.test(t.name)) continue;
    const m = code.match(rule.match);
    if (m) return { ...rule.build(t, m, mapBind), source: "regra", ruleId: rule.id };
  }
  return null;
}
