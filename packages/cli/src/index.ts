#!/usr/bin/env -S npx tsx
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { runPipeline } from "../../core/src/index.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string", default: "output" },
    profile: { type: "string" },
    json: { type: "boolean", default: false },
  },
});

const [cmd, xml] = positionals;
if (cmd !== "migrate" || !xml) {
  console.error("uso: f2a migrate <form.xml> [--out pasta] [--profile perfil.json] [--json]");
  process.exit(2);
}

const profile = values.profile ? JSON.parse(await readFile(values.profile, "utf8")) : {};
const icon = { rodando: "..", ok: "OK", aviso: "!!", erro: "XX" } as const;

try {
  const res = await runPipeline({
    xmlPath: xml,
    outDir: values.out!,
    profile,
    onEvent: (e) => (values.json ? console.log(JSON.stringify(e)) : console.log(`[${icon[e.status]}] ${e.phase.padEnd(14)} ${e.message}`)),
  });
  if (!values.json) console.log(`\nResumo: ${JSON.stringify(res.stats)}`);
  process.exit(res.stats.blocking ? 1 : 0);
} catch (err) {
  console.error((err as Error).message);
  process.exit(3);
}
