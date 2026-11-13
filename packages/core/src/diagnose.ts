import type { IR } from "./ir.ts";

export type Severity = "bloqueante" | "alta" | "media" | "informativa";

export interface Risk {
  id: string;
  pattern: RegExp;
  severity: Severity;
  reason: string;
  suggestion: string;
}

/** Recursos do Forms sem equivalente direto no APEX ou que exigem revisão de segurança. */
export const RISKS: Risk[] = [
  { id: "HOST", pattern: /\bhost\s*\(/i, severity: "bloqueante", reason: "Executa comando no sistema operacional do cliente", suggestion: "Substituir por processo no servidor, job ou serviço REST" },
  { id: "TEXT_IO", pattern: /\btext_io\./i, severity: "alta", reason: "Lê ou grava arquivo na máquina do cliente", suggestion: "Usar upload/download do APEX ou UTL_FILE no servidor" },
  { id: "WEBUTIL", pattern: /\b(webutil|client_)\w*/i, severity: "alta", reason: "Interage com a máquina do cliente via WebUtil", suggestion: "Recriar com upload/download nativo do APEX" },
  { id: "NAVEGACAO_FORMS", pattern: /\b(call_form|open_form|new_form)\s*\(/i, severity: "media", reason: "Navegação entre forms", suggestion: "Converter em link entre páginas APEX com passagem de itens" },
  { id: "GLOBAL", pattern: /:global\.\w+/i, severity: "media", reason: "Uso de variáveis :GLOBAL", suggestion: "Converter em itens de aplicação (Application Items)" },
  { id: "REPORTS", pattern: /\b(run_report_object|run_product)\b/i, severity: "alta", reason: "Chama Oracle Reports", suggestion: "Definir solução de relatório (APEX Office Print, PL/PDF, BI Publisher)" },
  { id: "SERVICO_EXTERNO", pattern: /\b(utl_http|utl_tcp|utl_smtp|apex_web_service)\b/i, severity: "bloqueante", reason: "Chama serviço externo", suggestion: "Revisar credenciais, ACL de rede e tratamento de erro antes de migrar" },
  { id: "DB_LINK", pattern: /\b\w+@\w+\b/, severity: "alta", reason: "Usa database link", suggestion: "Confirmar se o DB link existe no ambiente APEX e quem tem acesso" },
  { id: "DBMS_PIPE", pattern: /\bdbms_pipe\b/i, severity: "alta", reason: "Comunicação via DBMS_PIPE", suggestion: "Revisar a arquitetura; considerar AQ ou tabela de fila" },
  { id: "TRANSACAO", pattern: /\b(commit|rollback|forms_ddl)\b(?!_form)/i, severity: "media", reason: "Controle de transação ou DDL explícito", suggestion: "No APEX a transação é por requisição; revisar o momento do commit" },
  { id: "TIMER", pattern: /\b(create_timer|when-timer-expired)\b/i, severity: "media", reason: "Timer do Forms", suggestion: "Usar Dynamic Action com intervalo ou refresh periódico" },
  { id: "OLE_JAVA", pattern: /\b(ole2|java_|set_custom_property|get_custom_property)\b/i, severity: "alta", reason: "OLE, JavaBean ou PJC", suggestion: "Reimplementar com componente web ou plugin APEX" },
];

export interface Finding {
  riskId: string;
  severity: Severity;
  reason: string;
  suggestion: string;
  where: string;
}

export function scanCode(code: string, where: string): Finding[] {
  return RISKS.filter((r) => r.pattern.test(code)).map((r) => ({
    riskId: r.id,
    severity: r.severity,
    reason: r.reason,
    suggestion: r.suggestion,
    where,
  }));
}

export function diagnose(ir: IR): Finding[] {
  const findings: Finding[] = [];
  for (const t of ir.triggers) findings.push(...scanCode(t.code, `${t.owner} / ${t.name}`));
  for (const p of ir.programUnits) findings.push(...scanCode(p.code, `Program unit ${p.name}`));
  for (const lib of ir.attachedLibraries) {
    findings.push({
      riskId: "PLL",
      severity: "alta",
      reason: `Biblioteca anexada ${lib} não veio no XML`,
      suggestion: "Converter a PLL separadamente e reexecutar",
      where: "Form",
    });
  }
  return findings;
}
