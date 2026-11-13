import { basename } from "node:path";
import type { ApexBase } from "./apex.ts";
import type { FormRun, NavEntry } from "./app.ts";
import type { Severity } from "./diagnose.ts";
import { packagedUnits, packageName } from "./generate.ts";
import type { MenuIR } from "./ir.ts";
import type { Library } from "./library.ts";
import type { ResolvedProfile } from "./profile.ts";
import { decisionsReport } from "./report.ts";

/** Dúvida de regra: pergunta para quem conhece o negócio ou o sistema, com contexto para decidir. */
export interface AppDoubt {
  id: string;
  form: string;
  origin: string;
  severity: Severity;
  question: string;
  why: string;
  suggestion: string;
  code?: string;
  pendingId?: string;
}

export interface AppModel {
  name: string;
  runs: FormRun[];
  menus: MenuIR[];
  libs: Library[];
  nav: NavEntry[];
  globals: string[];
  base?: ApexBase;
  appFile: string;
  failed: { file: string; error: string }[];
  doubts: AppDoubt[];
  appManual: string[];
  profile: ResolvedProfile;
  /** FORM chamado -> forms que chamam. */
  calledBy: Map<string, Set<string>>;
}

const SEV_LABEL: Record<Severity, string> = { bloqueante: "Bloqueante", alta: "Alta", media: "Média", informativa: "Informativa" };
const count = (m: AppModel, s: Severity, form?: string) => m.doubts.filter((d) => d.severity === s && (!form || d.form === form)).length;
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 100);
const cell = (t: string) => t.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

function formStatus(m: AppModel, r: FormRun): string {
  const form = r.ir.form.name;
  if (count(m, "bloqueante", form)) return "Bloqueado: resolver dúvidas bloqueantes";
  if (count(m, "alta", form)) return "Testar com ressalvas";
  return "Pronto para testar";
}

function pageRange(r: FormRun): string {
  const ids = r.apex.pages.map((p) => p.id).sort((a, b) => a - b);
  return ids.length ? (ids.length === 1 ? String(ids[0]) : `${ids[0]} a ${ids[ids.length - 1]}`) : "-";
}

export function nextStepsReport(m: AppModel): string {
  const triggers = m.runs.reduce((n, r) => n + r.ir.triggers.length, 0);
  const conv = m.runs.reduce((n, r) => n + r.converted.results.filter((x) => x.conversion).length, 0);
  const ia = m.runs.reduce((n, r) => n + r.converted.results.filter((x) => x.conversion?.source === "ia").length, 0);
  const pages = m.runs.reduce((n, r) => n + r.apex.pages.length, 0);
  const blocking = m.doubts.filter((d) => d.severity === "bloqueante");
  const high = m.doubts.filter((d) => d.severity === "alta");

  const rows = m.runs.map((r) => {
    const f = r.ir.form.name;
    const c = r.converted.results.filter((x) => x.conversion).length;
    return `| ${f} | ${pageRange(r)} | ${r.ir.triggers.length} | ${c} (${pct(c, r.ir.triggers.length)}%) | ${m.doubts.filter((d) => d.form === f).length} (${count(m, "bloqueante", f)} bloq., ${count(m, "alta", f)} altas) | ${formStatus(m, r)} |`;
  });

  const manual = [
    ...m.appManual.map((x) => `- [ ] Aplicação: ${x}`),
    ...m.runs.flatMap((r) => (r.apex.manualSteps.length ? [`\n**${r.ir.form.name}**\n`, ...r.apex.manualSteps.map((x) => `- [ ] ${x}`)] : [])),
  ];

  const navTests: string[] = [];
  for (const r of m.runs)
    for (const x of r.converted.results) {
      const n = x.conversion?.navigation;
      if (!n) continue;
      const target = m.runs.find((t) => t.ir.form.name.toUpperCase() === n.form);
      if (!target) continue;
      navTests.push(`- [ ] ${r.ir.form.name}: ${x.trigger.owner} abre ${n.form} (página ${target.entry})${n.globals.length ? ` levando ${n.globals.map((g) => g.item).join(", ")}` : ""}`);
    }
  const menuTests = flatten(m.nav).filter((e) => e.entry.page !== undefined).map((e) => `- [ ] Menu ${e.path.join(" > ")} abre a página ${e.entry.page}`);

  return `# Próximos passos: ${m.name}

Gerado pelo forms2apex. Este é o roteiro para sair da migração automática e chegar à aplicação publicada: o que já está pronto, o que precisa de decisão e a ordem para atacar as arestas.

## Onde estamos

- **${m.runs.length} forms**, ${m.menus.length} menu(s) e ${m.libs.length} biblioteca(s) migrados para **uma aplicação APEX** com ${pages} páginas${m.base ? ` (aplicação ${m.base.applicationId}, APEX ${m.base.release})` : ""}.
- **${conv} de ${triggers} triggers convertidos automaticamente (${pct(conv, triggers)}%)**: ${conv - ia} por regra determinística e ${ia} por IA.
- **${m.doubts.length} dúvidas de regra** em DUVIDAS_DE_REGRA.md: ${count(m, "bloqueante")} bloqueantes, ${count(m, "alta")} altas, ${count(m, "media")} médias e ${count(m, "informativa")} informativas.
- ${manual.filter((x) => x.startsWith("- [ ]")).length} ajustes manuais de página listados no passo 3.${m.failed.length ? `\n- **${m.failed.length} arquivo(s) não foram lidos**: ${m.failed.map((f) => `${f.file} (${f.error})`).join("; ")}.` : ""}

| Form | Páginas | Triggers | Convertidos | Dúvidas | Situação |
| --- | --- | --- | --- | --- | --- |
${rows.join("\n")}

## Passo 1. Instalar no ambiente DEV

Na pasta \`install/\`, conectado ao schema da aplicação pelo SQLcl:

\`\`\`sql
@instalar_tudo.sql
\`\`\`

Ele roda, nesta ordem: bibliotecas (packages), packages dos forms e a aplicação APEX (\`${basename(m.appFile)}\`). Detalhes e alternativas em COMO_IMPORTAR.md.${m.base ? `\n\nAtenção: \`${basename(m.appFile)}\` é o export completo da aplicação ${m.base.applicationId}; importar substitui a versão que está no workspace. Use um ambiente DEV ou importe com outro ID.` : ""}

