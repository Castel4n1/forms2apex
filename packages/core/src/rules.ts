import type { Trigger } from "./ir.ts";

/** Busca de descrição (POST-QUERY / WHEN-VALIDATE-ITEM): select COLUMN into :TARGET from TABLE where KEY = :SOURCE. */
export interface Lookup {
  target: string; // BLOCO.ITEM que recebe a descrição
  column: string;
  table: string;
  keyColumn: string;
  sourceItem: string; // BLOCO.ITEM usado como chave
}

/** Atribuição a item: :BLOCO.ITEM := expr (ou select seq.nextval into :BLOCO.ITEM from dual). */
export interface Assignment {
  target: string; // BLOCO.ITEM
  expr: string; // expressão PL/SQL original (binds do Forms)
  sequence?: string; // nome da sequence, quando a origem é seq.nextval
}

/** Resultado de uma conversão de trigger. */
export interface Conversion {
  apexComponent:
    | "validation"
    | "computation"
    | "process"
    | "dynamic_action"
    | "region_query"
    | "form_pk_sequence"
    | "item_default"
    | "required"
    | "nativo"
    | "error_handling"
    | "button";
  description: string;
  code?: string;
  source: "regra" | "ia";
  confidence: number; // 0 a 1
  ruleId?: string;
  /** Mensagem de erro original (validações). */
  message?: string;
  lookups?: Lookup[];
  assignments?: Assignment[];
  /** Navegação para outro form (CALL_FORM/OPEN_FORM/NEW_FORM): o modo aplicação liga à página do form chamado. */
  navigation?: Navigation;
}

/** Chamada de outro form, com as :GLOBAL preenchidas antes da chamada. */
export interface Navigation {
  form: string;
  builtin: "CALL_FORM" | "OPEN_FORM" | "NEW_FORM";
  /** Application items (GLOBAL_X) e o valor: bind :BLOCO.ITEM, literal ou null. */
  globals: { item: string; value: { bind: string } | { literal: string } | { null: true } }[];
}

export type BindMapper = (block: string, item: string) => string;

/** Aplica fn só fora de literais '...'. */
function outsideQuotes(code: string, fn: (chunk: string) => string): string {
  return code
    .split(/('(?:[^']|'')*')/)
    .map((part, i) => (i % 2 ? part : fn(part)))
    .join("");
}

/** :GLOBAL.X do Forms vira o application item GLOBAL_X. */
export const globalItem = (name: string) => `GLOBAL_${name.toUpperCase()}`;

/** Troca :BLOCO.ITEM pelo item de página APEX (:P10_ITEM) e :GLOBAL.X pelo application item :GLOBAL_X. */
export function translateBinds(code: string, mapBind: BindMapper): string {
  return outsideQuotes(code, (chunk) =>
    chunk.replace(/:(\w+)\.(\w+)/g, (match, block: string, item: string) => {
      const b = block.toLowerCase();
      if (b === "global") return `:${globalItem(item)}`;
      return b === "system" || b === "parameter" ? match : `:${mapBind(block.toUpperCase(), item.toUpperCase())}`;
    }),
  );
}

/** Nomes das :GLOBAL usadas num trecho de código (sem repetição, em maiúsculas). */
export function globalsIn(code: string): string[] {
  const out = new Set<string>();
  outsideQuotes(code, (chunk) => {
    for (const m of chunk.matchAll(/:global\.(\w+)/gi)) out.add(m[1].toUpperCase());
    return chunk;
  });
  return [...out];
}

const NAV_CALL = /^(call_form|open_form|new_form)\s*\(\s*'(\w+)'\s*(?:,[^()]*)?\)$/i;
const NAV_GLOBAL = /^:global\.(\w+)\s*:=\s*(?::(\w+)\.(\w+)|'((?:[^']|'')*)'|(-?\d+(?:\.\d+)?)|(null))$/i;

