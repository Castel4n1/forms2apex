import type { Finding } from "./diagnose.ts";
import type { IR } from "./ir.ts";
import type { Blueprint } from "./plan.ts";
import { QUESTIONS, type ResolvedProfile } from "./profile.ts";
import type { Pending, TriggerResult } from "./convert.ts";

const SEV_ORDER = { bloqueante: 0, alta: 1, media: 2, informativa: 3 } as const;
const fence = (code: string) => "```sql\n" + code + "\n```";

export function pendingReport(ir: IR, pending: Pending[]): string {
  const sorted = [...pending].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
  const count = (s: Pending["severity"]) => pending.filter((p) => p.severity === s).length;
  const rows = sorted
    .map(
      (p) => `## ${p.id} · ${p.severity.toUpperCase()}

| Campo | Valor |
| --- | --- |
| Origem | \`${p.origin}\` |
| Motivo | ${p.reason} |
| Sugestão | ${p.suggestion} |
| Status | ${p.status} |

${fence(p.originalCode)}
`,
    )
    .join("\n");
  return `# Regras pendentes: ${ir.form.name}

Total: ${pending.length} (bloqueantes ${count("bloqueante")}, altas ${count("alta")}, médias ${count("media")}, informativas ${count("informativa")}).
Nenhum item abaixo foi migrado automaticamente com segurança. Resolva os bloqueantes antes de publicar.
${ir.meta.secretsMasked ? `\nAtenção: ${ir.meta.secretsMasked} possível(is) credencial(is) foram mascaradas no código. Verifique o form original.\n` : ""}
${rows || "Nenhuma pendência encontrada."}
`;
}

export function traceReport(bp: Blueprint, results: TriggerResult[]): string {
  const items = bp.pages.flatMap((p) => p.regions.flatMap((r) => r.items.map((i) => `| \`${i.formsItem}\` | Página ${p.id} / ${r.apexType} | \`${i.apexName}\` (${i.apexType}) |`)));
  const trig = results.map((r) => {
    const dest = r.conversion ? `${r.conversion.apexComponent} (${r.conversion.source}, ${r.conversion.confidence.toFixed(2)})` : "não convertido";
    return `| \`${r.trigger.owner} / ${r.trigger.name}\` | ${dest} | ${r.pendingIds.join(", ") || "-"} |`;
  });
  return `# Rastreabilidade

## Itens

| Forms | Destino | Item APEX |
| --- | --- | --- |
${items.join("\n")}

## Triggers

| Forms | Componente APEX | Pendências |
| --- | --- | --- |
${trig.join("\n")}
`;
}

export function decisionsReport(profile: ResolvedProfile, findings: Finding[]): string {
  const rows = QUESTIONS.map((q) => {
    const opt = q.options.find((o) => o.value === profile.answers[q.id]);
    const unk = profile.unknown.includes(q.id);
    return `| ${q.label} | ${opt?.label ?? profile.answers[q.id]} | ${unk ? "Não sabia: padrão seguro aplicado, confirmar" : "Escolha do usuário"} |`;
  });
  const risks = findings.length
    ? findings.map((f) => `- **${f.severity}** · ${f.where}: ${f.reason}`).join("\n")
    : "- Nenhum risco detectado.";
  return `# Decisões da pré-orientação

| Pergunta | Decisão | Origem |
| --- | --- | --- |
${rows.join("\n")}

## Diagnóstico automático

${risks}
`;
}

export function testScript(bp: Blueprint, results: TriggerResult[]): string {
  const lines: string[] = [];
  for (const p of bp.pages) {
    lines.push(`## Página ${p.id}: ${p.name}`);
    for (const r of p.regions) {
      lines.push(`- [ ] Região ${r.formsBlock} abre e lista os mesmos registros do Forms`);
      if (r.masterBlock) lines.push(`- [ ] Detalhe ${r.formsBlock} filtra pelo registro de ${r.masterBlock}`);
      for (const i of r.items.filter((x) => x.required)) lines.push(`- [ ] Salvar sem ${i.label ?? i.apexName} mostra erro de obrigatório`);
    }
  }
  for (const r of results.filter((x) => x.conversion?.apexComponent === "validation")) {
    lines.push(`- [ ] Validação de ${r.trigger.owner}: valor inválido bloqueia e valor válido passa`);
  }
  return `# Roteiro de testes\n\n${lines.join("\n")}\n`;
}
