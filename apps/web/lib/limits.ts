// Limites da demo pública. Ajuste por variável de ambiente.
export const LIMITS = {
  maxBytes: Number(process.env.F2A_MAX_BYTES ?? 2 * 1024 * 1024),
  /** Export da aplicação APEX de destino (fNNN.sql) costuma ser bem maior que um form. */
  maxBaseBytes: Number(process.env.F2A_MAX_BASE_BYTES ?? 40 * 1024 * 1024),
  maxFiles: Number(process.env.F2A_MAX_FILES ?? 60),
  maxForms: Number(process.env.F2A_MAX_FORMS ?? 40),
  maxBlocks: Number(process.env.F2A_MAX_BLOCKS ?? 10),
  maxTriggers: Number(process.env.F2A_MAX_TRIGGERS ?? 60),
  perIpPerHour: Number(process.env.F2A_RATE_PER_HOUR ?? 10),
};

const hits = new Map<string, number[]>();

/** Rate limit simples em memória. Em produção, troque por Redis ou pelo Cloudflare. */
export function allow(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= LIMITS.perIpPerHour) return false;
  recent.push(now);
  hits.set(ip, recent);
  return true;
}
