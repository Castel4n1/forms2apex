import type { IR } from "./ir.ts";
import type { Blueprint, PlannedRegion } from "./plan.ts";
import { translateBinds, type BindMapper } from "./rules.ts";
import { programUnitIssues, type TriggerResult } from "./convert.ts";

/** Coluna de banco que alimenta um item BLOCO.ITEM (ou o próprio nome do item). */
function columnOf(reg: PlannedRegion, formsItem: string): string {
  return (reg.items.find((i) => i.formsItem === formsItem)?.column ?? formsItem.split(".")[1]).toLowerCase();
}

/** Coloca as buscas de descrição (POST-QUERY / WHEN-VALIDATE-ITEM) na região certa e gera a query de cada região. */
export function enrichRegions(bp: Blueprint, results: TriggerResult[], mapBind: BindMapper) {
  for (const r of results) {
    const lookups = r.conversion?.lookups;
    if (!lookups?.length) continue;
    const block = r.trigger.owner.split(".")[0].toUpperCase();
    for (const p of bp.pages)
      for (const reg of p.regions) {
        if (reg.formsBlock.toUpperCase() !== block) continue;
        for (const l of lookups) if (!reg.lookups.some((x) => x.target === l.target)) reg.lookups.push(l);
      }
  }
  for (const p of bp.pages) {
    for (const reg of p.regions) {
      reg.extraColumns = reg.lookups.map(
        (l) => `(select ${l.column} from ${l.table} x where x.${l.keyColumn} = t.${columnOf(reg, l.sourceItem)}) as ${l.target.split(".")[1]}`.toLowerCase(),
      );
      if (!reg.source) continue;
      const cols = reg.items.filter((i) => i.column).map((i) => `t.${i.column!.toLowerCase()}`);
      const grid = reg.apexType !== "form" && reg.apexType !== "static";
      if (grid && reg.link && !cols.includes(`t.${reg.link.column.toLowerCase()}`)) cols.push(`t.${reg.link.column.toLowerCase()}`);
      if (grid && !reg.items.some((i) => i.primaryKey)) cols.unshift("t.rowid");
      const select = [...cols, ...reg.extraColumns].join(",\n       ") || "t.*";
      const where = reg.where ? `\n where ${translateBinds(reg.where, mapBind).replace(/^\s*(\w+)\s*=/, "t.$1 =")}` : "";
      const order = reg.orderBy ? `\n order by ${reg.orderBy}` : "";
      reg.query = `select ${select}\n  from ${reg.source.toLowerCase()} t${where}${order}`;
    }
  }
}

function header(code: string): string {
  const m = code.match(/^\s*((?:function|procedure)\s+[\s\S]*?)\s+(is|as)\b/i);
  return m ? m[1].replace(/\s+/g, " ").trim() : "";
}

type Unit = IR["programUnits"][number];

/** Nome do package que recebe as program units de um form ou de uma biblioteca. */
export const packageName = (module: string) => `${module.toUpperCase()}_PKG`.slice(0, 128);

/** Units que compilam fora do Forms e entram no package (as demais ficam comentadas até resolver a pendência). */
export function packagedUnits(units: Unit[]): Unit[] {
  return units.filter((p) => /^(function|procedure)$/i.test(p.kind) && !programUnitIssues(p).reasons.length && header(p.code));
}

export function generatePackage(ir: IR): string {
  return generateUnitsPackage(ir.form.name, `form ${ir.form.name}`, ir.programUnits);
}

export function generateUnitsPackage(module: string, origin: string, all: Unit[]): string {
  const pkg = packageName(module);
  const units = packagedUnits(all);
  const spec = units.map((u) => `  ${header(u.code)};`).join("\n");
  const body = units.map((u) => `  ${u.code.split("\n").join("\n  ")}`).join("\n\n");
  const skipped = all
    .filter((p) => !units.includes(p))
    .map((p) => {
      const why = programUnitIssues(p).reasons.join("; ") || `tipo ${p.kind} não vai para package`;
      return `-- Não incluído: ${p.kind} ${p.name} (${why}). Veja PENDENCIAS.md.\n${p.code.split("\n").map((l) => `--   ${l}`).join("\n")}`;
    })
    .join("\n\n");
  const head = `set define off
-- Gerado pelo forms2apex a partir do ${origin}
-- Revise PENDENCIAS.md antes de compilar.
${skipped ? `\n${skipped}\n` : ""}`;
  if (!units.length) return `${head}\n-- Nenhuma program unit pronta para package; nada a compilar.\n`;
  return `${head}
create or replace package ${pkg} as
${spec}
end ${pkg};
/

create or replace package body ${pkg} as
${body}
end ${pkg};
/
`;
}

/**
 * Chamadas a program units que foram para package passam a usar o nome qualificado (PKG.UNIT),
 * fora de literais e sem mexer em quem já está qualificado.
 */
export function qualifyCalls(code: string, units: Map<string, string>): string {
  if (!units.size) return code;
  return code
    .split(/('(?:[^']|'')*')/)
    .map((part, i) =>
      i % 2
        ? part
        : part.replace(/(?<![\w.$#])(\w+)(\s*\()/g, (m, name: string, paren: string) => {
            const pkg = units.get(name.toUpperCase());
            return pkg ? `${pkg}.${name}${paren}` : m;
          }),
    )
    .join("");
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
      const q = r.query;
      if (q) out.push(`-- Página ${p.id} / região ${r.formsBlock} (${r.apexType})\n${q};\n`);
    }
  return out.join("\n");
}