## Passo 2. Responder as dúvidas de regra

Abra DUVIDAS_DE_REGRA.md com quem conhece o sistema (analista ou usuário-chave). Cada dúvida traz a pergunta, o motivo e o código original.

${blocking.length ? `Comece pelas **bloqueantes** (impedem publicar): ${blocking.map((d) => `${d.id} (${d.form})`).join(", ")}.` : "Nenhuma dúvida bloqueante."}
${high.length ? `\nDepois as **altas**: ${high.map((d) => `${d.id} (${d.form})`).join(", ")}.` : ""}

Com as respostas, ajuste o código no APEX (ou reenvie o form corrigido e rode de novo: as páginas mantêm os mesmos IDs).

## Passo 3. Ajustes manuais nas páginas

O que o gerador não posicionou sozinho. Cada item diz a página e o que fazer.

${manual.length ? manual.join("\n") : "- Nenhum."}

## Passo 4. Testar

- [ ] Cada form, pelo roteiro em \`forms/<FORM>/ROTEIRO_TESTES.md\`
${[...menuTests, ...navTests].join("\n")}

## Passo 5. Antes de publicar

- [ ] Autenticação e autorização: logins, perfis e roles do Forms não vêm no XML. Defina o Authentication Scheme e crie Authorization Schemes para as telas restritas.
- [ ] Relatórios (Oracle Reports): escolha a ferramenta de substituição para os itens apontados nas dúvidas.
- [ ] Application items (${m.globals.length ? m.globals.join(", ") : "nenhum"}): confirme que todos ainda são necessários.
- [ ] Teste com dados reais em volume de produção (Interactive Grid e consultas grandes).
- [ ] Treinamento rápido dos usuários: teclas do Forms (F7, F8, F10) viraram botões e busca.

## Arquivos

| Arquivo | Para quê |
| --- | --- |
| PROXIMOS_PASSOS.md | Este roteiro |
| DUVIDAS_DE_REGRA.md | Perguntas de regra de negócio, com código e sugestão |
| MAPA_DA_APLICACAO.md | Forms, páginas, menu, navegação, application items e bibliotecas |
| COMO_IMPORTAR.md | Como instalar e importar |
| DECISOES.md | Respostas da pré-orientação e riscos por form |
| install/ | Scripts na ordem de instalação |
| forms/<FORM>/ | Pendências, rastreabilidade, roteiro de testes e conversões de cada form |
`;
}

