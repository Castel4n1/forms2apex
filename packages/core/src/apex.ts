import { createHash } from "node:crypto";
import type { TriggerResult } from "./convert.ts";
import type { IR } from "./ir.ts";
import type { Blueprint, PlannedItem, PlannedPage, PlannedRegion } from "./plan.ts";
import { translateExpr, type Assignment, type BindMapper, type Conversion, type Lookup } from "./rules.ts";

/**
 * Fase 3: gera um script de import de PÁGINAS (formato "Page Export") para uma aplicação APEX existente.
 *
 * As chamadas wwv_flow_imp_page.* e seus parâmetros foram copiados de um export real do APEX 26.1.
 * Com um export da aplicação de destino (--apex-base), o script herda workspace, aplicação, offset e
 * os templates padrão do tema, igual a um export de página feito pelo próprio App Builder.
 * Sem export base, o script exige apex_application_install e deixa os templates em branco (padrão do tema).
 */

export const APEX_TARGET = { release: "26.1.0", versionDate: "2026.03.30" };

export interface ApexBase {
  release: string;
  versionDate: string;
  workspaceId: string;
  applicationId: string;
  idOffset: string;
  owner: string;
  themeId?: string;
  templates: { page?: string; region?: string; form?: string; irr?: string; button?: string; label?: string; requiredLabel?: string };
  usedPages: Set<number>;
}

/** Lê o cabeçalho, o tema atual e as páginas de um export de aplicação APEX (fNNN.sql). */
export function parseApexBase(sql: string): ApexBase {
  const begin = sql.match(/wwv_flow_imp\.import_begin\s*\(([\s\S]*?)\);/);
  if (!begin) throw new Error("Export APEX inválido: import_begin não encontrado (é um export do APEX 23.2 ou mais novo?)");
  const param = (name: string, src: string) => src.match(new RegExp(`p_${name}=>'?([^',\\n)]+)'?`))?.[1];
  const flow = sql.match(/create_flow\s*\(([\s\S]*?)\n\);/);
  const themeId = flow ? param("theme_id", flow[1]) : undefined;
  const theme = [...sql.matchAll(/create_theme\s*\(([\s\S]*?)\n\);/g)].map((m) => m[1]).find((t) => new RegExp(`p_theme_id=>${themeId}\\b`).test(t));
  const tpl = (name: string) => theme?.match(new RegExp(`p_default_${name}=>wwv_flow_imp\\.id\\((\\d+)\\)`))?.[1];
  const required = (v: string | undefined, name: string) => {
    if (!v) throw new Error(`Export APEX inválido: ${name} não encontrado`);
    return v;
  };
  return {
    release: required(param("release", begin[1]), "p_release"),
    versionDate: required(param("version_yyyy_mm_dd", begin[1]), "p_version_yyyy_mm_dd"),
    workspaceId: required(param("default_workspace_id", begin[1]), "p_default_workspace_id"),
    applicationId: required(param("default_application_id", begin[1]), "p_default_application_id"),
    idOffset: required(param("default_id_offset", begin[1]), "p_default_id_offset"),
    owner: required(param("default_owner", begin[1]), "p_default_owner"),
    themeId,
    templates: {
      page: tpl("page_template"),
      region: tpl("region_template"),
      form: tpl("form_template"),
      irr: tpl("irr_template"),
      button: tpl("button_template"),
      label: tpl("label_template"),
      requiredLabel: tpl("required_label"),
    },
    usedPages: new Set([...sql.matchAll(/wwv_flow_imp_page\.create_page\(\s*p_id=>(\d+)/g)].map((m) => Number(m[1]))),
  };
}

// ---------- serialização no formato do export ----------

/** Comentários do script ficam em ASCII, como no export oficial. */
const sqlComment = (t: string) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7e]/g, "?");

