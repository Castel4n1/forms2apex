import { existsSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { AiOptions } from "./ai.ts";
import { APEX_FOOTER, apexHeader, call, exportId, generateApexPages, navigationUrl, parseApexBase, sqlString, type ApexBase, type ApexPages } from "./apex.ts";
import { appGuide, decisionsByForm, doubtsReport, mapReport, nextStepsReport, type AppDoubt, type AppModel } from "./appreport.ts";
import { generateLovs, generateRegionQueries, generateUnitsPackage, packagedUnits, packageName } from "./generate.ts";
import type { IR, MenuIR } from "./ir.ts";
import { parseLibrary, type Library } from "./library.ts";
import { programUnitIssues } from "./convert.ts";
import { convertForm, extractModule, formDocs, planForm, type ConvertedForm, type PipelineEvent, type PlannedForm } from "./pipeline.ts";
import { entryPage, pagesNeeded } from "./plan.ts";
import { resolveProfile, type RawProfile } from "./profile.ts";
import { globalsIn, parseNavigation } from "./rules.ts";

/**
 * Modo aplicação: uma aplicação Forms inteira (forms .fmb, menu .mmb e bibliotecas .pll em texto)
 * vira UMA aplicação APEX: cada form ganha sua faixa de páginas, CALL_FORM vira link entre páginas,
 * o menu vira Navigation Menu e as :GLOBAL viram application items.
 */

export interface AppOptions {
  /** Arquivos ou pastas: .xml (form ou menu do frmf2xml) e .pld (biblioteca em texto). */
  inputs: string[];
  outDir: string;
  /** Export da aplicação APEX de destino. Com ele o resultado é um export completo da aplicação. */
  apexBasePath?: string;
  profile?: RawProfile;
  ai?: AiOptions;
  /** Nome da aplicação nos documentos (padrão: nome do menu ou "Aplicação"). */
  name?: string;
  limits?: { maxForms?: number; maxBlocks?: number; maxTriggers?: number };
  onEvent?: (e: PipelineEvent & { form?: string }) => void;
}

export interface FormRun {
  file: string;
  ir: IR;
  planned: PlannedForm;
  converted: ConvertedForm;
  apex: ApexPages;
  start: number;
  entry?: number;
}

export interface AppResult {
  files: Record<string, string>;
  stats: {
    forms: number;
    menus: number;
    libraries: number;
    blocks: number;
    items: number;
    triggers: number;
    converted: number;
    viaRegra: number;
    viaIa: number;
    pending: number;
    blocking: number;
    doubts: number;
    apexPages: number;
    manualSteps: number;
    tokensIn: number;
    tokensOut: number;
  };
}

/** Entrada do Navigation Menu. page undefined = item pai (só agrupa). */
export interface NavEntry {
  key: string;
  label: string;
  page?: number;
  url?: string;
  form?: string;
  children: NavEntry[];
}

const SOURCE_EXT = new Set([".xml", ".pld"]);

async function expandInputs(inputs: string[]): Promise<{ files: string[]; ignored: string[] }> {
  const files: string[] = [];
  const ignored: string[] = [];
  const walk = async (p: string) => {
    if (statSync(p).isDirectory()) {
      for (const e of (await readdir(p)).sort()) if (!e.startsWith(".")) await walk(join(p, e));
    } else if (SOURCE_EXT.has(extname(p).toLowerCase())) files.push(p);
    else ignored.push(p);
  };
  for (const i of inputs) {
    if (!existsSync(i)) throw new Error(`Não encontrado: ${i}`);
    await walk(i);
  }
  return { files, ignored };
}

/** Faixas de páginas: cada form começa num múltiplo de 100 livre (100, 200...), sem colidir com o export base. */
export function allocatePages(forms: IR[], used: Set<number> = new Set()): number[] {
  const starts: number[] = [];
  let next = 100;
  for (const ir of forms) {
    const span = Math.ceil((pagesNeeded(ir) + 1) / 100) * 100;
    for (;;) {
      let free = true;
      for (let p = next; p < next + span; p++) if (used.has(p)) free = false;
      if (free) break;
      next += 100;
    }
    starts.push(next);
    next += span;
  }
  return starts;
}

/** Menu do Forms em entradas do Navigation Menu. Itens sem destino viram dúvida. */
export function menuEntries(menu: MenuIR, formPage: (f: string) => number | undefined, mapBind: (b: string, i: string) => string, doubt: (d: Omit<AppDoubt, "id">) => void): NavEntry[] {
  const byName = new Map(menu.menu.menus.map((m) => [m.name.toUpperCase(), m]));
  const build = (menuName: string, path: string[], depth: number): NavEntry[] => {
    const m = byName.get(menuName.toUpperCase());
    if (!m || depth > 4) return [];
    const out: NavEntry[] = [];
    for (const it of m.items) {
      if (it.separator) continue;
      const where = [...path, it.label].join(" > ");
      if (it.kind === "menu" && it.subMenu) {
        const children = build(it.subMenu, [...path, it.label], depth + 1);
        if (children.length) out.push({ key: `${menu.menu.name}:${m.name}:${it.name}`, label: it.label, children });
        continue;
      }
      const code = it.code.trim();
      if (!code) continue;
      if (/^exit_form\s*(\([^)]*\))?\s*;?$/i.test(code)) continue; // Sair: o APEX já tem logout
      const nav = parseNavigation(code);
      const page = nav ? formPage(nav.form) : undefined;
      if (nav && page !== undefined) {
        const url = navigationUrl(page, nav, mapBind);
        out.push({ key: `${menu.menu.name}:${m.name}:${it.name}`, label: it.label, page, url, form: nav.form, children: [] });
        if (!url) doubt({ form: "Aplicação", origin: `Menu ${where}`, severity: "media", question: `O item de menu "${where}" passa valores que não cabem na URL. Quais valores a página de ${nav.form} precisa receber?`, why: "Valor literal com caractere especial na :GLOBAL", suggestion: "Configurar o link manualmente ou trocar por Application Process", code });
      } else if (nav) {
        doubt({ form: "Aplicação", origin: `Menu ${where}`, severity: "alta", question: `O menu chama o form ${nav.form}, que não veio na migração. Ele ainda é usado? Se sim, envie o XML dele; se não, o item sai do menu.`, why: `${nav.builtin}('${nav.form}') sem o form no lote`, suggestion: "Enviar o XML do form ou remover o item", code });
      } else {
        doubt({ form: "Aplicação", origin: `Menu ${where}`, severity: /run_product|run_report_object/i.test(code) ? "alta" : "media", question: `O item de menu "${where}" executa código em vez de abrir um form. O que ele deve fazer no APEX?`, why: /run_product|run_report_object/i.test(code) ? "Chama o Oracle Reports" : "Código PL/SQL no item de menu", suggestion: /run_product|run_report_object/i.test(code) ? "Definir a solução de relatório (APEX Office Print, PL/PDF, BI Publisher ou relatório interativo)" : "Recriar como página, processo ou link", code });
      }
    }
    return out;
  };
  return build(menu.menu.mainMenu ?? menu.menu.menus[0]?.name ?? "", [], 0);
}

