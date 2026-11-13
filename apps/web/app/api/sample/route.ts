import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export async function GET() {
  const xml = await readFile(resolve(process.cwd(), "../../examples/clientes.xml"), "utf8");
  return new Response(xml, { headers: { "content-type": "application/xml; charset=utf-8" } });
}
