import type { Block, IR, Item } from "./ir.ts";
import type { ResolvedProfile } from "./profile.ts";
import type { Lookup } from "./rules.ts";

export interface PlannedItem {
  formsItem: string; // BLOCO.ITEM
  apexName: string; // P10_NOME ou coluna do IG
  apexType: string;
  label?: string;
  required: boolean;
  lov?: string;
  column?: string;
  dataType: "NUMBER" | "VARCHAR2" | "DATE";
  maxLength?: number;
  primaryKey: boolean;
  /** Valor inicial do Forms já convertido em expressão PL/SQL. */
  defaultExpr?: string;
  /** Lista estática (List Item, Radio Group, Check Box com valores próprios). */
  staticValues?: { label: string; value: string }[];
}

export interface PlannedRegion {
  formsBlock: string;
  apexType: "form" | "interactive_grid" | "interactive_report_modal" | "static";
  source?: string;
  where?: string;
  orderBy?: string;
  masterBlock?: string;
  /** Coluna do detalhe ligada ao mestre e item do mestre (BLOCO.ITEM) que a alimenta. */
  link?: { column: string; masterItem: string };
  insertAllowed: boolean;
  updateAllowed: boolean;
  deleteAllowed: boolean;
  extraColumns: string[]; // vindas de POST-QUERY
  /** Buscas de descrição convertidas (POST-QUERY / WHEN-VALIDATE-ITEM). */
  lookups: Lookup[];
  /** Query final da região (montada em enrichRegions). */
  query?: string;
  items: PlannedItem[];
}

export interface PlannedPage {
  id: number;
  name: string;
  regions: PlannedRegion[];
  /** Página de consulta (Interactive Report) que lista o bloco mestre e abre esta página. */
  listPageId?: number;
}

export interface Blueprint {
  application: { name: string; sourceForm: string };
  pages: PlannedPage[];
  lovs: { name: string; query: string }[];
  layoutNotes: string[];
}

export interface PlanOptions {
  /** Páginas já existentes na aplicação APEX de destino: o plano escolhe uma faixa livre. */
  usedPages?: Set<number>;
}

const ITEM_TYPES: Record<string, string> = {
  "Text Item": "NATIVE_TEXT_FIELD",
  "Display Item": "NATIVE_DISPLAY_ONLY",
  "Check Box": "NATIVE_SINGLE_CHECKBOX",
  "List Item": "NATIVE_SELECT_LIST",
  "Radio Group": "NATIVE_RADIOGROUP",
  "Push Button": "BUTTON",
  Image: "NATIVE_IMAGE_UPLOAD",
};

const YES = /^(y|s|sim|yes|1|t|true)$/i;

function dataTypeOf(item: Item): PlannedItem["dataType"] {
  const d = (item.dataType ?? "").toLowerCase();
  if (/number|integer|int|float|money/.test(d)) return "NUMBER";
  if (/date|datetime/.test(d)) return "DATE";
  return "VARCHAR2";
}

function apexItemType(item: Item, pk: boolean): string {
  if (item.type === "Push Button") return "BUTTON";
  if (pk || !item.visible) return "NATIVE_HIDDEN";
  if (item.lov) return "NATIVE_POPUP_LOV";
  if (item.type === "Check Box" && item.checkedValue && !YES.test(item.checkedValue)) return "NATIVE_SELECT_LIST";
  if (item.type === "Text Item") {
    if (dataTypeOf(item) === "DATE") return "NATIVE_DATE_PICKER_APEX";
    if (dataTypeOf(item) === "NUMBER") return "NATIVE_NUMBER_FIELD";
    if (item.maxLength && item.maxLength > 255) return "NATIVE_TEXTAREA";
  }
  return ITEM_TYPES[item.type] ?? "NATIVE_TEXT_FIELD";
}

/** Initial Value do Forms ($$DATE$$, literal, :BLOCO.ITEM) em expressão PL/SQL. */
function defaultExpr(item: Item): string | undefined {
  const v = item.initialValue?.trim();
  if (!v) return undefined;
  const sys: Record<string, string> = { $$DATE$$: "trunc(sysdate)", $$DATETIME$$: "sysdate", $$DBDATE$$: "trunc(sysdate)", $$DBDATETIME$$: "sysdate", $$TIME$$: "sysdate", $$DBTIME$$: "sysdate" };
  if (sys[v.toUpperCase()]) return sys[v.toUpperCase()];
  if (v.startsWith(":")) return v; // bind, traduzido depois
  if (dataTypeOf(item) === "NUMBER" && /^-?\d+(\.\d+)?$/.test(v)) return v;
  return `'${v.replace(/'/g, "''")}'`;
}

function staticValues(item: Item) {
  if (item.listValues?.length) return item.listValues;
  if (item.type === "Check Box" && item.checkedValue && !YES.test(item.checkedValue)) {
    return [
      { label: "Sim", value: item.checkedValue },
      ...(item.uncheckedValue ? [{ label: "Não", value: item.uncheckedValue }] : []),
    ];
  }
  return undefined;
}

/** Item que é PK: PrimaryKey no XML; senão o item preenchido por sequence no PRE-INSERT; senão um item chamado ID. */
function primaryKeyOf(block: Block, ir: IR): string | undefined {
  const flagged = block.items.find((i) => i.primaryKey);
  if (flagged) return flagged.name.toUpperCase();
  for (const t of ir.triggers.filter((x) => x.name === "PRE-INSERT" && x.owner.toUpperCase() === block.name.toUpperCase())) {
    const m = t.code.match(/\.nextval\s+into\s+:(\w+)\.(\w+)/i);
    if (m && m[1].toUpperCase() === block.name.toUpperCase()) return m[2].toUpperCase();
  }
  return block.items.find((i) => i.dbItem && i.name.toUpperCase() === "ID")?.name.toUpperCase();
}

