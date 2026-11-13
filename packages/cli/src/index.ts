#!/usr/bin/env -S npx tsx
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runApplication, runPipeline } from "../../core/src/index.ts";

// .env da raiz do projeto (ANTHROPIC_API_KEY etc.). Variáveis já definidas no ambiente têm prioridade.
const rootEnv = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env");
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string", default: "output" },
    profile: { type: "string" },
    "apex-base": { type: "string" },
    name: { type: "string" },
    json: { type: "boolean", default: false },
  },
});

const [cmd, ...inputs] = positionals;
if (cmd !== "migrate" || !inputs.length) {
  console.error(`uso:
  f2a migrate <form.xml> [--out pasta] [--profile perfil.json] [--apex-base fNNN.sql] [--json]
  f2a migrate <pasta-da-aplicacao | forms.xml menu.xml lib.pld ...> [--name NOME] [mesmas opções]

Com uma pasta ou vários arquivos, migra a aplicação inteira: forms (.xml), menu (.xml do .mmb)
e bibliotecas (.pld) viram uma aplicação APEX, com PROXIMOS_PASSOS.md e DUVIDAS_DE_REGRA.md.`);
  process.exit(2);
}
const appMode = inputs.length > 1 || inputs.some((i) => existsSync(i) && statSync(i).isDirectory()) || /\.pld$/i.test(inputs[0]);

const profile = values.profile ? JSON.parse(await readFile(values.profile, "utf8")) : {};
const icon = { rodando: "..", ok: "OK", aviso: "!!", erro: "XX" } as const;

try {
  if (appMode) {
    const res = await runApplication({
      inputs,
      outDir: values.out!,
      profile,
      apexBasePath: values["apex-base"],
      name: values.name,
      onEvent: (e) => (values.json ? console.log(JSON.stringify(e)) : console.log(`[${icon[e.status]}] ${e.phase.padEnd(14)} ${e.message}`)),
    });
    if (!values.json) console.log(`\nResumo: ${JSON.stringify(res.stats)}\nComece por ${values.out}/PROXIMOS_PASSOS.md`);
    process.exit(res.stats.blocking ? 1 : 0);
  }
  const res = await runPipeline({
    xmlPath: inputs[0],
    outDir: values.out!,
    profile,
    apexBasePath: values["apex-base"],
    onEvent: (e) => (values.json ? console.log(JSON.stringify(e)) : console.log(`[${icon[e.status]}] ${e.phase.padEnd(14)} ${e.message}`)),
  });
  if (!values.json) console.log(`\nResumo: ${JSON.stringify(res.stats)}`);
  process.exit(res.stats.blocking ? 1 : 0);
} catch (err) {
  console.error((err as Error).message);
  process.exit(3);
}