export function doubtsReport(m: AppModel): string {
  const index = m.doubts.map((d) => `| ${d.id} | ${SEV_LABEL[d.severity]} | ${d.form} | \`${cell(d.origin)}\` | ${cell(d.question).slice(0, 140)}${d.question.length > 140 ? "..." : ""} |`);
  const body = m.doubts.map(
    (d) => `## ${d.id} · ${SEV_LABEL[d.severity]} · ${d.form}

**Pergunta:** ${d.question}

| | |
| --- | --- |
| Origem | \`${cell(d.origin)}\`${d.pendingId ? ` (${d.pendingId} em forms/${d.form.toUpperCase()}/PENDENCIAS.md)` : ""} |
| Por que parou | ${cell(d.why)} |
| Sugestão | ${cell(d.suggestion)} |
${d.code ? `\n<details><summary>Código original</summary>\n\n\`\`\`sql\n${d.code}\n\`\`\`\n\n</details>\n` : ""}
- **Resposta:**
- **Decidido por / em:**
`,
  );
  return `# Dúvidas de regra: ${m.name}

O que a migração automática não decidiu sozinha. Cada dúvida é uma pergunta para quem conhece a regra de negócio; responda na linha "Resposta" e registre quem decidiu.
Ordem: bloqueantes, altas, médias e informativas. Bloqueantes impedem publicar.

**Total: ${m.doubts.length}** (bloqueantes ${count(m, "bloqueante")}, altas ${count(m, "alta")}, médias ${count(m, "media")}, informativas ${count(m, "informativa")})

| ID | Severidade | Form | Origem | Pergunta |
| --- | --- | --- | --- | --- |
${index.join("\n")}

${body.join("\n") || "Nenhuma dúvida."}
`;
}

function flatten(es: NavEntry[], path: string[] = []): { entry: NavEntry; path: string[] }[] {
  return es.flatMap((e) => [{ entry: e, path: [...path, e.label] }, ...flatten(e.children, [...path, e.label])]);
}

function menuTree(es: NavEntry[], depth = 0): string[] {
  return es.flatMap((e) => [`${"  ".repeat(depth)}- ${e.label}${e.page !== undefined ? ` → página ${e.page}${e.form ? ` (${e.form})` : ""}` : ""}`, ...menuTree(e.children, depth + 1)]);
}

export function mapReport(m: AppModel): string {
  const navFlat = flatten(m.nav);
  const forms = m.runs.map((r) => {
    const name = r.ir.form.name.toUpperCase();
    const menuPath = navFlat.find((e) => e.entry.form === name)?.path.join(" > ");
    const callers = [...(m.calledBy.get(name) ?? [])];
    return `| ${r.ir.form.name} | ${cell(r.ir.form.title ?? "")} | ${basename(r.file)} | ${pageRange(r)} | ${r.entry ?? "-"} | ${menuPath ?? (callers.length ? `aberto por ${callers.join(", ")}` : "fora do menu")} |`;
  });

  const edges: string[] = [];
  for (const r of m.runs)
    for (const x of r.converted.results) {
      const n = x.conversion?.navigation;
      if (!n) continue;
      const target = m.runs.find((t) => t.ir.form.name.toUpperCase() === n.form);
      edges.push(`| ${r.ir.form.name} | \`${x.trigger.owner}\` | ${n.builtin} | ${n.form} | ${target ? `página ${target.entry}` : "**form ausente**"} | ${n.globals.map((g) => g.item).join(", ") || "-"} |`);
    }

  const usage = (g: string) => {
    const short = g.replace(/^GLOBAL_/, "");
    const set = new Set<string>();
    const read = new Set<string>();
    const scan = (who: string, code: string) => {
      if (new RegExp(`:global\\.${short}\\s*:=`, "i").test(code)) set.add(who);
      if (new RegExp(`:global\\.${short}\\b(?!\\s*:=)`, "i").test(code)) read.add(who);
    };
    for (const r of m.runs) {
      for (const t of r.ir.triggers) scan(r.ir.form.name, t.code);
      for (const b of r.ir.blocks) if (b.where) scan(r.ir.form.name, b.where);
    }
    for (const mn of m.menus) for (const mm of mn.menu.menus) for (const it of mm.items) scan(`menu ${mn.menu.name}`, it.code);
    return `| ${g} | ${[...set].join(", ") || "-"} | ${[...read].join(", ") || "-"} |`;
  };

  const libs = m.libs.map((l) => {
    const inPkg = packagedUnits(l.units).map((u) => u.name);
    const out = l.units.filter((u) => !inPkg.includes(u.name)).map((u) => u.name);
    const users = m.runs.filter((r) => r.ir.attachedLibraries.some((a) => a.toUpperCase() === l.name)).map((r) => r.ir.form.name);
    return `| ${l.name} | ${packageName(l.name)} | ${inPkg.join(", ") || "-"} | ${out.join(", ") || "-"} | ${users.join(", ") || "-"} |`;
  });

  return `# Mapa da aplicação: ${m.name}

## Forms e páginas

Cada form recebeu uma faixa própria de páginas. A página de entrada é a consulta (Interactive Report) quando o form tem bloco mestre.

| Form | Título | Arquivo | Páginas | Entrada | Como se chega |
| --- | --- | --- | --- | --- | --- |
${forms.join("\n")}

## Navigation Menu

${m.menus.length ? `Gerado a partir do menu ${m.menus.map((x) => x.menu.name).join(", ")}.` : "Sem menu do Forms no lote: um item por form (forms que só abrem a partir de outro ficaram de fora)."}

${menuTree(m.nav).join("\n") || "- (vazio)"}

## Navegação entre forms

CALL_FORM, OPEN_FORM e NEW_FORM viraram botões "Redirect to Page" com os application items na URL.

| De | Gatilho | Chamada | Para | Página | Leva |
| --- | --- | --- | --- | --- | --- |
${edges.join("\n") || "| - | - | - | - | - | - |"}

## Application items (:GLOBAL do Forms)

| Item APEX | Preenchido em | Lido em |
| --- | --- | --- |
${m.globals.map(usage).join("\n") || "| - | - | - |"}

## Bibliotecas

| Biblioteca | Package | Units no package | Units fora (ver dúvidas) | Anexada em |
| --- | --- | --- | --- | --- |
${libs.join("\n") || "| - | - | - | - | - |"}

Chamadas às units das bibliotecas nas conversões já usam o nome qualificado (\`PACKAGE.UNIT\`).
`;
}

