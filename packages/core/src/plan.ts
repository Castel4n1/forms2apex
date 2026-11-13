import type { Block, IR, Item } from "./ir.ts";
import type { ResolvedProfile } from "./profile.ts";

export interface PlannedItem {
  formsItem: string; // BLOCO.ITEM
  apexName: string; // P10_NOME ou coluna do IG
  apexType: string;
  label?: string;
  required: boolean;
  lov?: string;
  column?: string;
}

export interface PlannedRegion {
  formsBlock: string;
  apexType: "form" | "interactive_grid" | "interactive_report_modal" | "static";
  source?: string;
  where?: string;
  orderBy?: string;
  masterBlock?: string;
  extraColumns: string[]; // vindas de POST-QUERY
  items: PlannedItem[];
}

export interface PlannedPage {
  id: number;
  name: string;
  regions: PlannedRegion[];
}

export interface Blueprint {
  application: { name: string; sourceForm: string };
  pages: PlannedPage[];
  lovs: { name: string; query: string }[];
  layoutNotes: string[];
}

const ITEM_TYPES: Record<string, string> = {
  "Text Item": "NATIVE_TEXT_FIELD",
  "Display Item": "NATIVE_DISPLAY_ONLY",
  "Check Box": "NATIVE_CHECKBOX",
  "List Item": "NATIVE_SELECT_LIST",
  "Radio Group": "NATIVE_RADIOGROUP",
  "Push Button": "BUTTON",
  Image: "NATIVE_IMAGE_UPLOAD",
};

function apexItemType(item: Item): string {
  if (item.lov) return "NATIVE_POPUP_LOV";
  if (item.type === "Text Item" && item.dataType === "Date") return "NATIVE_DATE_PICKER_APEX";
  if (item.type === "Text Item" && item.maxLength && item.maxLength > 255) return "NATIVE_TEXTAREA";
  return ITEM_TYPES[item.type] ?? "NATIVE_TEXT_FIELD";
}

function masterOf(block: Block, all: Block[]): string | undefined {
  if (!block.where) return undefined;
  const ref = block.where.match(/:(\w+)\.\w+/);
  const name = ref?.[1]?.toUpperCase();
  return all.some((b) => b.name.toUpperCase() === name && b !== block) ? name : undefined;
}

export function planApplication(ir: IR, profile: ResolvedProfile): Blueprint {
  const pages: PlannedPage[] = [];
  const pageOfBlock = new Map<string, PlannedPage>();
  let nextId = 10;

  // Blocos mestres (sem master) viram páginas; detalhes entram na página do mestre.
  const ordered = [...ir.blocks].sort((a, b) => Number(Boolean(masterOf(a, ir.blocks))) - Number(Boolean(masterOf(b, ir.blocks))));

  for (const block of ordered) {
    const master = masterOf(block, ir.blocks);
    let page = master ? pageOfBlock.get(master) : undefined;
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

    const isGrid = apexType === "interactive_grid";
    page.regions.push({
      formsBlock: block.name,
      apexType,
      source: block.source ?? undefined,
      where: block.where ?? undefined,
      orderBy: block.orderBy ?? undefined,
      masterBlock: master,
      extraColumns: [],
      items: block.items.map((it) => ({
        formsItem: `${block.name}.${it.name}`.toUpperCase(),
        apexName: isGrid ? it.name.toUpperCase() : `P${page!.id}_${it.name.toUpperCase()}`,
        apexType: apexItemType(it),
        label: it.prompt ?? it.label,
        required: it.required,
        lov: it.lov,
        column: it.dbItem ? it.column : undefined,
      })),
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
