import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const EXAMPLES = resolve(process.cwd(), "../../examples");

/** ?app=1: aplicação de exemplo inteira (forms, menu e biblioteca) em JSON. Sem parâmetro: um form. */
export async function GET(req: Request) {
  if (new URL(req.url).searchParams.get("app")) {
    const dir = resolve(EXAMPLES, "app_vendas");
    const names = (await readdir(dir)).filter((n) => /\.(xml|pld)$/i.test(n)).sort();
    const files = await Promise.all(names.map(async (name) => ({ name, content: await readFile(resolve(dir, name), "utf8") })));
    return Response.json({ files });
  }
  const xml = await readFile(resolve(EXAMPLES, "clientes.xml"), "utf8");
  return new Response(xml, { headers: { "content-type": "application/xml; charset=utf-8" } });
}