export function appGuide(m: AppModel): string {
  const file = basename(m.appFile);
  const how = m.base
    ? `\`${file}\` é o export da aplicação ${m.base.applicationId} (schema ${m.base.owner}, tema ${m.base.themeId ?? "?"}) com as páginas dos forms, o Navigation Menu e os application items já incluídos.
Importar substitui a aplicação ${m.base.applicationId} inteira, como qualquer export de aplicação.

\`\`\`sql
-- SQLcl, na pasta install/, conectado ao schema ${m.base.owner} no ambiente DEV
@instalar_tudo.sql
\`\`\`

Ou: compile os packages (\`01_*\` e \`02_*\`) e importe \`${file}\` no App Builder (Import > Application). Para não sobrescrever a aplicação atual, escolha "Auto Assign New Application ID" no import.`
    : `Sem export base o script não sabe workspace nem aplicação, e vale para uma aplicação que já existe. Defina antes (está comentado no topo de \`instalar_tudo.sql\`):

\`\`\`sql
begin
  apex_application_install.set_workspace('MEU_WORKSPACE');
  apex_application_install.set_application_id(100);
  apex_application_install.generate_offset;
  apex_application_install.set_schema('MEU_SCHEMA');
end;
/
@instalar_tudo.sql
\`\`\`

Recomendado: crie uma aplicação vazia no App Builder (Create App, só com a Home), exporte e rode o forms2apex de novo com \`--apex-base fNNN.sql\`. Assim o resultado é o export completo da aplicação, com os templates do tema e o menu já ligados.`;

  const pages = m.runs.flatMap((r) => r.apex.pages.map((p) => `| ${p.id} | ${r.ir.form.name} | ${cell(p.name)} | ${p.kind} |`));
  return `# Como importar no APEX: ${m.name}

Formato: APEX 26.1 (wwv_flow_imp). Rode primeiro num ambiente DEV.

## Instalar

${how}

## Ordem dos scripts

1. \`01_lib_*\`: packages das bibliotecas (.pll)
2. \`02_pkg_*\`: packages com as program units de cada form
3. \`${file}\`: a aplicação APEX

## Páginas geradas

| ID | Form | Nome | Tipo |
| --- | --- | --- | --- |
${pages.join("\n")}

## Depois do import

Siga PROXIMOS_PASSOS.md (passos 2 a 5).
${m.appManual.length ? `\n${m.appManual.map((x) => `- [ ] ${x}`).join("\n")}\n` : ""}`;
}

export function decisionsByForm(m: AppModel): string {
  const findings = m.runs.flatMap((r) => r.planned.findings.map((f) => ({ ...f, where: `${r.ir.form.name}: ${f.where}` })));
  return decisionsReport(m.profile, findings);
}