function masterLink(block: Block, all: Block[]): { master: string; column: string; masterItem: string } | undefined {
  if (!block.where) return undefined;
  const m = block.where.match(/(?:\w+\.)?(\w+)\s*=\s*:(\w+)\.(\w+)/);
  const name = m?.[2]?.toUpperCase();
  if (!m || !all.some((b) => b.name.toUpperCase() === name && b !== block)) return undefined;
  return { master: name!, column: m[1].toUpperCase(), masterItem: `${name}.${m[3].toUpperCase()}` };
}

/** Primeira faixa (10, 1000, 2000...) sem nenhuma página já usada na aplicação de destino. */
function firstFreePage(needed: number, used?: Set<number>): number {
  if (!used?.size) return 10;
  for (let start = 10; start < 100000; start = start === 10 ? 1000 : start + 1000) {
    let free = true;
    for (let p = start; p <= start + needed; p++) if (used.has(p)) free = false;
    if (free) return start;
  }
  throw new Error("Não há faixa de páginas livre na aplicação de destino");
}

export function planApplication(ir: IR, profile: ResolvedProfile, opts: PlanOptions = {}): Blueprint {
  const pages: PlannedPage[] = [];
  const pageOfBlock = new Map<string, PlannedPage>();
  let nextId = firstFreePage(ir.blocks.length * 10 + 10, opts.usedPages);

  // Blocos mestres (sem master) viram páginas; detalhes entram na página do mestre.
  const ordered = [...ir.blocks].sort((a, b) => Number(Boolean(masterLink(a, ir.blocks))) - Number(Boolean(masterLink(b, ir.blocks))));

  for (const block of ordered) {
    const link = masterLink(block, ir.blocks);
    let page = link ? pageOfBlock.get(link.master) : undefined;
    if (!page && !block.dbBlock && pages.length) page = pages[0];
    if (!page) {
      page = { id: nextId, name: block.name, regions: [] };
      nextId += 10;
      pages.push(page);
    }
    pageOfBlock.set(block.name.toUpperCase(), page);

    const multi = block.records > 1;
    const apexType: PlannedRegion["apexType"] = !block.dbBlock
      ? "static"
      : multi
        ? profile.answers.multirregistro === "report_modal"
          ? "interactive_report_modal"
          : "interactive_grid"
        : "form";

    // Form mestre ganha página de consulta (Interactive Report) que abre o registro: equivale ao Enter/Execute Query.
    if (apexType === "form" && !link && page.listPageId === undefined) page.listPageId = page.id + 5;

    const isGrid = apexType === "interactive_grid" || apexType === "interactive_report_modal";
    const pk = block.dbBlock ? primaryKeyOf(block, ir) : undefined;
    page.regions.push({
      formsBlock: block.name,
      apexType,
      source: block.source ?? undefined,
      where: block.where ?? undefined,
      orderBy: block.orderBy ?? undefined,
      masterBlock: link?.master,
      link: link ? { column: link.column, masterItem: link.masterItem } : undefined,
      insertAllowed: block.insertAllowed,
      updateAllowed: block.updateAllowed,
      deleteAllowed: block.deleteAllowed,
      extraColumns: [],
      lookups: [],
      items: block.items.map((it) => {
        const isPk = it.name.toUpperCase() === pk;
        // No IG o bind de linha é o nome da coluna da query, não o nome do item do Forms.
        const gridName = (it.dbItem && it.type !== "Push Button" ? (it.column ?? it.name) : it.name).toUpperCase();
        return {
          formsItem: `${block.name}.${it.name}`.toUpperCase(),
          apexName: isGrid ? gridName : `P${page!.id}_${it.name.toUpperCase()}`,
          apexType: apexItemType(it, isPk),
          label: it.prompt ?? it.label,
          required: it.required,
          lov: it.lov,
          column: it.dbItem && it.type !== "Push Button" ? (it.column ?? it.name).toUpperCase() : undefined,
          dataType: dataTypeOf(it),
          maxLength: it.maxLength,
          primaryKey: isPk,
          defaultExpr: defaultExpr(it),
          staticValues: staticValues(it),
        };
      }),
    });
  }

  const rgQuery = new Map(ir.recordGroups.map((r) => [r.name.toUpperCase(), r.query]));
  const fid = profile.answers.fidelidade;
  return {
    application: { name: ir.form.title ?? ir.form.name, sourceForm: ir.form.name },
    pages,
    lovs: ir.lovs.map((l) => ({ name: l.name, query: rgQuery.get((l.recordGroup ?? "").toUpperCase()) ?? "" })),
    layoutNotes: [
      fid === "proximo_forms"
        ? "Manter ordem dos campos, rótulos e agrupamento por canvas do Forms; usar Grid Layout com colunas fixas."
        : fid === "moderno"
          ? "Usar layout padrão do Universal Theme; agrupar campos por afinidade e não pela posição do Forms."
          : "Manter ordem dos campos e navegação do Forms, com componentes e espaçamento nativos do APEX.",
    ],
  };
}

export function bindMapper(bp: Blueprint) {
  const map = new Map<string, string>();
  for (const p of bp.pages) for (const r of p.regions) for (const i of r.items) map.set(i.formsItem, i.apexName);
  return {
    map: Object.fromEntries(map),
    fn: (block: string, item: string) => map.get(`${block}.${item}`) ?? `${block}_${item}`,
  };
}
