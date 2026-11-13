import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyRules, parseApexBase, runPipeline, sqlString, sqlText, translateBinds, translateExpr } from "../packages/core/src/index.ts";

const map = (b: string, i: string) => `P10_${i}`;
const rule = (name: string, code: string, owner = "PRD") => applyRules({ name, scope: "block", owner, code }, map);

test("binds dentro de literal não são trocados", () => {
  assert.equal(translateBinds("x := ':prd.id' || :prd.id;", map), "x := ':prd.id' || :P10_ID;");
});

test("USER do Forms vira :APP_USER, mas não dentro de texto nem em user_x", () => {
  assert.equal(translateExpr(":prd.u := user || 'user' || user_name", map), ":P10_U := :APP_USER || 'user' || user_name");
});

test("teclas com built-in padrão são nativas", () => {
  assert.equal(rule("KEY-EXIT", "exit_form;")?.ruleId, "tecla_builtin_padrao");
  assert.equal(rule("KEY-NXTBLK", "do_key('next_block');")?.apexComponent, "nativo");
  assert.equal(rule("KEY-EXIT", "if x then exit_form; end if;"), null);
});

test("abertura com set_window_property e execute_query é nativa", () => {
  assert.equal(rule("WHEN-NEW-FORM-INSTANCE", "set_window_property(forms_mdi_window, window_state, maximize); go_block('PRD'); execute_query;")?.apexComponent, "nativo");
});

test("PRE-INSERT com sequence e auditoria vira processo com atribuições", () => {
  const c = rule("PRE-INSERT", "select s.nextval into :prd.id from dual; :prd.usu := user; :prd.dt := sysdate;");
  assert.equal(c?.apexComponent, "process");
  assert.equal(c?.assignments?.length, 3);
  assert.equal(c?.assignments?.[0].sequence, "S");
  assert.match(c!.code!, /:P10_USU := :APP_USER;/);
});

test("atribuição com built-in do Forms não é convertida por regra", () => {
  assert.equal(rule("PRE-UPDATE", ":prd.x := name_in('prd.y');"), null);
  assert.equal(rule("PRE-UPDATE", ":prd.x := minha_func(1);"), null);
});

test("WHEN-CREATE-RECORD vira default de item", () => {
  const c = rule("WHEN-CREATE-RECORD", ":prd.ativo := 'S'; :prd.qtd := 0;");
  assert.equal(c?.apexComponent, "item_default");
  assert.deepEqual(c?.assignments?.map((a) => a.target), ["PRD.ATIVO", "PRD.QTD"]);
});

test("POST-QUERY com vários lookups e exception vira subconsultas", () => {
  const c = rule("POST-QUERY", "begin select nome into :prd.d1 from cat where id = :prd.c1; exception when no_data_found then :prd.d1 := null; end; select x into :prd.d2 from forn f where f.id = :prd.c2;");
  assert.equal(c?.lookups?.length, 2);
  assert.equal(c?.lookups?.[1].table, "forn");
});

test("validação com condição genérica inverte o IF e trata nulo como no Forms", () => {
  const c = rule("WHEN-VALIDATE-ITEM", "if :prd.preco < 0 then message('Negativo'); raise form_trigger_failure; end if;", "PRD.PRECO");
  assert.equal(c?.ruleId, "validacao_condicao");
  assert.equal(c?.code, "return not nvl((:P10_PRECO < 0), false);");
  assert.equal(c?.message, "Negativo");
});

test("obrigatório vira Value Required", () => {
  assert.equal(rule("WHEN-VALIDATE-ITEM", "if :prd.cod is null then message('Informe'); raise form_trigger_failure; end if;", "PRD.COD")?.apexComponent, "required");
});

test("lookup ao validar fica abaixo da confiança mínima (vira pendência de revisão)", () => {
  const c = rule("WHEN-VALIDATE-ITEM", "select nome into :prd.d from cat where id = :prd.c;", "PRD.C");
  assert.ok(c && c.confidence < 0.75);
});

test("literal SQL: aspas dobradas e não ASCII em unistr", () => {
  assert.equal(sqlString("it's"), "'it''s'");
  assert.equal(sqlString("Código"), "unistr('C\\00F3digo')");
  assert.match(sqlText("a\nb"), /^wwv_flow_string\.join\(wwv_flow_t_varchar2\(\n'a',\n'b'\)\)$/);
});

test("export base: lê cabeçalho, tema atual e páginas usadas", async () => {
  const base = await readFile("tests/fixtures/base_app.sql", "utf8");
  const b = parseApexBase(base);
  assert.equal(b.applicationId, "500");
  assert.equal(b.idOffset, "2222222222222222");
  assert.equal(b.themeId, "42");
  assert.equal(b.templates.form, "wwv_flow_imp.id(104)");
  // 26.2: template do tema assinado vem como número puro
  assert.equal(parseApexBase(base.replace("p_default_form_template=>wwv_flow_imp.id(104)", "p_default_form_template=>4075786578761660127")).templates.form, "4075786578761660127");
  assert.deepEqual([...b.usedPages].sort((x, y) => x - y), [10, 1000]);
});