/** Código que só preenche :GLOBAL simples e chama outro form. Usado em botões e itens de menu. */
export function parseNavigation(code: string): Navigation | null {
  const sts = splitStatements(norm(code));
  const last = sts.pop()?.match(NAV_CALL);
  if (!last) return null;
  const globals: Navigation["globals"] = [];
  for (const st of sts) {
    const g = st.match(NAV_GLOBAL);
    if (!g) return null;
    const value: Navigation["globals"][number]["value"] = g[2] ? { bind: up(g[2], g[3]) } : g[6] ? { null: true } : { literal: g[4] !== undefined ? g[4].replace(/''/g, "'") : g[5] };
    globals.push({ item: globalItem(g[1]), value });
  }
  return { form: last[2].toUpperCase(), builtin: last[1].toUpperCase() as Navigation["builtin"], globals };
}

/** USER no Forms é o usuário logado; no APEX a sessão do banco é do schema, então vira :APP_USER. */
export function translateExpr(code: string, mapBind: BindMapper): string {
  return outsideQuotes(translateBinds(code, mapBind), (chunk) => chunk.replace(/(?<![\w.:$#])user\b(?!\s*\()/gi, ":APP_USER"));
}

/** Divide código em instruções por ';' fora de literais. */
export function splitStatements(code: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inStr = false;
  for (const ch of code) {
    if (ch === "'") inStr = !inStr;
    if (ch === ";" && !inStr) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const up = (b: string, i: string) => `${b}.${i}`.toUpperCase();

/** Built-ins do Forms ou referências que não existem no APEX: expressão com isso não é convertida por regra. */
const FORMS_ONLY = /\b(name_in|copy|get_\w+_property|set_\w+_property|go_\w+|execute_query|show_\w+|do_key|call_form|new_form|open_form|message|synchronize|id_null|find_\w+)\b|:system\.|:global\.|:parameter\./i;
/** Funções seguras numa expressão de atribuição. */
const SAFE_FUNCS = new Set(["nvl", "nvl2", "coalesce", "upper", "lower", "trim", "ltrim", "rtrim", "substr", "to_char", "to_date", "to_number", "trunc", "round", "decode", "greatest", "least", "abs", "lpad", "rpad", "replace"]);
const SAFE_SCALARS = /^(sysdate|systimestamp|current_date|current_timestamp|user)$/i;

function safeExpr(expr: string): boolean {
  if (FORMS_ONLY.test(expr) || /\b(select|insert|update|delete)\b/i.test(expr)) return false;
  const calls = outsideQuotes(expr, (c) => c).match(/\b(\w+)\s*\(/g) ?? [];
  return calls.every((c) => SAFE_FUNCS.has(c.replace(/\s*\($/, "").toLowerCase()));
}

/** Lista de atribuições simples (sem if/loop). Retorna null se alguma instrução não for atribuição segura. */
function parseAssignments(code: string, allowSequence: boolean): Assignment[] | null {
  if (/\b(if|loop|begin|case|for|while|exception)\b/i.test(outsideQuotes(code, () => ""))) return null;
  const out: Assignment[] = [];
  for (const st of splitStatements(code)) {
    const seq = st.match(/^select\s+(\w+)\.nextval\s+into\s+:(\w+)\.(\w+)\s+from\s+dual$/i);
    if (seq && allowSequence) {
      out.push({ target: up(seq[2], seq[3]), expr: `${seq[1].toUpperCase()}.NEXTVAL`, sequence: seq[1].toUpperCase() });
      continue;
    }
    const asg = st.match(/^:(\w+)\.(\w+)\s*:=\s*([\s\S]+)$/);
    if (!asg) return null;
    const expr = asg[3].trim();
    if (!safeExpr(expr) && !SAFE_SCALARS.test(expr)) return null;
    out.push({ target: up(asg[1], asg[2]), expr });
  }
  return out.length ? out : null;
}

/** Remove "begin <x> exception when no_data_found|others then null|:b.i := null; end;" deixando só <x>. */
function unwrapLookups(code: string): string {
  return code.replace(
    /\bbegin\s+(select\b[^;]+;)\s*exception\s+when\s+(?:no_data_found|others|too_many_rows)(?:\s+or\s+\w+)*\s+then\s+(?:null|:\w+\.\w+\s*:=\s*null)\s*;\s*end\s*;/gi,
    "$1",
  );
}

const LOOKUP_RE = /^select\s+(\w+)\s+into\s+:(\w+)\.(\w+)\s+from\s+(\w+)(?:\s+\w+)?\s+where\s+(?:\w+\.)?(\w+)\s*=\s*:(\w+)\.(\w+)$/i;

function parseLookups(code: string): Lookup[] | null {
  const sts = splitStatements(unwrapLookups(code));
  const out: Lookup[] = [];
  for (const st of sts) {
    const m = st.match(LOOKUP_RE);
    if (!m) return null;
    out.push({ column: m[1], target: up(m[2], m[3]), table: m[4], keyColumn: m[5], sourceItem: up(m[6], m[7]) });
  }
  return out.length ? out : null;
}

const lookupSql = (l: Lookup, keyExpr: string) => `(select ${l.column} from ${l.table} x where x.${l.keyColumn} = ${keyExpr})`.toLowerCase();

interface Rule {
  id: string;
  trigger: RegExp;
  /** Casa o código normalizado; retorna null se não se aplica. */
  apply: (t: Trigger, code: string, mapBind: BindMapper) => Omit<Conversion, "source" | "ruleId"> | null;
}

const RAISE_FTF = /(?:message\s*\(\s*'((?:[^']|'')*)'\s*\)\s*;\s*)+(?:bell\s*;\s*)?raise\s+form_trigger_failure\s*;\s*end\s+if\s*;?$/i;
const KEY_BUILTINS = /^(exit_form|delete_record|create_record|execute_query|enter_query|next_record|previous_record|next_block|previous_block|next_item|previous_item|clear_form|clear_block|clear_record|first_record|last_record|up|down|commit_form|duplicate_record|list_values|edit_textitem|print)$/i;
const OPEN_FORM_STMT = /^(go_block\s*\(\s*'\w+'\s*\)|execute_query|set_window_property\s*\([^)]*\)|set_window_property\s*\(\s*forms_mdi_window[^)]*\))$/i;

/**
 * Regras determinísticas: resolvem os padrões mais comuns sem IA e sem custo de token.
 * Cada regra só dispara se o código INTEIRO casar com o padrão; qualquer sobra vai para IA ou pendência.
 * A ordem importa: a primeira regra que casar vence.
 */
export const RULES: Rule[] = [
  {
    id: "navegacao_entre_forms",
    trigger: /^(WHEN-BUTTON-PRESSED|KEY-\w+)$/,
    apply: (_t, code) => {
      const nav = parseNavigation(code);
      if (!nav) return null;
      const sets = nav.globals.map((g) => g.item).join(", ");
      return {
        apexComponent: "button",
        description: `${nav.builtin} de ${nav.form}${sets ? ` passando ${sets}` : ""}. Vira botão "Redirect to Page" para a página do form ${nav.form}${sets ? ", com os application items na URL" : ""}.`,
        confidence: 0.92,
        navigation: nav,
      };
    },
  },
  {
    id: "commit_form_padrao",
    trigger: /^KEY-COMMIT$/,
    apply: (_t, code) => {
      if (/^commit_form\s*;?$/i.test(code)) return { apexComponent: "nativo", description: "Commit padrão. No APEX o processo automático de linha (Form/IG) já salva.", confidence: 0.98 };
      // Padrão comum do Forms 4.5/5/6: grava e avisa se deu certo.
      const m = code.match(/^commit_form\s*;\s*if\s+form_success\s+then\s+message\s*\(\s*'((?:[^']|'')*)'\s*\)\s*;\s*end\s+if\s*;?$/i);
      return m
        ? { apexComponent: "nativo", description: `Commit padrão com aviso "${m[1]}". Vira a Success Message do processo que salva o formulário.`, message: m[1].replace(/''/g, "'"), confidence: 0.95 }
        : null;
    },
  },
  {
    id: "tecla_builtin_padrao",
    trigger: /^KEY-/,
    apply: (t, code) => {
      const sts = splitStatements(code).map((s) =>
        s.replace(/^do_key\s*\(\s*'(\w+)'\s*\)$/i, "$1").replace(/^(exit_form|clear_form|commit_form|clear_block)\s*\(\s*\w+(?:\s*,\s*\w+)*\s*\)$/i, "$1"),
      );
      if (!sts.length || !sts.every((s) => KEY_BUILTINS.test(s))) return null;
      return {
        apexComponent: "nativo",
        description: `Tecla ${t.name} com comportamento padrão (${sts.join(", ")}). Coberto pelos botões e ações nativas do APEX.`,
        confidence: 0.95,
      };
    },
  },
  {
    id: "abertura_form_padrao",
    trigger: /^WHEN-NEW-FORM-INSTANCE$/,
    apply: (_t, code) => {
      const sts = splitStatements(code);
      if (!sts.length || !sts.every((s) => OPEN_FORM_STMT.test(s))) return null;
      return { apexComponent: "nativo", description: "Abrir, posicionar e consultar. A região APEX já carrega os dados ao abrir a página; ajustes de janela não se aplicam à web.", confidence: 0.95 };
    },
  },
  {
    id: "pk_por_sequence",
    trigger: /^PRE-INSERT$/,
    apply: (_t, code) => {
      const m = code.match(/^select\s+(\w+)\.nextval\s+into\s+:(\w+)\.(\w+)\s+from\s+dual\s*;?$/i);
      if (!m) return null;
      return {
        apexComponent: "form_pk_sequence",
        description: `Chave primária ${m[3].toUpperCase()} preenchida pela sequence ${m[1].toUpperCase()} antes do insert.`,
        code: `${m[1].toUpperCase()}.NEXTVAL`,
        confidence: 0.95,
        assignments: [{ target: up(m[2], m[3]), expr: `${m[1].toUpperCase()}.NEXTVAL`, sequence: m[1].toUpperCase() }],
      };
    },
  },
  {
    id: "atribuicoes_pre_dml",
    trigger: /^PRE-(INSERT|UPDATE)$/,
    apply: (t, code, mapBind) => {
      const asg = parseAssignments(code, t.name === "PRE-INSERT");
      if (!asg) return null;
      const body = asg.map((a) => (a.sequence ? `:${bindOf(a.target, mapBind)} := ${a.expr};` : `:${bindOf(a.target, mapBind)} := ${translateExpr(a.expr, mapBind)};`)).join("\n");
      return {
        apexComponent: "process",
        description: `Preenchimento antes do ${t.name === "PRE-INSERT" ? "insert" : "update"} (${asg.map((a) => a.target.split(".")[1]).join(", ")}). Vira processo PL/SQL antes do DML.`,
        code: body,
        confidence: 0.9,
        assignments: asg,
      };
    },
  },
  {
    id: "valores_padrao",
    trigger: /^WHEN-CREATE-RECORD$/,
    apply: (_t, code, mapBind) => {
      const asg = parseAssignments(code, false);
      if (!asg) return null;
      return {
        apexComponent: "item_default",
        description: `Valores padrão de novo registro (${asg.map((a) => a.target.split(".")[1]).join(", ")}). Vira "Default" dos itens.`,
        code: asg.map((a) => `${bindOf(a.target, mapBind)} := ${translateExpr(a.expr, mapBind)}`).join("\n"),
        confidence: 0.92,
        assignments: asg,
      };
    },
  },
  {
    id: "post_query_descricao",
    trigger: /^POST-QUERY$/,
    apply: (_t, code) => {
      const lookups = parseLookups(code);
      if (!lookups) return null;
      return {
        apexComponent: "region_query",
        description: `Busca de descrição (${lookups.map((l) => l.target.split(".")[1]).join(", ")}). Vira subconsulta escalar na query da região.`,
        code: lookups.map((l) => `${lookupSql(l, `t.${l.sourceItem.split(".")[1]}`)} as ${l.target.split(".")[1].toLowerCase()}`).join(",\n"),
        confidence: 0.9,
        lookups,
      };
    },
  },
  {
    id: "lookup_ao_validar",
    trigger: /^WHEN-VALIDATE-ITEM$/,
    apply: (_t, code, mapBind) => {
      const lookups = parseLookups(code);
      if (!lookups) return null;
      return {
        apexComponent: "dynamic_action",
        description: `Atualiza descrição ao mudar o item. O valor ao abrir é gerado; falta Dynamic Action "Set Value" no change para atualizar sem recarregar.`,
        code: lookups.map((l) => `select ${l.column} from ${l.table} where ${l.keyColumn} = :${bindOf(l.sourceItem, mapBind)}`.toLowerCase()).join(";\n"),
        confidence: 0.7,
        lookups,
      };
    },
  },
  {
    id: "validacao_obrigatorio",
    trigger: /^WHEN-VALIDATE-ITEM$/,
    apply: (_t, code) => {
      const m = code.match(new RegExp(`^if\\s+:(\\w+)\\.(\\w+)\\s+is\\s+null\\s+then\\s+${RAISE_FTF.source}`, "i"));
      if (!m) return null;
      return { apexComponent: "required", description: `Campo obrigatório. Item marcado como "Value Required" (mensagem original: "${m[3]}").`, message: m[3], confidence: 0.95 };
    },
  },
  {
    id: "validacao_funcao_booleana",
    trigger: /^WHEN-VALIDATE-ITEM$/,
    apply: (_t, code, mapBind) => {
      const m = code.match(new RegExp(`^if\\s+not\\s+(.+?)\\s+then\\s+${RAISE_FTF.source}`, "i"));
      if (!m || FORMS_ONLY.test(m[1])) return null;
      return {
        apexComponent: "validation",
        description: `Validação "PL/SQL Function Body (returning Boolean)" com mensagem "${m[2]}".`,
        code: `return ${translateExpr(m[1], mapBind)};`,
        message: m[2],
        confidence: 0.9,
      };
    },
  },
  {
    id: "validacao_condicao",
    trigger: /^WHEN-VALIDATE-(ITEM|RECORD)$/,
    apply: (_t, code, mapBind) => {
      const m = code.match(new RegExp(`^if\\s+(.+?)\\s+then\\s+${RAISE_FTF.source}`, "i"));
      if (!m || FORMS_ONLY.test(m[1]) || /\b(select|then|elsif)\b/i.test(m[1])) return null;
      return {
        apexComponent: "validation",
        description: `Validação invertida do IF original (erro quando "${norm(m[1])}") com mensagem "${m[2]}". Nulo passa, como no Forms.`,
        code: `return not nvl((${translateExpr(m[1], mapBind)}), false);`,
        message: m[2],
        confidence: 0.88,
      };
    },
  },
  {
    id: "on_error_mensagem",
    trigger: /^ON-(ERROR|MESSAGE)$/,
    apply: (_t, code) =>
      /^message\s*\(.*(error_text|message_text).*\)\s*;?$/i.test(code)
        ? { apexComponent: "error_handling", description: "Exibição genérica de erro. Coberta pelo tratamento padrão do APEX (opcional: Error Handling Function).", confidence: 0.9 }
        : null,
  },
];

function bindOf(target: string, mapBind: BindMapper): string {
  const [b, i] = target.split(".");
  return mapBind(b, i);
}

export function applyRules(t: Trigger, mapBind: BindMapper): Conversion | null {
  const code = norm(t.code);
  for (const rule of RULES) {
    if (!rule.trigger.test(t.name)) continue;
    const c = rule.apply(t, code, mapBind);
    if (c) return { ...c, source: "regra", ruleId: rule.id };
  }
  return null;
}
