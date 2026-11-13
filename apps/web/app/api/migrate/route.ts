import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runPipeline, type PipelineEvent } from "@forms2apex/core";
import { allow, LIMITS } from "../../../lib/limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

process.env.F2A_PARSER ??= resolve(process.cwd(), "../../parser/forms_parser.py");

export async function POST(req: Request) {
  const ip = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  if (!allow(ip)) return Response.json({ error: "Limite de migrações por hora atingido. Tente mais tarde." }, { status: 429 });

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return Response.json({ error: "Envie o XML do form." }, { status: 400 });
  if (file.size > LIMITS.maxBytes) return Response.json({ error: `Arquivo acima de ${LIMITS.maxBytes / 1024 / 1024} MB.` }, { status: 413 });
  if (!/\.xml$/i.test(file.name)) return Response.json({ error: "Aceitamos apenas o XML gerado pelo frmf2xml." }, { status: 415 });

  let profile: Record<string, string> = {};
  try {
    profile = JSON.parse(String(form.get("profile") ?? "{}"));
  } catch {
    return Response.json({ error: "Perfil inválido." }, { status: 400 });
  }

  const dir = await mkdtemp(join(tmpdir(), "f2a-"));
  const xmlPath = join(dir, "form.xml");
  await writeFile(xmlPath, Buffer.from(await file.arrayBuffer()));

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(ctrl) {
      const send = (obj: unknown) => ctrl.enqueue(enc.encode(JSON.stringify(obj) + "\n"));
      try {
        const res = await runPipeline({
          xmlPath,
          outDir: join(dir, "out"),
          profile,
          limits: { maxBlocks: LIMITS.maxBlocks, maxTriggers: LIMITS.maxTriggers },
          onEvent: (e: PipelineEvent) => send({ type: "event", ...e }),
        });
        send({ type: "result", stats: res.stats, files: res.files });
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