/** Checagem estrutural do script: parênteses e aspas balanceados, IDs referenciados existem, só ASCII. */
function checkScript(sql: string) {
  assert.ok(/^[\x00-\x7f]*$/.test(sql), "script deve ser só ASCII (não ASCII vai em unistr)");
  const noStrings = sql.replace(/'(?:[^']|'')*'/g, "''");
  assert.ok(!noStrings.includes("'''"), "aspas desbalanceadas");
  let depth = 0;
  for (const ch of noStrings) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    assert.ok(depth >= 0, "parêntese fechando sem abrir");
  }
  assert.equal(depth, 0, "parênteses desbalanceados");
  assert.equal((sql.match(/^begin$/gm) ?? []).length, (sql.match(/^end;$/gm) ?? []).length, "begin/end desbalanceados");
  const defined = new Set([...sql.matchAll(/^ p_id=>wwv_flow_imp\.id\((\d+)\)/gm)].map((m) => m[1]));
  for (const m of sql.matchAll(/,p_(\w+)=>wwv_flow_imp\.id\((\d+)\)/g)) {
    if (/template/.test(m[1])) continue; // templates vêm da aplicação base
    assert.ok(defined.has(m[2]), `p_${m[1]} aponta para id ${m[2]} que não foi criado`);
  }
  assert.equal(defined.size, (sql.match(/^ p_id=>wwv_flow_imp\.id\(/gm) ?? []).length, "id duplicado");
}

test("exemplo PRODUTOS: regras cobrem 15 de 16 triggers e o script APEX é consistente", async () => {
  const out = await mkdtemp(join(tmpdir(), "f2a-"));
  const r = await runPipeline({ xmlPath: "examples/produtos.xml", outDir: out });
  assert.equal(r.stats.triggers, 16);
  assert.equal(r.stats.converted, 15);
  // CALL_FORM de um form que não veio: botão sem destino vira ajuste manual, :GLOBAL vira application item
  assert.match(r.files["COMO_IMPORTAR.md"], /chama o form HISTORICO \(CALL_FORM\), que não está nesta migração/);
  assert.match(r.files["COMO_IMPORTAR.md"], /Application Items GLOBAL_PRODUTO_ID/);
  assert.equal(r.stats.blocking, 0);
  const sql = r.files["install/04_apex_paginas.sql"];
  checkScript(sql);
  assert.match(sql, /p_plug_source_type=>'NATIVE_FORM'/);
  assert.match(sql, /p_plug_source_type=>'NATIVE_IG'/);
  assert.match(sql, /p_plug_source_type=>'NATIVE_IR'/);
  assert.match(sql, /p_default_expression=>'select estoque_seq.nextval from dual'/);
  assert.match(sql, /p_lov=>'STATIC2:Unidade;UN,Quilo;KG,Caixa;CX'/);
  assert.match(sql, /'  :USUARIO_ALT := :APP_USER;'/);
  assert.match(sql, /apex_application_install\.get_workspace_id/); // sem base: exige apex_application_install
  const pkg = r.files["install/01_produtos_pkg.sql"];
  assert.match(pkg, /function margem/);
  assert.doesNotMatch(pkg.replace(/^--.*$/gm, ""), /text_io/, "unit com TEXT_IO fica fora do package");
});

test("com export base: herda offset e templates e evita páginas existentes", async () => {
  const out = await mkdtemp(join(tmpdir(), "f2a-"));
  const r = await runPipeline({ xmlPath: "examples/clientes.xml", outDir: out, apexBasePath: "tests/fixtures/base_app.sql" });
  const sql = r.files["install/04_apex_paginas.sql"];
  checkScript(sql);
  assert.match(sql, /p_default_id_offset=>2222222222222222/);
  assert.match(sql, /p_plug_template=>wwv_flow_imp\.id\(104\)/);
  assert.match(sql, /p_step_template=>wwv_flow_imp\.id\(101\)/);
  assert.match(sql, /page_02000/);
  assert.doesNotMatch(sql, /apex_application_install\.get_workspace_id/);
  assert.match(r.files["blueprint.json"], /"id": 2000/);
});

test("exemplo CLIENTES: script APEX consistente", async () => {
  const out = await mkdtemp(join(tmpdir(), "f2a-"));
  const r = await runPipeline({ xmlPath: "examples/clientes.xml", outDir: out });
  checkScript(r.files["install/04_apex_paginas.sql"]);
  assert.match(r.files["install/04_apex_paginas.sql"], /p_source=>'select descricao from cidades where id = :P10_CIDADE_ID'/);
});
