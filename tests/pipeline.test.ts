import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyRules, resolveProfile, runPipeline, scanCode, translateBinds } from "../packages/core/src/index.ts";

const t = (name: string, code: string) => ({ name, scope: "item" as const, owner: "CLI.CPF", code });
const map = (b: string, i: string) => `P10_${i}`;

test("binds :BLOCO.ITEM viram itens de página, :GLOBAL vira application item", () => {
  assert.equal(translateBinds("x(:cli.cpf) and :global.y and :system.z", map), "x(:P10_CPF) and :GLOBAL_Y and :system.z");
});

test("validação booleana vira validation APEX", () => {
  const c = applyRules(t("WHEN-VALIDATE-ITEM", "if not f(:cli.cpf) then message('x'); raise form_trigger_failure; end if;"), map);
  assert.equal(c?.apexComponent, "validation");
  assert.equal(c?.code, "return f(:P10_CPF);");
});

test("código fora do padrão não casa com regra", () => {
  assert.equal(applyRules(t("WHEN-VALIDATE-ITEM", "if a then b; end if; delete from x;"), map), null);
});

test("HOST é bloqueante", () => {
  assert.equal(scanCode("host('ls')", "x")[0].severity, "bloqueante");
});

test("'não sei' aplica padrão seguro e registra", () => {
  const p = resolveProfile({ fidelidade: "nao_sei", uso_ia: "sim" });
  assert.equal(p.answers.fidelidade, "hibrido");
  assert.ok(p.unknown.includes("fidelidade"));
  assert.ok(!p.unknown.includes("uso_ia"));
});

test("exemplo CLIENTES: nada some, HOST vira pendência bloqueante", async () => {
  const out = await mkdtemp(join(tmpdir(), "f2a-"));
  const r = await runPipeline({ xmlPath: "examples/clientes.xml", outDir: out });
  assert.equal(r.stats.triggers, 7);
  assert.equal(r.stats.blocking, 1);
  // todo trigger termina convertido ou com pendência
  const conv = JSON.parse(r.files["conversoes.json"]);
  for (const c of conv) assert.ok(c.apexComponent || c.pendencias.length, c.origem);
  assert.match(r.files["install/03_queries_regioes.sql"], /where t\.cliente_id = :P10_ID/);
});
