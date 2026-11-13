import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { allocatePages, applyRules, parseLibrary, parseNavigation, qualifyCalls, runApplication } from "../packages/core/src/index.ts";

const APP = "examples/app_vendas";
const out = () => mkdtemp(join(tmpdir(), "f2a-app-"));

/** IDs do script: cada p_id criado uma vez e toda referência wwv_flow_imp.id aponta para algo criado (fora templates do tema). */
function checkIds(sql: string) {
  const defined = new Set([...sql.matchAll(/^[ ,]p_id=>wwv_flow_imp\.id\((\d+)\)/gm)].map((m) => m[1]));
  assert.equal(defined.size, (sql.match(/^[ ,]p_id=>wwv_flow_imp\.id\(/gm) ?? []).length, "id duplicado");
  for (const m of sql.matchAll(/^,p_(\w+)=>wwv_flow_imp\.id\((\d+)\)/gm)) {
    if (/template|^default_/.test(m[1])) continue; // templates do tema vêm da aplicação base
    assert.ok(defined.has(m[2]), `p_${m[1]} aponta para id ${m[2]} que não foi criado`);
  }
}

test("navegação: :GLOBAL simples + CALL_FORM viram redirect; código extra não", () => {
  const n = parseNavigation(":global.cli := :cli.id; :global.modo := 'C'; call_form('PEDIDOS', no_hide);");
  assert.deepEqual(n?.globals.map((g) => g.item), ["GLOBAL_CLI", "GLOBAL_MODO"]);
  assert.equal(n?.form, "PEDIDOS");
  assert.equal(parseNavigation("if x then call_form('A'); end if;"), null);
  const c = applyRules({ name: "WHEN-BUTTON-PRESSED", scope: "item", owner: "CLI.BT", code: "new_form('DEPTO');" }, (b, i) => i);
  assert.equal(c?.ruleId, "navegacao_entre_forms");
});

test("Forms 5: exit_form com argumento e commit_form com aviso são nativos", () => {
  const map = (b: string, i: string) => i;
  assert.equal(applyRules({ name: "KEY-EXIT", scope: "form", owner: "F", code: "exit_form(no_validate);" }, map)?.apexComponent, "nativo");
  const c = applyRules({ name: "KEY-COMMIT", scope: "form", owner: "F", code: "commit_form;\nif form_success then\n  message('Gravado');\nend if;" }, map);
  assert.equal(c?.message, "Gravado");
});

test("chamadas a units de package ficam qualificadas, fora de literais", () => {
  const units = new Map([["CALC_DESCONTO", "VENDAS_LIB_PKG"]]);
  assert.equal(qualifyCalls(":x := calc_desconto(1, 2) || 'calc_desconto(3)' || pkg.calc_desconto(4);", units), ":x := VENDAS_LIB_PKG.calc_desconto(1, 2) || 'calc_desconto(3)' || pkg.calc_desconto(4);");
});

test("biblioteca .pld é separada em program units", () => {
  const l = parseLibrary("LIB.pld", "/* x */\nFUNCTION a RETURN NUMBER IS BEGIN RETURN 1; END;\n\nPROCEDURE b IS BEGIN null; END;\n");
  assert.deepEqual(l.units.map((u) => [u.name, u.kind]), [["A", "Function"], ["B", "Procedure"]]);
});

test("faixas de páginas por form pulam páginas do export base", () => {
  const ir = (n: number) => ({ blocks: Array.from({ length: n }) }) as never;
  assert.deepEqual(allocatePages([ir(2), ir(12), ir(1)], new Set([200])), [100, 300, 500]);
});

test("aplicação VENDAS: forms, menu e biblioteca viram uma aplicação ligada", async () => {
  const r = await runApplication({ inputs: [APP], outDir: await out() });
  assert.equal(r.stats.forms, 5);
  assert.equal(r.stats.menus, 1);
  assert.equal(r.stats.libraries, 1);
  assert.equal(r.stats.blocking, 1); // HOST em CLIENTES
  const sql = r.files["install/03_apex_aplicacao.sql"];
  checkIds(sql);
  assert.match(sql, /apex_application_install\.get_workspace_id/); // sem base
  // CALL_FORM com :GLOBAL: botão leva o id na URL para a página de entrada do form chamado
  assert.match(sql, /p_button_redirect_url=>'f\?p=&APP_ID\.:300:&SESSION\.::&DEBUG\.:300:GLOBAL_PRODUTO_ID:&P500_ID\.'/);
  // Menu do Forms vira lista com pai e filhos; o form chamado só por botão fica fora do menu
  assert.match(sql, /p_list_item_link_text=>'Cadastros'/);
  assert.match(sql, /p_parent_list_item_id=>/);
  assert.doesNotMatch(sql, /p_list_item_link_text=>unistr\('Hist/);
  assert.match(sql, /create_flow_item\(\n p_id=>[^\n]*\n,p_name=>'GLOBAL_PRODUTO_ID'/);
  // HISTORICO lê a :GLOBAL como application item
  assert.match(sql, /produto_id = :GLOBAL_PRODUTO_ID/);
  // KEY-COMMIT com aviso vira Success Message
  assert.match(sql, /p_process_success_message=>'Registro gravado'/);
  // documentos
  const doubts = r.files["DUVIDAS_DE_REGRA.md"];
  assert.match(doubts, /FECHAMENTO, que não veio na migração/);
  assert.match(doubts, /Biblioteca VENDAS_LIB/); // AVISA usa message/synchronize
  assert.match(doubts, /D-001 · Bloqueante · CLIENTES/);
  assert.match(r.files["PROXIMOS_PASSOS.md"], /PRODUTOS: PRD\.BT_HISTORICO abre HISTORICO \(página 300\) levando GLOBAL_PRODUTO_ID/);
  assert.match(r.files["MAPA_DA_APLICACAO.md"], /\| VENDAS_LIB \| VENDAS_LIB_PKG \| CALC_DESCONTO, DIAS_UTEIS \| AVISA \| PEDIDOS \|/);
  assert.match(r.files["install/01_lib_vendas_lib_pkg.sql"], /create or replace package VENDAS_LIB_PKG/);
  assert.ok(r.files["forms/PRODUTOS/PENDENCIAS.md"]);
});

test("aplicação com export base: vira o export completo, com menu e itens dentro dele", async () => {
  const r = await runApplication({ inputs: [APP], outDir: await out(), apexBasePath: "tests/fixtures/base_app.sql" });
  const sql = r.files["install/03_f500_aplicacao.sql"];
  checkIds(sql);
  assert.match(sql, /p_default_id_offset=>2222222222222222/);
  assert.doesNotMatch(sql, /apex_application_install\.get_workspace_id/);
  // itens entram na lista Navigation Menu existente, depois do Home
  const nav = sql.slice(sql.indexOf("lists/navigation_menu"), sql.indexOf("prompt --application/shared_components/logic/application_items/global_cliente_id"));
  assert.match(nav, /'Home'[\s\S]*'Cadastros'[\s\S]*\nend;\n\/\n$/);
  // GLOBAL_CLIENTE_ID já existe na base: não é criado de novo
  assert.equal((sql.match(/,p_name=>'GLOBAL_CLIENTE_ID'/g) ?? []).length, 1);
  // páginas novas antes do fim e sem colidir com 10 e 1000
  assert.ok(sql.indexOf("page_00100") < sql.indexOf("prompt --application/end_environment"));
  assert.equal((sql.match(/prompt --application\/end_environment/g) ?? []).length, 1);
  assert.doesNotMatch(r.files["aplicacao.json"], /"entrada": (10|1000)\b/);
});
