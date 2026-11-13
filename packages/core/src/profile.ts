import { z } from "zod";

/**
 * Pré-orientação: decisões tomadas pelo usuário ANTES da geração.
 * Toda pergunta aceita "nao_sei", que aplica um padrão seguro e vira registro no relatório.
 */
export const QUESTIONS = [
  {
    id: "fidelidade",
    label: "Fidelidade visual das telas",
    options: [
      { value: "proximo_forms", label: "Manter o mais próximo do Forms" },
      { value: "moderno", label: "Modernizar no estilo APEX" },
      { value: "hibrido", label: "Híbrido (mesma ordem e navegação, componentes APEX)" },
    ],
    safeDefault: "hibrido",
  },
  {
    id: "multirregistro",
    label: "Blocos com vários registros",
    options: [
      { value: "interactive_grid", label: "Interactive Grid" },
      { value: "report_modal", label: "Interactive Report + formulário modal" },
    ],
    safeDefault: "interactive_grid",
  },
  {
    id: "program_units",
    label: "Program units e PLLs",
    options: [
      { value: "package", label: "Mover para package no banco" },
      { value: "pagina", label: "Manter na página" },
    ],
    safeDefault: "package",
  },
  {
    id: "validacoes",
    label: "Onde rodar as validações",
    options: [
      { value: "servidor", label: "Servidor" },
      { value: "ambos", label: "Servidor e cliente" },
    ],
    safeDefault: "servidor",
  },
  {
    id: "teclas_menus",
    label: "Teclas (KEY-*) e menus",
    options: [
      { value: "botoes", label: "Recriar como botões" },
      { value: "ignorar", label: "Ignorar" },
    ],
    safeDefault: "botoes",
  },
  {
    id: "uso_ia",
    label: "Usar IA nos casos que as regras não resolvem",
    options: [
      { value: "sim", label: "Sim" },
      { value: "nao", label: "Não, só regras (tudo o mais vira pendência)" },
    ],
    safeDefault: "nao",
  },
] as const;

export type QuestionId = (typeof QUESTIONS)[number]["id"];

export const ProfileSchema = z.record(z.string(), z.string());
export type RawProfile = z.infer<typeof ProfileSchema>;

export interface ResolvedProfile {
  answers: Record<QuestionId, string>;
  unknown: QuestionId[];
}

export function resolveProfile(raw: RawProfile = {}): ResolvedProfile {
  const answers = {} as Record<QuestionId, string>;
  const unknown: QuestionId[] = [];
  for (const q of QUESTIONS) {
    const given = raw[q.id];
    const valid = q.options.some((o) => o.value === given);
    if (!given || given === "nao_sei" || !valid) {
      answers[q.id] = q.safeDefault;
      unknown.push(q.id);
    } else {
      answers[q.id] = given;
    }
  }
  return { answers, unknown };
}