/** Literal SQL. Não ASCII vira unistr('\00E7'), como o APEX exporta, para não depender do charset do cliente SQL. */
export function sqlString(s: string): string {
  const esc = s.replace(/'/g, "''");
  if (/^[\x20-\x7e]*$/.test(esc)) return `'${esc}'`;
  let out = "";
  for (let i = 0; i < esc.length; i++) {
    const c = esc.charCodeAt(i);
    if (esc[i] === "\\") out += "\\005C";
    else if (c >= 0x20 && c < 0x7f) out += esc[i];
    else out += "\\" + c.toString(16).toUpperCase().padStart(4, "0");
  }
  return `unistr('${out}')`;
}

/** Texto longo: uma linha por elemento, como wwv_flow_string.join do export. */
export function sqlText(s: string): string {
  const lines = s.replace(/\r\n/g, "\n").split("\n");
  return lines.length === 1 ? sqlString(s) : `wwv_flow_string.join(wwv_flow_t_varchar2(\n${lines.map(sqlString).join(",\n")}))`;
}

function sqlAttrs(o: Record<string, string>): string {
  return `wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2(\n${Object.entries(o)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `  ${sqlString(k)}, ${sqlString(v)}`)
    .join(",\n")})).to_clob`;
}

type Param = [string, string | number | boolean | undefined];

function call(proc: string, params: Param[]): string {
  const ps = params.filter(([, v]) => v !== undefined) as [string, string | number | boolean][];
  return `${proc}(\n${ps.map(([k, v], i) => `${i ? "," : " "}p_${k}=>${v}`).join("\n")}\n);`;
}

const s = sqlString;

/** Atributos de cada tipo de item, iguais aos do export 26.1. */
function itemAttrs(type: string, pk: boolean): Record<string, string> | undefined {
  switch (type) {
    case "NATIVE_TEXT_FIELD":
      return { disabled: "N", submit_when_enter_pressed: "N", subtype: "TEXT", trim_spaces: "BOTH" };
    case "NATIVE_NUMBER_FIELD":
      return { number_alignment: "right", virtual_keyboard: "text" };
    case "NATIVE_TEXTAREA":
      return { auto_height: "N", character_counter: "N", resizable: "Y", trim_spaces: "BOTH" };
    case "NATIVE_DATE_PICKER_APEX":
      return { display_as: "POPUP", max_date: "NONE", min_date: "NONE", multiple_months: "N", show_time: "N", use_defaults: "Y" };
    case "NATIVE_DISPLAY_ONLY":
      return { based_on: "VALUE", format: "PLAIN", send_on_page_submit: "N", show_line_breaks: "Y" };
    case "NATIVE_POPUP_LOV":
      return { case_sensitive: "N", display_as: "DIALOG", initial_fetch: "FIRST_ROWSET", manual_entry: "N", match_type: "CONTAINS", min_chars: "0" };
    case "NATIVE_SELECT_LIST":
      return { page_action_on_selection: "NONE" };
    case "NATIVE_RADIOGROUP":
      return { number_of_columns: "1", page_action_on_selection: "NONE" };
    case "NATIVE_SINGLE_CHECKBOX":
      return { use_defaults: "Y" };
    case "NATIVE_HIDDEN":
      return { value_protected: pk ? "Y" : "N" };
    default:
      return undefined;
  }
}

const humanize = (n: string) => n.replace(/^(DT|DS|NR|CD|ID)_/i, "").replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
const static2 = (vals: { label: string; value: string }[]) => `STATIC2:${vals.map((v) => `${v.label.replace(/[;,]/g, " ")};${v.value}`).join(",")}`;
const staticSql = (vals: { label: string; value: string }[]) =>
  vals.map((v) => `select '${v.label.replace(/'/g, "''")}' d, '${v.value.replace(/'/g, "''")}' r from dual`).join("\nunion all\n");

export interface ApexScript {
  sql: string;
  guide: string;
  pages: { id: number; name: string; kind: string }[];
  manualSteps: string[];
}

export function generateApexScript(ir: IR, bp: Blueprint, results: TriggerResult[], mapBind: BindMapper, base?: ApexBase): ApexScript {
  const form = ir.form.name.toUpperCase();
  const idOf = (key: string) => {
    const h = createHash("sha1").update(`${form}|${key}`).digest("hex");
    return (BigInt("0x" + h.slice(0, 15)) % 9_000_000_000_000_000n + 1_000_000_000_000_000n).toString();
  };
  const ref = (key: string) => `wwv_flow_imp.id(${idOf(key)})`;
  const tpl = (t?: string) => (base && t ? `wwv_flow_imp.id(${t})` : undefined);
  const T = base?.templates ?? {};

  const manual: string[] = [];
  const pagesOut: ApexScript["pages"] = [];
  const blocks: string[] = [];

  // Conversões indexadas por dono (BLOCO ou BLOCO.ITEM).
  const conv = results.filter((r) => r.conversion).map((r) => ({ owner: r.trigger.owner.toUpperCase(), name: r.trigger.name, c: r.conversion as Conversion, pending: r.pendingIds.length > 0 }));
  const requiredItems = new Set(conv.filter((x) => x.c.apexComponent === "required").map((x) => x.owner));
  const defaults = new Map<string, Assignment>();
  for (const x of conv.filter((y) => y.c.apexComponent === "item_default")) for (const a of x.c.assignments ?? []) defaults.set(a.target, a);
  const pendingButtons = new Set(results.filter((r) => r.trigger.name === "WHEN-BUTTON-PRESSED" && !r.conversion).map((r) => r.trigger.owner.toUpperCase()));

  const lovQuery = (name?: string) => bp.lovs.find((l) => l.name.toUpperCase() === (name ?? "").toUpperCase())?.query || undefined;
  const pkOf = (r: PlannedRegion) => r.items.find((i) => i.primaryKey);
  const blockOf = (formsItem: string) => formsItem.split(".")[0];
  const lookupQuery = (l: Lookup) => `${`select ${l.column} from ${l.table} where ${l.keyColumn}`.toLowerCase()} = :${mapBind(blockOf(l.sourceItem), l.sourceItem.split(".")[1])}`;

  const emitPage = (id: number, name: string, kind: string, body: string[], jsDelete = false) => {
    const chunks: string[] = [];
    for (let i = 0; i < body.length; i += 25) chunks.push(body.slice(i, i + 25).join("\n"));
    const head = call("wwv_flow_imp_page.create_page", [
      ["id", id],
      ["name", s(name)],
      ["step_title", s(name)],
      ["autocomplete_on_off", s("OFF")],
      ["javascript_code", jsDelete ? s(`var htmldb_delete_message='"DELETE_CONFIRM_MSG"';`) : undefined],
      ["step_template", tpl(T.page)],
      ["page_template_options", s("#DEFAULT#")],
      ["protection_level", s("C")],
    ]);
    const pad = String(id).padStart(5, "0");
    blocks.push(`prompt --application/pages/page_${pad}\nbegin\n${[head + "\n" + (chunks[0] ?? ""), ...chunks.slice(1)].join("\nend;\n/\nbegin\n")}\nend;\n/`);
    pagesOut.push({ id, name, kind });
  };

  // ---------- itens de página (Form e região estática) ----------
  const pageItem = (page: PlannedPage, reg: PlannedRegion, it: PlannedItem, seq: number, plugKey: string, dml: boolean): string | undefined => {
    if (it.apexType === "BUTTON") return undefined;
    if (it.apexType === "NATIVE_IMAGE_UPLOAD") {
      manual.push(`Página ${page.id}: item de imagem ${it.formsItem} não foi gerado. Use File Upload (BLOB) ou Display Image.`);
      return undefined;
    }
    const lookup = reg.lookups.find((l) => l.target === it.formsItem);
    const isDb = dml && Boolean(it.column) && !lookup;
    let type = lookup ? "NATIVE_DISPLAY_ONLY" : it.apexType;
    let lov: string | undefined;
    if (type === "NATIVE_POPUP_LOV") {
      lov = lovQuery(it.lov);
      if (!lov) {
        manual.push(`Página ${page.id}: LOV ${it.lov} de ${it.formsItem} sem record group no XML; item gerado como campo de texto.`);
        type = it.dataType === "NUMBER" ? "NATIVE_NUMBER_FIELD" : "NATIVE_TEXT_FIELD";
      }
    } else if (it.staticValues?.length && ["NATIVE_SELECT_LIST", "NATIVE_RADIOGROUP"].includes(type)) lov = static2(it.staticValues);
    else if (type === "NATIVE_SELECT_LIST") {
      manual.push(`Página ${page.id}: lista ${it.formsItem} sem elementos no XML; defina a LOV do item.`);
      type = "NATIVE_TEXT_FIELD";
    }
    const def = defaults.get(it.formsItem);
    const defExpr = def ? translateExpr(def.expr, mapBind) : it.defaultExpr ? translateExpr(it.defaultExpr, mapBind) : undefined;
    const required = !it.primaryKey && (it.required || requiredItems.has(it.formsItem));
    const label = it.label ?? humanize(it.formsItem.split(".")[1]);
    return call("wwv_flow_imp_page.create_page_item", [
      ["id", ref(`${page.id}:item:${it.formsItem}`)],
      ["name", s(it.apexName)],
      ["source_data_type", isDb ? s(it.dataType) : undefined],
      ["is_required", required ? "true" : undefined],
      ["is_primary_key", it.primaryKey && isDb ? "true" : undefined],
      ["item_sequence", seq],
      ["item_plug_id", ref(plugKey)],
      ["item_source_plug_id", isDb ? ref(plugKey) : undefined],
      ["use_cache_before_default", it.primaryKey || lookup ? s("NO") : undefined],
      ["item_default", defExpr ? sqlText(defExpr) : undefined],
      ["item_default_type", defExpr ? s("EXPRESSION") : undefined],
      ["item_default_language", defExpr ? s("PLSQL") : undefined],
      ["prompt", type === "NATIVE_HIDDEN" ? undefined : s(label)],
      ["source", isDb ? s(it.column!) : lookup ? sqlText(lookupQuery(lookup)) : undefined],
      ["source_type", lookup ? s("QUERY") : undefined],
      ["display_as", s(type)],
      ["lov", lov ? sqlText(lov) : undefined],
      ["lov_display_null", lov && type !== "NATIVE_POPUP_LOV" && type !== "NATIVE_RADIOGROUP" ? s("YES") : undefined],
      ["cSize", ["NATIVE_TEXT_FIELD", "NATIVE_NUMBER_FIELD", "NATIVE_POPUP_LOV", "NATIVE_TEXTAREA"].includes(type) ? Math.min(Math.max(it.maxLength ?? 30, 10), 60) : undefined],
      ["cMaxlength", it.maxLength && type !== "NATIVE_HIDDEN" ? it.maxLength : undefined],
      ["cHeight", type === "NATIVE_TEXTAREA" ? 4 : type === "NATIVE_HIDDEN" ? undefined : 1],
      ["label_alignment", type === "NATIVE_HIDDEN" ? undefined : s("RIGHT")],
      ["field_template", type === "NATIVE_HIDDEN" ? undefined : tpl(required ? T.requiredLabel : T.label)],
      ["item_template_options", type === "NATIVE_HIDDEN" ? undefined : s("#DEFAULT#")],
      ["is_persistent", s("N")],
      ["lov_display_extra", lov ? s("YES") : undefined],
      ["protection_level", it.primaryKey ? s("S") : undefined],
      ["encrypt_session_state_yn", s("N")],
      ["attributes", (() => {
        const a = itemAttrs(type, it.primaryKey);
        return a ? sqlAttrs(a) : undefined;
      })()],
    ]);
  };

  const pageButton = (key: string, plugKey: string, seq: number, name: string, label: string, opts: Param[]) =>
    call("wwv_flow_imp_page.create_page_button", [
      ["id", ref(key)],
      ["button_sequence", seq],
      ["button_plug_id", ref(plugKey)],
      ["button_name", s(name)],
      ["static_id", s(name.toLowerCase())],
      ...opts.filter(([k]) => k === "button_action"),
      ["button_template_options", s("#DEFAULT#")],
      ["button_template_id", tpl(T.button)],
      ...opts.filter(([k]) => k === "button_is_hot"),
      ["button_image_alt", s(label)],
      ...opts.filter(([k]) => k !== "button_action" && k !== "button_is_hot"),
    ]);

  const plsqlProcess = (key: string, seq: number, name: string, code: string, extra: Param[]) =>
    call("wwv_flow_imp_page.create_page_process", [
      ["id", ref(key)],
      ["process_sequence", seq],
      ["process_point", s("AFTER_SUBMIT")],
      ...extra.filter(([k]) => k === "region_id"),
      ["process_type", s("NATIVE_PLSQL")],
      ["process_name", s(name)],
      ["static_id", s(name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""))],
      ["process_sql_clob", sqlText(code)],
      ["process_clob_language", s("PLSQL")],
      ["error_display_location", s("INLINE_IN_NOTIFICATION")],
      ...extra.filter(([k]) => k !== "region_id"),
    ]);

  const dmlAttrs = sqlAttrs({ lock_row: "Y", prevent_lost_updates: "Y", return_primary_keys_after_insert: "Y", target_type: "REGION_SOURCE" });
  const editOps = (r: PlannedRegion) => [r.insertAllowed && "i", r.updateAllowed && "u", r.deleteAllowed && "d"].filter(Boolean).join(":");

  // ---------- página de consulta (Interactive Report) do bloco mestre ----------
  const listPage = (page: PlannedPage, master: PlannedRegion) => {
    const listId = page.listPageId!;
    const pk = pkOf(master);
    const plugKey = `${listId}:ir`;
    const cols = master.items.filter((i) => i.column).map((i) => ({ name: i.column!, label: i.label ?? humanize(i.column!), dt: i.dataType, hidden: i.primaryKey }));
    for (const l of master.lookups) cols.push({ name: l.target.split(".")[1], label: humanize(l.target.split(".")[1]), dt: "VARCHAR2", hidden: false });
    let select = [...master.items.filter((i) => i.column).map((i) => `t.${i.column!.toLowerCase()}`), ...master.extraColumns];
    let pkCol = pk?.column;
    if (!pkCol) {
      select = ["rowidtochar(t.rowid) as row_id", ...select];
      cols.unshift({ name: "ROW_ID", label: "Row id", dt: "VARCHAR2", hidden: true });
      pkCol = "ROW_ID";
    }
    const where = master.where ? `\n where ${translateExpr(master.where, mapBind)}` : "";
    const order = master.orderBy ? `\n order by ${master.orderBy}` : "";
    const query = `select ${select.join(",\n       ")}\n  from ${master.source!.toLowerCase()} t${where}${order}`;
    const pkItem = pk ? pk.apexName : `P${page.id}_ROWID`;
    const letter = (n: number) => (n < 26 ? String.fromCharCode(65 + n) : String.fromCharCode(64 + Math.floor(n / 26)) + String.fromCharCode(65 + (n % 26)));
    const body: string[] = [
      call("wwv_flow_imp_page.create_page_plug", [
        ["id", ref(plugKey)],
        ["plug_name", s(bp.application.name)],
        ["region_template_options", s("#DEFAULT#")],
        ["escape_on_http_output", s("Y")],
        ["plug_template", tpl(T.irr)],
        ["plug_display_sequence", 10],
        ["query_type", s("SQL")],
        ["plug_source", sqlText(query)],
        ["plug_source_type", s("NATIVE_IR")],
        ["plug_query_headings_type", s("COLON_DELMITED_LIST")],
        ["plug_query_show_nulls_as", s(" - ")],
        ["pagination_display_position", s("BOTTOM_RIGHT")],
      ]),
      call("wwv_flow_imp_page.create_worksheet", [
        ["id", ref(`${plugKey}:ws`)],
        ["max_row_count", s("1000000")],
        ["no_data_found_message", s("Nenhum registro encontrado.")],
        ["pagination_type", s("ROWS_X_TO_Y")],
        ["pagination_display_pos", s("BOTTOM_RIGHT")],
        ["show_search_bar", s("Y")],
        ["report_list_mode", s("TABS")],
        ["lazy_loading", "false"],
        ["show_detail_link", s("C")],
        ["download_formats", s("CSV:HTML")],
        ["enable_mail_download", s("Y")],
        ["detail_link", s(`f?p=&APP_ID.:${page.id}:&SESSION.::&DEBUG.::${pkItem}:#${pkCol.toUpperCase()}#`)],
        ["detail_link_text", s(`<span role="img" aria-label="Editar" class="fa fa-edit" title="Editar"></span>`)],
        ["allow_exclude_null_values", s("N")],
        ["allow_hide_extra_columns", s("N")],
        ["icon_view_columns_per_row", 1],
      ]),
      ...cols.map((c, i) =>
        call("wwv_flow_imp_page.create_worksheet_column", [
          ["id", ref(`${plugKey}:col:${c.name}`)],
          ["db_column_name", s(c.name.toUpperCase())],
          ["display_order", i + 1],
          ["column_identifier", s(letter(i))],
          ["column_label", s(c.label)],
          ["allow_pivot", s("N")],
          ["column_type", s(c.dt === "NUMBER" ? "NUMBER" : c.dt === "DATE" ? "DATE" : "STRING")],
          ["display_text_as", c.hidden ? s("HIDDEN") : undefined],
          ["column_alignment", c.dt === "NUMBER" ? s("RIGHT") : undefined],
          ["tz_dependent", s("N")],
          ["static_id", s(c.name.toUpperCase())],
          ["use_as_row_header", s("N")],
        ]),
      ),
      call("wwv_flow_imp_page.create_worksheet_rpt", [
        ["id", ref(`${plugKey}:rpt`)],
        ["application_user", s("APXWS_DEFAULT")],
        ["report_seq", 10],
        ["report_alias", s(idOf(`${plugKey}:alias`).slice(0, 8))],
        ["status", s("PUBLIC")],
        ["is_default", s("Y")],
        ["display_rows", 50],
        ["report_columns", s(cols.map((c) => c.name.toUpperCase()).join(":") + ":")],
      ]),
    ];
    if (master.insertAllowed)
      body.push(
        pageButton(`${listId}:btn:CREATE`, plugKey, 10, "CREATE", "Criar", [
          ["button_action", s("REDIRECT_PAGE")],
          ["button_is_hot", s("Y")],
          ["button_position", s("RIGHT_OF_IR_SEARCH_BAR")],
          ["button_redirect_url", s(`f?p=&APP_ID.:${page.id}:&SESSION.::&DEBUG.:${page.id}::`)],
        ]),
      );
    emitPage(listId, bp.application.name, "Consulta (Interactive Report)", body);
  };

  // ---------- página principal ----------
  const mainPage = (page: PlannedPage) => {
    const body: string[] = [];
    const items: string[] = [];
    const after: string[] = []; // validações, processos, branches
    let plugSeq = 0;
    let hasDelete = false;
    const master = page.regions.find((r) => r.apexType === "form" && !r.masterBlock);

    for (const reg of page.regions) {
      plugSeq += 10;
      const plugKey = `${page.id}:plug:${reg.formsBlock}`;
      const regionName = reg === master ? bp.application.name : humanize(reg.formsBlock);
      const regionConvs = conv.filter((x) => blockOf(x.owner) === reg.formsBlock.toUpperCase());

      if (reg.apexType === "form" || reg.apexType === "static") {
        const isForm = reg.apexType === "form";
        const pk = pkOf(reg);
        body.push(
          call("wwv_flow_imp_page.create_page_plug", [
            ["id", ref(plugKey)],
            ["plug_name", s(regionName)],
            ["region_template_options", s("#DEFAULT#")],
            ["escape_on_http_output", s("Y")],
            ["plug_template", tpl(isForm ? (T.form ?? T.region) : T.region)],
            ["plug_display_sequence", plugSeq],
            ["plug_item_display_point", s("ABOVE")],
            ["query_type", isForm ? s("TABLE") : undefined],
            ["query_table", isForm ? s(reg.source!.toUpperCase()) : undefined],
            ["include_rowid_column", isForm ? String(!pk) : undefined],
            ["is_editable", isForm ? "true" : undefined],
            ["edit_operations", isForm ? s(editOps(reg) || "u") : undefined],
            ["lost_update_check_type", isForm ? s("VALUES") : undefined],
            ["plug_source_type", isForm ? s("NATIVE_FORM") : undefined],
            ["plug_query_headings_type", s("COLON_DELMITED_LIST")],
            ["attributes", isForm ? undefined : sqlAttrs({ expand_shortcuts: "N", output_as: "HTML" })],
          ]),
        );
        let seq = 0;
        if (isForm && !pk) {
          seq += 10;
          items.push(
            call("wwv_flow_imp_page.create_page_item", [
              ["id", ref(`${page.id}:item:${reg.formsBlock}.ROWID`)],
              ["name", s(`P${page.id}_ROWID`)],
              ["source_data_type", s("ROWID")],
              ["is_primary_key", "true"],
              ["item_sequence", seq],
              ["item_plug_id", ref(plugKey)],
              ["item_source_plug_id", ref(plugKey)],
              ["use_cache_before_default", s("NO")],
              ["source", s("ROWID")],
              ["display_as", s("NATIVE_HIDDEN")],
              ["is_persistent", s("N")],
              ["protection_level", s("S")],
              ["encrypt_session_state_yn", s("N")],
              ["attributes", sqlAttrs({ value_protected: "Y" })],
            ]),
          );
        }
        for (const it of reg.items) {
          seq += 10;
          const code = pageItem(page, reg, it, seq, plugKey, isForm);
          if (code) items.push(code);
        }
        if (isForm && reg !== master) manual.push(`Página ${page.id}: região ${reg.formsBlock} é um formulário de registro único ligado a ${reg.masterBlock}; os itens foram gerados, configure "Initialize form" e "Process form" com a chave do mestre.`);

        // Botões
        const pkName = pk?.apexName ?? `P${page.id}_ROWID`;
        if (reg === master) {
          if (page.listPageId)
            body.push(pageButton(`${page.id}:btn:CANCEL`, plugKey, 10, "CANCEL", "Cancelar", [["button_action", s("REDIRECT_PAGE")], ["button_position", s("CLOSE")], ["button_redirect_url", s(`f?p=&APP_ID.:${page.listPageId}:&SESSION.::&DEBUG.:::`)]]));
          if (reg.deleteAllowed) {
            hasDelete = true;
            body.push(
              pageButton(`${page.id}:btn:DELETE`, plugKey, 20, "DELETE", "Excluir", [
                ["button_action", s("REDIRECT_URL")],
                ["button_position", s("DELETE")],
                ["button_redirect_url", s("javascript:apex.confirm(htmldb_delete_message,'DELETE');")],
                ["button_execute_validations", s("N")],
                ["button_condition", s(pkName)],
                ["button_condition_type", s("ITEM_IS_NOT_NULL")],
                ["database_action", s("DELETE")],
              ]),
            );
          }
          if (reg.updateAllowed)
            body.push(pageButton(`${page.id}:btn:SAVE`, plugKey, 30, "SAVE", "Salvar", [["button_action", s("SUBMIT")], ["button_is_hot", s("Y")], ["button_position", s("CHANGE")], ["button_condition", s(pkName)], ["button_condition_type", s("ITEM_IS_NOT_NULL")], ["database_action", s("UPDATE")]]));
          if (reg.insertAllowed)
            body.push(pageButton(`${page.id}:btn:CREATE`, plugKey, 40, "CREATE", "Criar", [["button_action", s("SUBMIT")], ["button_is_hot", s("Y")], ["button_position", s("CREATE")], ["button_condition", s(pkName)], ["button_condition_type", s("ITEM_IS_NULL")], ["database_action", s("INSERT")]]));
        }
        let bseq = 50;
        for (const it of reg.items.filter((i) => i.apexType === "BUTTON")) {
          const name = it.formsItem.split(".")[1];
          body.push(pageButton(`${page.id}:btn:${it.formsItem}`, plugKey, bseq, name, it.label ?? humanize(name), [["button_action", s("SUBMIT")], ["button_position", s("CHANGE")]]));
          bseq += 10;
          if (pendingButtons.has(it.formsItem)) manual.push(`Página ${page.id}: botão ${name} criado sem ação; o WHEN-BUTTON-PRESSED está em PENDENCIAS.md.`);
        }

        // Validações (itens desta região)
        let vseq = 10;
        for (const x of regionConvs.filter((y) => y.c.apexComponent === "validation" && y.c.code)) {
          const item = reg.items.find((i) => i.formsItem === x.owner);
          after.push(
            call("wwv_flow_imp_page.create_page_validation", [
              ["id", ref(`${page.id}:val:${x.owner}:${x.name}`)],
              ["validation_name", s(`${x.owner} ${x.name}`.toLowerCase())],
              ["static_id", s(`${x.owner}-${x.name}`.toLowerCase().replace(/[^a-z0-9]+/g, "-"))],
              ["validation_sequence", vseq],
              ["validation", sqlText(x.c.code!)],
              ["validation2", s("PLSQL")],
              ["validation_type", s("FUNC_BODY_RETURNING_BOOLEAN")],
              ["error_message", s(x.c.message ?? "Valor inválido")],
              ["when_button_pressed", undefined],
              ["associated_item", item ? ref(`${page.id}:item:${item.formsItem}`) : undefined],
              ["error_display_location", s(item ? "INLINE_WITH_FIELD_AND_NOTIFICATION" : "INLINE_IN_NOTIFICATION")],
            ]),
          );
          vseq += 10;
        }

        if (reg === master) {
          after.push(
            call("wwv_flow_imp_page.create_page_process", [
              ["id", ref(`${page.id}:proc:init`)],
              ["process_sequence", 10],
              ["process_point", s("BEFORE_HEADER")],
              ["region_id", ref(plugKey)],
              ["process_type", s("NATIVE_FORM_INIT")],
              ["process_name", s(`Initialize form ${regionName}`)],
              ["static_id", s("initialize-form")],
            ]),
          );
          // PRE-INSERT / PRE-UPDATE convertidos rodam antes do DML, disparados pelo botão correspondente.
          let pseq = 11;
          for (const x of regionConvs.filter((y) => y.owner === reg.formsBlock.toUpperCase() && y.c.assignments?.length && (y.name === "PRE-INSERT" || y.name === "PRE-UPDATE"))) {
            const insert = x.name === "PRE-INSERT";
            if (insert ? !reg.insertAllowed : !reg.updateAllowed) continue;
            const code = x.c.assignments!.map((a) => `:${mapBind(blockOf(a.target), a.target.split(".")[1])} := ${a.sequence ? a.expr : translateExpr(a.expr, mapBind)};`).join("\n");
            after.push(plsqlProcess(`${page.id}:proc:${x.name}`, pseq++, `${x.name} ${reg.formsBlock}`, code, [["process_when_button_id", ref(`${page.id}:btn:${insert ? "CREATE" : "SAVE"}`)]]));
          }
          after.push(
            call("wwv_flow_imp_page.create_page_process", [
              ["id", ref(`${page.id}:proc:dml`)],
              ["process_sequence", 20],
              ["process_point", s("AFTER_SUBMIT")],
              ["region_id", ref(plugKey)],
              ["process_type", s("NATIVE_FORM_DML")],
              ["process_name", s(`Process form ${regionName}`)],
              ["static_id", s("process-form")],
              ["attributes", dmlAttrs],
              ["error_display_location", s("INLINE_IN_NOTIFICATION")],
            ]),
          );
        }
        continue;
      }

      // ---------- Interactive Grid (bloco multirregistro) ----------
      if (reg.apexType === "interactive_report_modal")
        manual.push(`Página ${page.id}: ${reg.formsBlock} foi gerado como Interactive Grid somente leitura; a pré-orientação pediu IR + form modal, crie o form modal e o link de edição.`);
      const editable = reg.apexType === "interactive_grid" && Boolean(editOps(reg));
      const pk = pkOf(reg);
      const binds = [...new Set((reg.query ?? "").match(/:P\d+_\w+/g) ?? [])].map((b) => b.slice(1));
      const linkItem = reg.link ? mapBind(blockOf(reg.link.masterItem), reg.link.masterItem.split(".")[1]) : undefined;
      body.push(
        call("wwv_flow_imp_page.create_page_plug", [
          ["id", ref(plugKey)],
          ["plug_name", s(regionName)],
          ["region_template_options", s("#DEFAULT#")],
          ["escape_on_http_output", s("Y")],
          ["plug_template", tpl(T.irr ?? T.region)],
          ["plug_display_sequence", plugSeq],
          ["query_type", s("SQL")],
          ["plug_source", sqlText(reg.query ?? `select * from ${reg.source}`)],
          ["plug_source_type", s("NATIVE_IG")],
          ["ajax_items_to_submit", binds.length ? s(binds.join(",")) : undefined],
          ["plug_query_headings_type", s("COLON_DELMITED_LIST")],
          ["plug_display_condition_type", linkItem ? s("ITEM_IS_NOT_NULL") : undefined],
          ["plug_display_when_condition", linkItem ? s(linkItem) : undefined],
        ]),
      );
      const colIds: string[] = [];
      const col = (name: string, params: Param[], inReport = true) => {
        const key = `${plugKey}:col:${name}`;
        if (inReport) colIds.push(key);
        body.push(call("wwv_flow_imp_page.create_region_column", [["id", ref(key)], ["name", s(name)], ...params]));
      };
      if (editable) {
        col("APEX$ROW_SELECTOR", [["session_state_data_type", s("VARCHAR2")], ["item_type", s("NATIVE_ROW_SELECTOR")], ["display_sequence", 10], ["attributes", sqlAttrs({ enable_multi_select: "Y", hide_control: "N", show_select_all: "Y" })], ["use_as_row_header", "false"], ["include_in_export", "true"]], false);
        col("APEX$ROW_ACTION", [["session_state_data_type", s("VARCHAR2")], ["item_type", s("NATIVE_ROW_ACTION")], ["display_sequence", 20], ["use_as_row_header", "false"], ["include_in_export", "true"]]);
      }
      if (!pk)
        col("ROWID", [["source_type", s("DB_COLUMN")], ["source_expression", s("ROWID")], ["data_type", s("ROWID")], ["session_state_data_type", s("VARCHAR2")], ["is_query_only", "false"], ["item_type", s("NATIVE_HIDDEN")], ["display_sequence", 30], ["attributes", sqlAttrs({ value_protected: "Y" })], ["use_as_row_header", "false"], ["is_primary_key", "true"], ["include_in_export", "false"]]);
      const seqPk = conv.find((x) => x.owner === reg.formsBlock.toUpperCase() && x.name === "PRE-INSERT")?.c.assignments?.find((a) => a.sequence && pk && a.target === pk.formsItem);
      let dseq = 40;
      const seen = new Set<string>();
      for (const it of reg.items) {
        if (it.apexType === "BUTTON" || it.apexType === "NATIVE_IMAGE_UPLOAD") {
          manual.push(`Página ${page.id}: ${it.formsItem} (${it.apexType === "BUTTON" ? "botão" : "imagem"} em bloco multirregistro) não foi gerado no Interactive Grid.`);
          continue;
        }
        const lookup = reg.lookups.find((l) => l.target === it.formsItem);
        if (!it.column && !lookup) {
          manual.push(`Página ${page.id}: item não-base ${it.formsItem} não entra no Interactive Grid; recrie como coluna calculada se precisar.`);
          continue;
        }
        const name = it.apexName;
        seen.add(name);
        const isLink = reg.link && it.column === reg.link.column;
        let type = lookup ? "NATIVE_DISPLAY_ONLY" : isLink ? "NATIVE_HIDDEN" : it.apexType;
        let lovSql: string | undefined;
        if (type === "NATIVE_POPUP_LOV") {
          lovSql = lovQuery(it.lov);
          if (!lovSql) type = it.dataType === "NUMBER" ? "NATIVE_NUMBER_FIELD" : "NATIVE_TEXT_FIELD";
        } else if (it.staticValues?.length && ["NATIVE_SELECT_LIST", "NATIVE_RADIOGROUP"].includes(type)) {
          type = "NATIVE_SELECT_LIST";
          lovSql = staticSql(it.staticValues);
        } else if (type === "NATIVE_SELECT_LIST" || type === "NATIVE_RADIOGROUP") type = "NATIVE_TEXT_FIELD";
        const def = defaults.get(it.formsItem);
        const defExpr = def ? def.expr : it.defaultExpr;
        let defaultParams: Param[] = [];
        if (it.primaryKey && seqPk) defaultParams = [["default_type", s("SQL_QUERY")], ["default_expression", s(`select ${seqPk.sequence!.toLowerCase()}.nextval from dual`)]];
        else if (isLink && linkItem) defaultParams = [["default_type", s("ITEM")], ["default_expression", s(linkItem)]];
        else if (defExpr && !/:\w/.test(defExpr)) defaultParams = [["default_type", s("SQL_QUERY")], ["default_expression", sqlText(`select ${translateExpr(defExpr, mapBind)} from dual`)]];
        const required = !it.primaryKey && (it.required || requiredItems.has(it.formsItem));
        const right = it.dataType === "NUMBER";
        const visible = type !== "NATIVE_HIDDEN";
        const attrs = itemAttrs(type, it.primaryKey);
        col(name, [
          ["source_type", s("DB_COLUMN")],
          ["source_expression", s(name)],
          ["data_type", s(lookup ? "VARCHAR2" : it.dataType)],
          ["session_state_data_type", s("VARCHAR2")],
          ["is_query_only", String(Boolean(lookup))],
          ["item_type", s(type)],
          ["heading", visible ? s(it.label ?? humanize(name)) : undefined],
          ["heading_alignment", visible ? s(right ? "RIGHT" : "LEFT") : undefined],
          ["display_sequence", dseq],
          ["value_alignment", visible ? s(right ? "RIGHT" : "LEFT") : undefined],
          ["attributes", attrs ? sqlAttrs(attrs) : undefined],
          ["is_required", visible ? String(required) : undefined],
          ["max_length", it.dataType === "VARCHAR2" && it.maxLength && visible ? it.maxLength : undefined],
          ["lov_type", lovSql ? s("SQL_QUERY") : undefined],
          ["lov_source", lovSql ? sqlText(lovSql) : undefined],
          ["lov_display_extra", lovSql ? "true" : undefined],
          ["lov_display_null", lovSql ? "true" : undefined],
          ["enable_filter", visible ? "true" : undefined],
          ["filter_operators", visible && it.dataType === "VARCHAR2" ? s("C:S:CASE_INSENSITIVE:REGEXP") : undefined],
          ["filter_is_required", "false"],
          ["filter_text_case", visible && it.dataType === "VARCHAR2" ? s("MIXED") : undefined],
          ["filter_lov_type", visible ? s(lovSql ? "LOV" : "NONE") : undefined],
          ["use_as_row_header", "false"],
          ["enable_sort_group", visible ? "true" : undefined],
          ["enable_control_break", visible ? "true" : undefined],
          ["enable_hide", visible ? "true" : undefined],
          ["is_primary_key", String(it.primaryKey)],
          ...defaultParams,
          ["duplicate_value", String(!it.primaryKey)],
          ["include_in_export", String(visible)],
        ]);
        dseq += 10;
      }
      if (reg.link && linkItem && !seen.has(reg.link.column)) {
        col(reg.link.column, [["source_type", s("DB_COLUMN")], ["source_expression", s(reg.link.column)], ["data_type", s("NUMBER")], ["session_state_data_type", s("VARCHAR2")], ["is_query_only", "false"], ["item_type", s("NATIVE_HIDDEN")], ["display_sequence", dseq], ["attributes", sqlAttrs({ value_protected: "Y" })], ["filter_is_required", "false"], ["use_as_row_header", "false"], ["is_primary_key", "false"], ["default_type", s("ITEM")], ["default_expression", s(linkItem)], ["duplicate_value", "true"], ["include_in_export", "false"]]);
        manual.push(`Página ${page.id}: coluna de ligação ${reg.link.column} de ${reg.formsBlock} foi criada como NUMBER; confira o tipo.`);
      }
      const gridKey = `${plugKey}:grid`;
      body.push(
        call("wwv_flow_imp_page.create_interactive_grid", [
          ["id", ref(gridKey)],
          ["is_editable", String(editable)],
          ["edit_operations", editable ? s(editOps(reg)) : undefined],
          ["lost_update_check_type", editable ? s("VALUES") : undefined],
          ["add_row_if_empty", editable ? "true" : undefined],
          ["submit_checked_rows", "false"],
          ["lazy_loading", "false"],
          ["requires_filter", "false"],
          ["show_nulls_as", s("-")],
          ["select_first_row", "true"],
          ["fixed_row_height", "true"],
          ["pagination_type", s("SCROLL")],
          ["show_total_row_count", "true"],
          ["show_toolbar", "true"],
          ["enable_save_public_report", "false"],
          ["enable_subscriptions", "true"],
          ["enable_flashback", "true"],
          ["define_chart_view", "true"],
          ["enable_download", "true"],
          ["enable_mail_download", "true"],
          ["fixed_header", s("PAGE")],
          ["show_icon_view", "false"],
          ["show_detail_view", "false"],
        ]),
        call("wwv_flow_imp_page.create_ig_report", [["id", ref(`${gridKey}:rpt`)], ["interactive_grid_id", ref(gridKey)], ["static_id", s(idOf(`${gridKey}:alias`).slice(0, 7))], ["type", s("PRIMARY")], ["default_view", s("GRID")], ["show_row_number", "false"], ["settings_area_expanded", "true"]]),
        call("wwv_flow_imp_page.create_ig_report_view", [["id", ref(`${gridKey}:view`)], ["report_id", ref(`${gridKey}:rpt`)], ["view_type", s("GRID")], ["stretch_columns", "true"], ["srv_exclude_null_values", "false"], ["srv_only_display_columns", "true"], ["edit_mode", "false"]]),
        ...colIds.map((key, i) =>
          call("wwv_flow_imp_page.create_ig_report_column", [["id", ref(`${key}:rptcol`)], ["view_id", ref(`${gridKey}:view`)], ["display_seq", key.endsWith(":APEX$ROW_ACTION") ? 0 : i], ["column_id", ref(key)], ["is_visible", "true"], ["is_frozen", "false"]]),
        ),
      );
      if (editable) {
        // PRE-INSERT/PRE-UPDATE do bloco: processo por linha antes do DML do IG (a PK por sequence já está no default da coluna).
        let pseq = 25;
        for (const x of regionConvs.filter((y) => y.owner === reg.formsBlock.toUpperCase() && y.c.assignments?.length && (y.name === "PRE-INSERT" || y.name === "PRE-UPDATE"))) {
          const asg = x.c.assignments!.filter((a) => !(a.sequence && pk && a.target === pk.formsItem));
          if (!asg.length) continue;
          const status = x.name === "PRE-INSERT" ? "C" : "U";
          const code = `if :APEX$ROW_STATUS = '${status}' then\n${asg.map((a) => `  :${mapBind(blockOf(a.target), a.target.split(".")[1])} := ${a.sequence ? a.expr : translateExpr(a.expr, mapBind)};`).join("\n")}\nend if;`;
          after.push(plsqlProcess(`${page.id}:proc:${reg.formsBlock}:${x.name}`, pseq++, `${x.name} ${reg.formsBlock}`, code, [["region_id", ref(plugKey)]]));
        }
        after.push(
          call("wwv_flow_imp_page.create_page_process", [
            ["id", ref(`${page.id}:proc:${reg.formsBlock}:igdml`)],
            ["process_sequence", 30],
            ["process_point", s("AFTER_SUBMIT")],
            ["region_id", ref(plugKey)],
            ["process_type", s("NATIVE_IG_DML")],
            ["process_name", s(`Salvar ${regionName}`)],
            ["static_id", s(`salvar-${reg.formsBlock.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`)],
            ["attributes", dmlAttrs],
            ["error_display_location", s("INLINE_IN_NOTIFICATION")],
          ]),
        );
        if (!master)
          body.push(pageButton(`${page.id}:btn:SAVE:${reg.formsBlock}`, plugKey, 10, "SAVE", "Salvar", [["button_action", s("SUBMIT")], ["button_is_hot", s("Y")], ["button_position", s("CHANGE")]]));
      }
      for (const x of regionConvs.filter((y) => y.c.apexComponent === "validation"))
        manual.push(`Página ${page.id}: validação de ${x.owner} (${x.name}) é de coluna do Interactive Grid; crie em Validations com "Editable Region" = ${regionName}: ${x.c.code}`);
    }

    // Itens de outras conversões que o gerador não posiciona sozinho.
    for (const x of conv.filter((y) => page.regions.some((r) => r.formsBlock.toUpperCase() === blockOf(y.owner)))) {
      if (x.c.apexComponent === "dynamic_action") manual.push(`Página ${page.id}: ${x.owner} ${x.name} pede Dynamic Action: ${x.c.description}`);
      else if (x.c.apexComponent === "computation" || (x.c.source === "ia" && x.c.apexComponent !== "validation" && x.c.apexComponent !== "nativo"))
        manual.push(`Página ${page.id}: conversão por IA de ${x.owner} ${x.name} (${x.c.apexComponent}) não foi posicionada automaticamente; aplique a partir de conversoes.json.`);
    }

    if (master) {
      const target = page.listPageId ?? page.id;
      after.push(
        call("wwv_flow_imp_page.create_page_branch", [
          ["id", ref(`${page.id}:branch`)],
          ["branch_action", s(`f?p=&APP_ID.:${target}:&SESSION.::&DEBUG.&success_msg=#SUCCESS_MSG#`)],
          ["branch_point", s("AFTER_PROCESSING")],
          ["branch_type", s("REDIRECT_URL")],
          ["branch_sequence", 1],
        ]),
      );
    } else if (page.regions.some((r) => r.apexType === "interactive_grid")) {
      // nada: o IG salva via AJAX ou pelo botão Salvar
    }
    emitPage(page.id, page.name === bp.pages[0]?.name ? bp.application.name : humanize(page.name), master ? "Formulário" : "Grade", [...body, ...items, ...after], hasDelete);
  };

  for (const page of bp.pages) {
    const master = page.regions.find((r) => r.apexType === "form" && !r.masterBlock);
    if (page.listPageId && master) listPage(page, master);
    mainPage(page);
  }

  for (const l of bp.lovs.filter((x) => x.query)) manual.push(`LOV ${l.name}: o APEX exige (exibição, retorno) nessa ordem; confira se "${l.query.replace(/\s+/g, " ").slice(0, 80)}" segue isso.`);

  const release = base?.release ?? APEX_TARGET.release;
  const header = `prompt --application/set_environment
set define off verify off feedback off
whenever sqlerror exit sql.sqlcode rollback
--------------------------------------------------------------------------------
--
-- Gerado pelo forms2apex a partir do form ${sqlComment(ir.form.name)}.
-- Tipo: Page Export (importa paginas em uma aplicacao existente).
-- Formato: APEX ${APEX_TARGET.release} (wwv_flow_imp_page). Rode primeiro num ambiente DEV.
-- Paginas: ${pagesOut.map((p) => p.id).join(", ")}
-- ${base ? `Base: aplicacao ${base.applicationId}, schema ${base.owner}, tema ${base.themeId ?? "?"}` : "Sem export base: defina apex_application_install antes (veja COMO_IMPORTAR.md)."}
--
--------------------------------------------------------------------------------
${base ? "" : `begin
  if apex_application_install.get_workspace_id is null or apex_application_install.get_application_id is null then
    raise_application_error(-20001, 'forms2apex: defina apex_application_install.set_workspace, set_application_id e generate_offset antes de rodar este script');
  end if;
end;
/
`}begin
wwv_flow_imp.import_begin (
 p_version_yyyy_mm_dd=>'${base?.versionDate ?? APEX_TARGET.versionDate}'
,p_release=>'${release}'
,p_default_workspace_id=>${base?.workspaceId ?? 0}
,p_default_application_id=>${base?.applicationId ?? 0}
,p_default_id_offset=>${base?.idOffset ?? 0}
,p_default_owner=>'${base?.owner ?? "FORMS2APEX"}'
);
end;
/
`;
  const footer = `prompt --application/end_environment
begin
wwv_flow_imp.import_end(p_auto_install_sup_obj => nvl(wwv_flow_application_install.get_auto_install_sup_obj, false));
commit;
end;
/
set verify on feedback on define on
prompt  ...done
`;
  if (base && !base.release.startsWith("26.")) manual.unshift(`O export base é do APEX ${base.release}; o formato gerado foi validado contra o 26.1. Importe primeiro num ambiente DEV.`);

  const sql = `${header}${blocks.join("\n")}\n${footer}`;
  return { sql, pages: pagesOut, manualSteps: manual, guide: importGuide(ir, pagesOut, manual, base) };
}

