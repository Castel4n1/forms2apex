import { basename, extname } from "node:path";
import type { IR } from "./ir.ts";

/**
 * Biblioteca PL/SQL do Forms (.pll). O frmf2xml não lê .pll; o texto vem do
 * `frmcmp module=LIB.pll module_type=library script=yes`, que gera LIB.pld.
 */
export interface Library {
  name: string;
  units: IR["programUnits"];
}

const UNIT_START = /^[ \t]*(package\s+body|package|procedure|function)\s+("?[\w$#]+"?)/gim;

/** Separa o .pld em program units. Tudo antes da primeira unit (comentários, cabeçalho) é ignorado. */
export function parseLibrary(fileName: string, text: string): Library {
  const name = basename(fileName, extname(fileName)).toUpperCase();
  const clean = text.replace(/\r\n/g, "\n").replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
  const starts = [...clean.matchAll(UNIT_START)].filter((m) => {
    // procedure/function dentro de package não é unit separada
    const before = clean.slice(0, m.index);
    const openPkgs = (before.match(/^[ \t]*package\b/gim) ?? []).length;
    const closedPkgs = (before.match(/^end\s+[\w$#]*\s*;\s*$/gim) ?? []).length;
    return /^package/i.test(m[1].trim()) || openPkgs <= closedPkgs || !/^\s*package/im.test(before);
  });
  const units: IR["programUnits"] = [];
  starts.forEach((m, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].index : text.length;
    const code = text.replace(/\r\n/g, "\n").slice(m.index, end).trim().replace(/\n\/\s*$/, "");
    const kw = m[1].replace(/\s+/g, " ").toLowerCase();
    const kind = kw === "package body" ? "Package Body" : kw === "package" ? "Package Spec" : kw === "function" ? "Function" : "Procedure";
    units.push({ name: m[2].replace(/"/g, "").toUpperCase(), kind, code });
  });
  return { name, units };
}
