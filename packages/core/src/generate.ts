import type { IR } from "./ir.ts";
import type { Blueprint } from "./plan.ts";
import { translateBinds, type BindMapper } from "./rules.ts";
import type { TriggerResult } from "./convert.ts";

/** Coloca as colunas vindas de POST-QUERY na região certa e gera a query de cada região. */
export function enrichRegions(bp: Blueprint, results: TriggerResult[], mapBind: BindMapper) {
  for (const r of results) {
    if (r.conversion?.apexComponent !== "region_query" || !r.conversion.code) continue;
    const block = r.trigger.owner.split(".")[0].toUpperCase();
    for (const p of bp.pages) for (const reg of p.regions) if (reg.formsBlock.toUpperCase() === block) reg.extraColumns.push(r.conversion.code);
  }
  for (const p of bp.pages) {
    for (const reg of p.regions) {
      if (!reg.source) continue;
      const cols = reg.items.filter((i) => i.column).map((i) => `t.${i.column!.toLowerCase()}`);
      const select = [...cols, ...reg.extraColumns].join(",\n       ") || "t.*";
      const where = reg.where ? `\n where ${translateBinds(reg.where, mapBind).replace(/\b(\w+)\s*=/, "t.$1 =")}` : "";
      const order = reg.orderBy ? `\n order by ${reg.orderBy}` : "";
      (reg as typeof reg & { query: string }).query = `select ${select}\n  from ${reg.source.toLowerCase()} t${where}${order}`;
    }
  }
}

function header(code: string): string {
  const m = code.match(/^\s*((?:function|procedure)\s+[\s\S]*?)\s+(is|as)\b/i);
  return m ? m[1].replace(/\s+/g, " ").trim() : "";
}

export function generatePackage(ir: IR): string {
  const pkg = `${ir.form.name.toUpperCase()}_PKG`.slice(0, 128);
  const units = ir.programUnits.filter((p) => /^(function|procedure)$/i.test(p.kind));
  const spec = units.map((u) => `  ${header(u.code)};`).filter((s) => s.trim() !== ";").join("\n");
  const body = units.map((u) => `  ${u.code.split("\n").join("\n  ")}`).join("\n\n");
  const skipped = ir.programUnits.filter((p) => !units.includes(p)).map((p) => `-- Não incluído automaticamente: ${p.kind} ${p.name}`).join("\n");
  return `-- Gerado pelo forms2apex a partir do form ${ir.form.name}
-- Revise PENDENCIAS.md antes de compilar.
${skipped}
create or replace package ${pkg} as
${spec || "  null;"}
end ${pkg};
/

create or replace package body ${pkg} as
${body || "  null;"}
end ${pkg};
/
`;
}

export function generateLovs(bp: Blueprint): string {
  return bp.lovs
    .map(
      (l) => `-- LOV ${l.name}
-- Criar em Shared Components > List of Values (Dynamic), com a query:
${l.query || "-- record group não encontrado no XML"}
`,
    )
    .join("\n");
}

export function generateRegionQueries(bp: Blueprint): string {
  const out: string[] = [];
  for (const p of bp.pages)
    for (const r of p.regions) {
      const q = (r as typeof r & { query?: string }).query;
      if (q) out.push(`-- Página ${p.id} / região ${r.formsBlock} (${r.apexType})\n${q};\n`);
    }
  return out.join("\n");
}