function importGuide(ir: IR, pages: ApexScript["pages"], manual: string[], base?: ApexBase): string {
  const how = base
    ? `O script já aponta para a aplicação ${base.applicationId} (schema ${base.owner}) do export base, com os templates do tema ${base.themeId ?? ""}.

\`\`\`sql
-- SQLcl conectado como ${base.owner} (ou usuário com APEX_ADMINISTRATOR_ROLE), no ambiente DEV
@install/01_${ir.form.name.toLowerCase()}_pkg.sql
@install/04_apex_paginas.sql
\`\`\`

Ou no App Builder: Import > arquivo \`04_apex_paginas.sql\`.`
    : `Sem export base o script não sabe workspace nem aplicação. Defina antes:

\`\`\`sql
begin
  apex_application_install.set_workspace('MEU_WORKSPACE');
  apex_application_install.set_application_id(100);
  apex_application_install.generate_offset;
  apex_application_install.set_schema('MEU_SCHEMA');
end;
/
@install/01_${ir.form.name.toLowerCase()}_pkg.sql
@install/04_apex_paginas.sql
\`\`\`

Os templates ficam em branco (padrão do tema). Para herdar os templates da aplicação, gere de novo com \`--apex-base fNNN.sql\` (export da aplicação de destino).`;
  return `# Como importar no APEX: ${ir.form.name}

Formato: Page Export do APEX ${APEX_TARGET.release}. Não substitui páginas existentes: se o ID já existir, o import para e faz rollback.

## Páginas

| ID | Nome | Tipo |
| --- | --- | --- |
${pages.map((p) => `| ${p.id} | ${p.name} | ${p.kind} |`).join("\n")}

## Importar

${how}

## Ajustes manuais depois do import

${manual.length ? manual.map((m) => `- [ ] ${m}`).join("\n") : "- Nenhum."}

Depois, percorra ROTEIRO_TESTES.md e resolva PENDENCIAS.md.
`;
}
