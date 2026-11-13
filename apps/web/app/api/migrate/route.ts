import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { runApplication, runPipeline, type PipelineEvent } from "@forms2apex/core";
import { allow, LIMITS } from "../../../lib/limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

process.env.F2A_PARSER ??= resolve(process.cwd(), "../../parser/forms_parser.py");

/**
 * Um .xml: migra o form. Vários arquivos (forms, menu .xml, bibliotecas .pld): migra a aplicação inteira.
 * Um .sql opcional é o export da aplicação APEX de destino.
 */
export async function POST(req: Request) {
  const ip = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  if (!allow(ip)) return Response.json({ error: "Limite de migrações por hora atingido. Tente mais tarde." }, { status: 429 });

  const form = await req.formData();
  const all = form.getAll("file").filter((f): f is File => f instanceof File);
  if (!all.length) return Response.json({ error: "Envie o XML do form ou os arquivos da aplicação." }, { status: 400 });
  if (all.length > LIMITS.maxFiles) return Response.json({ error: `A demo aceita até ${LIMITS.maxFiles} arquivos.` }, { status: 413 });
  const sources = all.filter((f) => /\.(xml|pld)$/i.test(f.name));
  const bases = all.filter((f) => /\.sql$/i.test(f.name));
  const other = all.filter((f) => !sources.includes(f) && !bases.includes(f));
  if (other.length) return Response.json({ error: `Formato não aceito: ${other.map((f) => f.name).join(", ")}. Envie .xml (frmf2xml), .pld (biblioteca) e, opcional, o export .sql da aplicação APEX.` }, { status: 415 });
  if (!sources.length) return Response.json({ error: "Envie pelo menos um XML de form." }, { status: 400 });
  if (bases.length > 1) return Response.json({ error: "Envie só um export de aplicação APEX (.sql)." }, { status: 400 });
  const big = sources.find((f) => f.size > LIMITS.maxBytes);
  if (big) return Response.json({ error: `${big.name} passa de ${LIMITS.maxBytes / 1024 / 1024} MB.` }, { status: 413 });
  if (bases[0] && bases[0].size > LIMITS.maxBaseBytes) return Response.json({ error: `O export APEX passa de ${LIMITS.maxBaseBytes / 1024 / 1024} MB.` }, { status: 413 });

  let profile: Record<string, string> = {};
  try {
    profile = JSON.parse(String(form.get("profile") ?? "{}"));
  } catch {
    return Response.json({ error: "Perfil inválido." }, { status: 400 });
  }

  const dir = await mkdtemp(join(tmpdir(), "f2a-"));
  const src = join(dir, "src");
  await mkdir(src);
  const paths: string[] = [];
  for (const f of sources) {
    const p = join(src, basename(f.name).replace(/[^\w.\-]/g, "_"));
    await writeFile(p, Buffer.from(await f.arrayBuffer()));
    paths.push(p);
  }
  let basePath: string | undefined;
  if (bases[0]) {
    basePath = join(dir, "base.sql");
    await writeFile(basePath, Buffer.from(await bases[0].arrayBuffer()));
  }
  const appMode = sources.length > 1 || /\.pld$/i.test(sources[0].name);

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(ctrl) {
      const send = (obj: unknown) => ctrl.enqueue(enc.encode(JSON.stringify(obj) + "\n"));
      const onEvent = (e: PipelineEvent) => send({ type: "event", ...e });
      try {
        if (appMode) {
          const res = await runApplication({ inputs: [src], outDir: join(dir, "out"), profile, apexBasePath: basePath, limits: { maxForms: LIMITS.maxForms, maxBlocks: LIMITS.maxBlocks, maxTriggers: LIMITS.maxTriggers }, onEvent });
          send({ type: "result", mode: "app", stats: res.stats, files: res.files });
        } else {
          const res = await runPipeline({ xmlPath: paths[0], outDir: join(dir, "out"), profile, apexBasePath: basePath, limits: { maxBlocks: LIMITS.maxBlocks, maxTriggers: LIMITS.maxTriggers }, onEvent });
          send({ type: "result", mode: "form", stats: res.stats, files: res.files });
        }
      } catch (err) {
        send({ type: "error", message: (err as Error).message.slice(0, 400) });
      } finally {
        await rm(dir, { recursive: true, force: true }); // nada fica guardado no servidor
        ctrl.close();
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}