/** Itens do Navigation Menu no formato do export (create_list_item, filhos com p_parent_list_item_id). */
function listItems(entries: NavEntry[], parentKey?: string): string[] {
  const out: string[] = [];
  entries.forEach((e, i) => {
    const id = `wwv_flow_imp.id(${exportId("APP", `nav:${e.key}`)})`;
    const staticId = e.label.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "item";
    out.push(
      call("wwv_flow_imp_shared.create_list_item", [
        ["id", id],
        ["list_item_display_sequence", 100 + i * 10],
        ["list_item_link_text", sqlString(e.label)],
        ["static_id", sqlString(`f2a-${staticId}-${exportId("APP", e.key).slice(-4)}`)],
        ["list_item_link_target", e.page !== undefined ? sqlString(e.url ?? `f?p=&APP_ID.:${e.page}:&SESSION.::&DEBUG.:::`) : undefined],
        ["list_item_icon", sqlString(e.page !== undefined ? "fa-file-o" : "fa-folder-o")],
        ["parent_list_item_id", parentKey ? `wwv_flow_imp.id(${exportId("APP", `nav:${parentKey}`)})` : undefined],
        ["list_item_current_type", e.page !== undefined ? sqlString("TARGET_PAGE") : undefined],
      ]),
    );
    out.push(...listItems(e.children, e.key));
  });
  return out;
}

function appItem(name: string): string {
  return `prompt --application/shared_components/logic/application_items/${name.toLowerCase()}
begin
${call("wwv_flow_imp_shared.create_flow_item", [
  ["id", `wwv_flow_imp.id(${exportId("APP", `item:${name}`)})`],
  ["name", sqlString(name)],
  ["protection_level", sqlString("N")],
  ["escape_on_http_output", sqlString("Y")],
  ["version_scn", sqlString("1")],
])}
end;
/`;
}

