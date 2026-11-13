#!/usr/bin/env -S npx tsx
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runPipeline } from "../../core/src/index.ts";

// .env da raiz do projeto (ANTHROPIC_API_KEY etc.). Variáveis já definidas no ambiente têm prioridade.
const rootEnv = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env");
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string", default: "output" },
    profile: { type: "string" },
    "apex-base": { type: "string" },
    json: { type: "boolean", default: false },
  },
});

const [cmd, xml] = positionals;
if (cmd !== "migrate" || !xml) {
  console.error("uso: f2a migrate <form.xml> [--out pasta] [--profile perfil.json] [--apex-base fNNN.sql] [--json]");
  process.exit(2);
}

const profile = values.profile ? JSON.parse(await readFile(values.profile, "utf8")) : {};
const icon = { rodando: "..", ok: "OK", aviso: "!!", erro: "XX" } as const;

try {
  const res = await runPipeline({
    xmlPath: xml,
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