const NAV_MENU_RE = /prompt --application\/shared_components\/navigation\/lists\/[^\n]*\nbegin\nwwv_flow_imp_shared\.create_list\(\n p_id=>[^\n]*\n,p_name=>'Navigation Menu'[\s\S]*?\nend;\n\//;

/**
 * Monta o script da aplicação. Com export base: o próprio export recebe os application items,
 * os itens do Navigation Menu e as páginas (import substitui a aplicação inteira).
 * Sem base: script de componentes para uma aplicação existente.
 */
export function assembleApplication(baseSql: string | undefined, base: ApexBase | undefined, pages: string[], nav: NavEntry[], globals: string[], notes: string[]): { sql: string; manual: string[] } {
  const manual: string[] = [];
  const existingItems = new Set([...(baseSql ?? "").matchAll(/create_flow_item\(\s*p_id=>[^\n]*\n,p_name=>'(\w+)'/g)].map((m) => m[1].toUpperCase()));
  const newItems = globals.filter((g) => !existingItems.has(g));
  const items = listItems(nav);
  const newList = (name: string) =>
    `prompt --application/shared_components/navigation/lists/forms2apex_menu
begin
${call("wwv_flow_imp_shared.create_list", [
  ["id", `wwv_flow_imp.id(${exportId("APP", "list:menu")})`],
  ["name", sqlString(name)],
  ["static_id", sqlString("forms2apex-menu")],
  ["version_scn", sqlString("1")],
])}
${items.join("\n")}
end;
/`;

  if (baseSql && base) {
    let sql = baseSql.replace(/\r\n/g, "\n");
    const shared: string[] = newItems.map(appItem);
    if (items.length) {
      const m = sql.match(NAV_MENU_RE);
      if (m) {
        const block = m[0];
        sql = sql.replace(block, block.replace(/\nend;\n\/$/, `\n${items.join("\n")}\nend;\n/`));
      } else {
        shared.push(newList("Menu forms2apex"));
        manual.push('O export base não tem a lista "Navigation Menu". Foi criada a lista "Menu forms2apex": selecione-a em Shared Components > User Interface Attributes > Navigation Menu.');
      }
    }
    const firstPage = sql.indexOf("prompt --application/pages/");
    const deploy = ["prompt --application/deployment/definition", "prompt --application/end_environment"].map((k) => sql.indexOf(k)).filter((i) => i >= 0);
    if (!deploy.length) throw new Error("Export base incompleto: fim do arquivo (end_environment) não encontrado");
    const pagesAt = Math.min(...deploy);
    const sharedAt = firstPage >= 0 && firstPage < pagesAt ? firstPage : pagesAt;
    sql = sql.slice(0, sharedAt) + (shared.length ? shared.join("\n") + "\n" : "") + sql.slice(sharedAt, pagesAt) + pages.join("\n") + "\n" + sql.slice(pagesAt);
    const head = notes.map((n) => `-- forms2apex: ${n.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\x20-\x7e]/g, "?")}`).join("\n");
    return { sql: `${head}\n${sql}`, manual };
  }

  const shared = [...newItems.map(appItem), ...(items.length ? [newList("Menu forms2apex")] : [])];
  if (items.length) manual.push('Selecione a lista "Menu forms2apex" em Shared Components > User Interface Attributes > Navigation Menu.');
  if (newItems.length) manual.push(`O script cria os application items ${newItems.join(", ")}. Se algum já existir na aplicação de destino, apague o bloco dele do script antes de importar.`);
  return { sql: `${apexHeader(undefined, notes)}${[...shared, ...pages].join("\n")}\n${APEX_FOOTER}`, manual };
}

export async function runApplication(o: AppOptions): Promise<AppResult> {
  const emit = (e: PipelineEvent & { form?: string }) => o.onEvent?.(e);
  const { files: inputs, ignored } = await expandInputs(o.inputs);
  if (!inputs.length) throw new Error("Nenhum .xml (form ou menu) ou .pld (biblioteca) encontrado");
  emit({ phase: "upload", status: ignored.length ? "aviso" : "ok", message: `${inputs.length} arquivo(s) recebido(s)${ignored.length ? `, ${ignored.length} ignorado(s) (só .xml e .pld)` : ""}` });

  const profile = resolveProfile(o.profile);
  emit({ phase: "preorientacao", status: profile.unknown.length ? "aviso" : "ok", message: profile.unknown.length ? `${profile.unknown.length} resposta(s) "não sei": padrões seguros aplicados` : "Perfil de migração definido" });

  // ---------- extração ----------
  const doubts: AppDoubt[] = [];
  const addDoubt = (d: Omit<AppDoubt, "id">) => doubts.push({ ...d, id: "" });
  const forms: { file: string; ir: IR }[] = [];
  const menus: MenuIR[] = [];
  const libs: Library[] = [];
  const failed: { file: string; error: string }[] = [];
  emit({ phase: "extracao", status: "rodando", message: "Lendo forms, menus e bibliotecas" });
  for (const f of inputs) {
    try {
      if (extname(f).toLowerCase() === ".pld") {
        const lib = parseLibrary(f, await readFile(f, "utf8"));
        libs.push(lib);
        emit({ phase: "extracao", status: "rodando", message: `Biblioteca ${lib.name}: ${lib.units.length} program unit(s)` });
        continue;
      }
      const m = await extractModule(f);
      if (m.kind === "menu") {
        menus.push(m.menu);
        emit({ phase: "extracao", status: "rodando", message: `Menu ${m.menu.menu.name}: ${m.menu.menu.menus.reduce((n, x) => n + x.items.length, 0)} item(ns)` });
      } else {
        if (forms.some((x) => x.ir.form.name.toUpperCase() === m.ir.form.name.toUpperCase())) throw new Error(`form ${m.ir.form.name} repetido`);
        if (o.limits?.maxBlocks && m.ir.blocks.length > o.limits.maxBlocks) throw new Error(`excede o limite de ${o.limits.maxBlocks} blocos da demo`);
        if (o.limits?.maxTriggers && m.ir.triggers.length > o.limits.maxTriggers) throw new Error(`excede o limite de ${o.limits.maxTriggers} triggers da demo`);
        forms.push({ file: f, ir: m.ir });
        emit({ phase: "extracao", status: "rodando", form: m.ir.form.name, message: `Form ${m.ir.form.name}: ${m.ir.blocks.length} bloco(s), ${m.ir.triggers.length} trigger(s)` });
      }
    } catch (err) {
      const error = (err as Error).message.slice(0, 200);
      failed.push({ file: basename(f), error });
      emit({ phase: "extracao", status: "aviso", message: `${basename(f)}: ${error}` });
      addDoubt({ form: "Aplicação", origin: basename(f), severity: "alta", question: `O arquivo ${basename(f)} não foi lido (${error}). Ele faz parte da aplicação? Gere o XML de novo com o frmf2xml e rode outra vez.`, why: "Falha na leitura", suggestion: "Regerar o XML" });
    }
  }
  if (o.limits?.maxForms && forms.length > o.limits.maxForms) throw new Error(`A demo aceita até ${o.limits.maxForms} forms por aplicação`);
  if (!forms.length) throw new Error("Nenhum form válido entre os arquivos enviados");
  forms.sort((a, b) => a.ir.form.name.localeCompare(b.ir.form.name));
  const totalBlocks = forms.reduce((n, f) => n + f.ir.blocks.length, 0);
  const totalItems = forms.reduce((n, f) => n + f.ir.blocks.reduce((m, b) => m + b.items.length, 0), 0);
  const totalTriggers = forms.reduce((n, f) => n + f.ir.triggers.length, 0);
  emit({ phase: "extracao", status: failed.length ? "aviso" : "ok", message: `${forms.length} form(s), ${menus.length} menu(s), ${libs.length} biblioteca(s): ${totalBlocks} blocos, ${totalTriggers} triggers`, stats: { forms: forms.length, menus: menus.length, bibliotecas: libs.length, blocos: totalBlocks, triggers: totalTriggers } });

  // ---------- classificação e plano ----------
  emit({ phase: "classificacao", status: "rodando", message: "Planejando a aplicação" });
  let base: ApexBase | undefined;
  let baseSql: string | undefined;
  if (o.apexBasePath) {
    baseSql = await readFile(o.apexBasePath, "utf8");
    base = parseApexBase(baseSql);
    emit({ phase: "classificacao", status: "rodando", message: `Export base: aplicação ${base.applicationId}, APEX ${base.release}, ${base.usedPages.size} página(s) já existentes` });
  }
  const starts = allocatePages(forms.map((f) => f.ir), base?.usedPages);
  const libNames = new Set(libs.map((l) => l.name));
  const planned = forms.map((f, i) => {
    const p = planForm(f.ir, profile, { startPage: starts[i] });
    // Biblioteca anexada que veio no lote não é mais risco.
    p.findings = p.findings.filter((x) => !(x.riskId === "PLL" && [...libNames].some((l) => x.reason.includes(` ${l} `))));
    return p;
  });
  const entries = new Map(forms.map((f, i) => [f.ir.form.name.toUpperCase(), entryPage(planned[i].blueprint)]));
  const formPage = (name: string) => entries.get(name.toUpperCase());
  for (const f of forms)
    for (const lib of f.ir.attachedLibraries)
      if (!libNames.has(lib.toUpperCase()))
        addDoubt({ form: f.ir.form.name, origin: `Biblioteca ${lib}`, severity: "alta", question: `O form ${f.ir.form.name} usa a biblioteca ${lib}, que não veio na migração. Ela ainda existe? Gere o texto com "frmcmp module=${lib}.pll module_type=library script=yes" e envie o .pld.`, why: "Biblioteca anexada ausente", suggestion: "Enviar o .pld da biblioteca" });
  emit({ phase: "classificacao", status: "ok", message: `${planned.reduce((n, p) => n + p.blueprint.pages.length, 0)} página(s) principais planejadas em ${forms.length} faixa(s): ${forms.map((f, i) => `${f.ir.form.name} ${starts[i]}`).join(", ")}` });

  for (const l of libs)
    for (const u of l.units.filter((x) => !packagedUnits([x]).length)) {
      const { reasons, findings } = programUnitIssues(u);
      addDoubt({
        form: `Biblioteca ${l.name}`,
        origin: `Program unit ${u.name}`,
        severity: findings.some((f) => f.severity === "bloqueante") ? "bloqueante" : "alta",
        question: findings[0] ? `${findings[0].reason}. ${"Esta rotina ainda é usada? Como deve funcionar na web?"}` : "Esta rotina ainda é usada? A parte de banco pode ir para package e a parte de tela (built-ins do Forms) para a página?",
        why: reasons.join("; ") || `${u.kind} não vai para o package automaticamente`,
        suggestion: /^package/i.test(u.kind) ? "Compilar o package da biblioteca à parte, depois de revisar" : "Ajustar antes de incluir no package",
        code: u.code,
      });
    }

  // ---------- conversão ----------
  // Units das bibliotecas que vão para package: chamadas nos forms passam a ser PKG.UNIT.
  const libUnits = new Map<string, string>();
  for (const l of libs) for (const u of packagedUnits(l.units)) libUnits.set(u.name.toUpperCase(), packageName(l.name));
  const runs: FormRun[] = [];
  let tokensIn = 0;
  let tokensOut = 0;
  for (const [i, f] of forms.entries()) {
    const name = f.ir.form.name;
    emit({ phase: "conversao", status: "rodando", form: name, message: `${name}: convertendo ${f.ir.triggers.length} trigger(s)` });
    const attached = new Map([...libUnits].filter(([, pkg]) => f.ir.attachedLibraries.some((l) => packageName(l) === pkg)));
    const converted = await convertForm(f.ir, planned[i], profile, o.ai, (r) => {
      emit({ phase: "conversao", status: "rodando", form: name, message: `${name} · ${r.trigger.owner} / ${r.trigger.name}: ${r.conversion ? `${r.conversion.apexComponent} via ${r.conversion.source}` : "pendente"}` });
    }, attached);
    tokensIn += converted.tokens.input;
    tokensOut += converted.tokens.output;
    runs.push({ file: f.file, ir: f.ir, planned: planned[i], converted, apex: { blocks: [], pages: [], manualSteps: [], globals: [] }, start: starts[i], entry: entries.get(name.toUpperCase()) });
  }
  const converted = runs.reduce((n, r) => n + r.converted.results.filter((x) => x.conversion).length, 0);
  const viaIa = runs.reduce((n, r) => n + r.converted.results.filter((x) => x.conversion?.source === "ia").length, 0);
  const pendingTotal = runs.reduce((n, r) => n + r.converted.pending.length, 0);
  emit({ phase: "conversao", status: pendingTotal ? "aviso" : "ok", message: `${converted} de ${totalTriggers} trigger(s) convertidos (${converted - viaIa} por regra, ${viaIa} por IA), ${pendingTotal} pendência(s)`, stats: { convertidos: converted, pendencias: pendingTotal, tokensIn, tokensOut } });

  // ---------- geração ----------
  emit({ phase: "geracao", status: "rodando", message: "Gerando a aplicação APEX" });
  const globals = new Set<string>();
  for (const r of runs) {
    r.apex = generateApexPages(r.ir, r.planned.blueprint, r.converted.results, r.planned.binds.fn, base, { formPage, createsGlobals: true });
    r.apex.globals.forEach((g) => globals.add(g));
    for (const t of r.ir.triggers) globalsIn(t.code).forEach((g) => globals.add(`GLOBAL_${g}`));
    // Chamadas de form para form que não veio no lote.
    for (const x of r.converted.results)
      if (x.conversion?.navigation && formPage(x.conversion.navigation.form) === undefined)
        addDoubt({ form: r.ir.form.name, origin: `${x.trigger.owner} / ${x.trigger.name}`, severity: "alta", question: `${r.ir.form.name} chama o form ${x.conversion.navigation.form}, que não veio na migração. Ele ainda é usado? Se sim, envie o XML; se não, o botão sai da tela.`, why: `${x.conversion.navigation.builtin}('${x.conversion.navigation.form}') sem o form no lote`, suggestion: "Enviar o XML do form chamado ou remover a chamada", code: x.trigger.code });
  }
  for (const m of menus) for (const mm of m.menu.menus) for (const it of mm.items) globalsIn(it.code).forEach((g) => globals.add(`GLOBAL_${g}`));

  // Menu: o do Forms, senão um item por form (só os que não são chamados por outro form).
  const anyBind = (b: string, i: string) => runs.map((r) => r.planned.binds.map[`${b}.${i}`]).find(Boolean) ?? `${b}_${i}`;
  let nav: NavEntry[] = menus.flatMap((m) => menuEntries(m, formPage, anyBind, addDoubt));
  const inMenu = new Set<string>();
  const walk = (es: NavEntry[]) => es.forEach((e) => (e.form && inMenu.add(e.form), walk(e.children)));
  walk(nav);
  const calledBy = new Map<string, Set<string>>();
  for (const r of runs)
    for (const x of r.converted.results) {
      const target = x.conversion?.navigation?.form;
      if (target) calledBy.set(target, (calledBy.get(target) ?? new Set()).add(r.ir.form.name.toUpperCase()));
    }
  const orphan = runs.filter((r) => !inMenu.has(r.ir.form.name.toUpperCase()) && !(menus.length && calledBy.has(r.ir.form.name.toUpperCase())));
  const formEntry = (r: FormRun): NavEntry => ({ key: `form:${r.ir.form.name}`, label: r.ir.form.title ?? r.ir.form.name, page: r.entry, form: r.ir.form.name.toUpperCase(), children: [] });
  // Sem menu do Forms: um item por form, menos os que só funcionam abertos por outro form (filtram por :GLOBAL obrigatória).
  if (!menus.length) nav = runs.filter((r) => !needsContext(r.ir)).map(formEntry);
  else if (orphan.length) {
    nav.push({ key: "form:outros", label: "Outros", children: orphan.map(formEntry) });
    addDoubt({ form: "Aplicação", origin: "Menu", severity: "informativa", question: `Os forms ${orphan.map((r) => r.ir.form.name).join(", ")} não aparecem no menu nem são chamados por outro form. Em que lugar do menu eles devem ficar (ou saem da aplicação)?`, why: "Form sem caminho de navegação", suggestion: 'Mover do grupo "Outros" para o lugar certo no Navigation Menu' });
  }

  const appName = o.name ?? menus[0]?.menu.name.replace(/_?MENU$/i, "") ?? "Aplicação";
  const pages = runs.flatMap((r) => r.apex.blocks);
  const notes = [`Aplicacao ${appName}: ${runs.length} forms, ${runs.reduce((n, r) => n + r.apex.pages.length, 0)} paginas, ${menus.length} menu(s).`];
  const assembled = assembleApplication(baseSql, base, pages, nav, [...globals].sort(), notes);
  if (base && !base.release.startsWith("26.")) assembled.manual.unshift(`O export base é do APEX ${base.release}; o formato gerado foi validado contra o 26.1. Importe primeiro num ambiente DEV.`);

  // ---------- arquivos ----------
  const files: Record<string, string> = {};
  const install: string[] = [];
  for (const l of libs) {
    const name = `install/01_lib_${l.name.toLowerCase()}_pkg.sql`;
    files[name] = generateUnitsPackage(l.name, `biblioteca ${l.name}`, l.units);
    install.push(name);
  }
  for (const r of runs) {
    if (r.ir.programUnits.length) {
      const name = `install/02_pkg_${r.ir.form.name.toLowerCase()}.sql`;
      files[name] = generateUnitsPackage(r.ir.form.name, `form ${r.ir.form.name}`, r.ir.programUnits);
      install.push(name);
    }
    const dir = `forms/${r.ir.form.name.toUpperCase()}`;
    for (const [k, v] of Object.entries(formDocs(r.ir, profile, r.planned, r.converted))) files[`${dir}/${k}`] = v;
    files[`${dir}/lovs.sql`] = generateLovs(r.planned.blueprint);
    files[`${dir}/queries_regioes.sql`] = generateRegionQueries(r.planned.blueprint);
  }
  const appFile = base ? `install/03_f${base.applicationId}_aplicacao.sql` : "install/03_apex_aplicacao.sql";
  files[appFile] = assembled.sql;
  install.push(appFile);
  files["install/instalar_tudo.sql"] = installAll(install, base, appName);

  // Pendências de cada form também entram nas dúvidas (com pergunta para quem conhece a regra).
  const model: AppModel = { name: appName, runs, menus, libs, nav, globals: [...globals].sort(), base, appFile, failed, doubts, appManual: assembled.manual, profile, calledBy };
  numberDoubts(model);
  files["PROXIMOS_PASSOS.md"] = nextStepsReport(model);
  files["DUVIDAS_DE_REGRA.md"] = doubtsReport(model);
  files["MAPA_DA_APLICACAO.md"] = mapReport(model);
  files["COMO_IMPORTAR.md"] = appGuide(model);
  files["DECISOES.md"] = decisionsByForm(model);
  files["migration-profile.json"] = JSON.stringify(profile, null, 2);
  files["aplicacao.json"] = JSON.stringify(
    {
      nome: appName,
      forms: runs.map((r) => ({ form: r.ir.form.name, arquivo: basename(r.file), paginas: r.apex.pages.map((p) => p.id), entrada: r.entry })),
      menus: menus.map((m) => m.menu.name),
      bibliotecas: libs.map((l) => ({ nome: l.name, package: packageName(l.name), units: l.units.map((u) => u.name) })),
      applicationItems: [...globals].sort(),
    },
    null,
    2,
  );

  const blocking = runs.reduce((n, r) => n + r.converted.pending.filter((p) => p.severity === "bloqueante").length, 0);
  const manualSteps = assembled.manual.length + runs.reduce((n, r) => n + r.apex.manualSteps.length, 0);
  const apexPages = runs.reduce((n, r) => n + r.apex.pages.length, 0);
  emit({ phase: "geracao", status: "ok", message: `Aplicação montada: ${apexPages} páginas, ${nav.length} entrada(s) no menu, ${globals.size} application item(s), ${Object.keys(files).length} arquivos` });
  emit({ phase: "validacao", status: blocking ? "aviso" : "ok", message: blocking ? `${blocking} pendência(s) bloqueante(s) e ${model.doubts.length} dúvida(s) de regra: veja PROXIMOS_PASSOS.md` : `${model.doubts.length} dúvida(s) de regra para revisar; nenhuma bloqueante` });

  for (const [name, content] of Object.entries(files)) {
    const path = join(o.outDir, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }
  emit({ phase: "entrega", status: "ok", message: `Aplicação pronta (${Object.keys(files).length} arquivos). Comece por PROXIMOS_PASSOS.md` });

  return {
    files,
    stats: {
      forms: runs.length,
      menus: menus.length,
      libraries: libs.length,
      blocks: totalBlocks,
      items: totalItems,
      triggers: totalTriggers,
      converted,
      viaRegra: converted - viaIa,
      viaIa,
      pending: pendingTotal,
      blocking,
      doubts: model.doubts.length,
      apexPages,
      manualSteps,
      tokensIn,
      tokensOut,
    },
  };
}

/** Junta as pendências dos forms às dúvidas da aplicação e numera D-001... (bloqueantes primeiro). */
function numberDoubts(m: AppModel) {
  const order = { bloqueante: 0, alta: 1, media: 2, informativa: 3 } as const;
  // Uma dúvida por origem: um trigger com dois riscos vira uma pergunta só, com a severidade maior.
  const fromForms: AppDoubt[] = [];
  for (const r of m.runs) {
    const byOrigin = new Map<string, typeof r.converted.pending>();
    for (const p of r.converted.pending) byOrigin.set(p.origin, [...(byOrigin.get(p.origin) ?? []), p]);
    for (const [origin, ps] of byOrigin) {
      // a pergunta específica do risco vem antes da genérica "sem regra"
      const sorted = [...ps].sort((a, b) => order[a.severity] - order[b.severity] || Number(a.kind === "SEM_REGRA") - Number(b.kind === "SEM_REGRA"));
      const questions = [...new Set(sorted.map((p) => questionFor(p.kind, p.origin, p.questions)))];
      const specific = questions.length > 1 ? questions.filter((q) => q !== QUESTIONS.SEM_REGRA) : questions;
      fromForms.push({
        id: "",
        form: r.ir.form.name,
        origin,
        severity: sorted[0].severity,
        question: specific.join(" "),
        why: [...new Set(sorted.map((p) => p.reason))].join("; "),
        suggestion: [...new Set(sorted.map((p) => p.suggestion))].join("; "),
        code: sorted[0].originalCode,
        pendingId: sorted.map((p) => p.id).join(", "),
      });
    }
  }
  const all = [...m.doubts, ...fromForms].sort((a, b) => order[a.severity] - order[b.severity] || a.form.localeCompare(b.form));
  all.forEach((d, i) => (d.id = `D-${String(i + 1).padStart(3, "0")}`));
  m.doubts = all;
}

const QUESTIONS: Record<string, string> = {
  HOST: "O comando no sistema operacional ainda é necessário? O que ele produz (arquivo, impressão, integração) e onde deve rodar agora que não há máquina do usuário?",
  TEXT_IO: "Que arquivo é lido ou gravado aqui? O usuário deve baixar ou enviar pelo navegador, ou o servidor cuida disso?",
  WEBUTIL: "O que esta interação com a máquina do usuário faz? Upload/download pelo navegador resolve?",
  NAVEGACAO_FORMS: "Para qual tela este fluxo deve levar e quais valores precisam ir junto?",
  GLOBAL: "Esta :GLOBAL precisa valer a sessão inteira (application item) ou só levar um valor para a próxima tela?",
  REPORTS: "Este relatório ainda é usado? Qual ferramenta vai substituí-lo (APEX Office Print, PL/PDF, BI Publisher ou relatório interativo)?",
  SERVICO_EXTERNO: "Qual serviço externo é chamado, com que credencial, e o banco do APEX tem ACL de rede para ele?",
  DB_LINK: "O database link existe no ambiente do APEX? Quem pode usá-lo?",
  DBMS_PIPE: "Quem lê esta mensagem do DBMS_PIPE? O fluxo ainda existe?",
  TRANSACAO: "Em que momento o commit (ou rollback) deve acontecer? No APEX cada requisição grava ao final; há passo intermediário que precisa ficar salvo?",
  TIMER: "O que o timer atualiza e de quanto em quanto tempo? Ainda é necessário na web?",
  OLE_JAVA: "O que este componente OLE/Java faz para o usuário? Existe equivalente web aceitável?",
  PLL: "A biblioteca anexada ainda é usada? Envie o .pld dela.",
  SEM_REGRA: "Qual é a regra de negócio deste trigger e ela ainda vale? Nenhuma regra automática cobriu o código.",
  IA: "Qual é a regra de negócio deste trigger? A conversão automática falhou.",
  PROGRAM_UNIT: "Esta rotina ainda é usada? A parte de banco pode ir para package e a parte de tela (built-ins do Forms) para a página?",
};

function questionFor(kind: string | undefined, origin: string, ai?: string[]): string {
  if (ai?.length) return ai.join(" ");
  if (kind === "REVISAR") return `A conversão sugerida para ${origin} está certa? Ela saiu com confiança baixa.`;
  return QUESTIONS[kind ?? ""] ?? "Como esta regra deve funcionar no APEX?";
}

function installAll(files: string[], base: ApexBase | undefined, app: string): string {
  const pre = base
    ? ""
    : `-- Sem export base: diga onde importar antes de rodar.
-- begin
--   apex_application_install.set_workspace('MEU_WORKSPACE');
--   apex_application_install.set_application_id(100);
--   apex_application_install.generate_offset;
--   apex_application_install.set_schema('MEU_SCHEMA');
-- end;
-- /
`;
  return `-- forms2apex: instala a aplicacao ${app.normalize("NFD").replace(/[̀-ͯ]/g, "")} na ordem certa.
-- Rode no SQLcl conectado ao schema da aplicacao, num ambiente DEV, a partir da pasta install/.
-- Packages com erro de compilacao nao param o script: confira "show errors" e PROXIMOS_PASSOS.md.
set define off
${pre}
${files.map((f) => `prompt == ${basename(f)}\n@@${basename(f)}`).join("\n")}
`;
}

/** Form cujo bloco principal filtra por :GLOBAL sem nvl: só faz sentido aberto por outro form. */
export function needsContext(ir: IR): boolean {
  const where = ir.blocks[0]?.where ?? "";
  return /=\s*:global\.\w+/i.test(where) && !/nvl\s*\(\s*:global/i.test(where);
}
