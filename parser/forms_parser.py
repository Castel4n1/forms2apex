#!/usr/bin/env python3
"""Converte o XML gerado pelo frmf2xml (form .fmb ou menu .mmb do Oracle Forms) em IR (JSON enxuto).

Uso:
    python3 forms_parser.py entrada.xml > ir.json

Seguranca:
    - parser sem resolucao de entidades e sem rede (bloqueia XXE)
    - limite de tamanho do arquivo
    - segredos (senhas, connect strings) mascarados antes de qualquer envio a IA
"""
import json
import re
import sys
from pathlib import Path

from lxml import etree

IR_VERSION = "1.0"
MAX_BYTES = 5 * 1024 * 1024

SECRET_PATTERNS = [
    (re.compile(r"(?i)(password|senha|pwd)\s*(=|:=)\s*'[^']*'"), r"\1 \2 '***'"),
    (re.compile(r"(?i)\b(\w+)/(\w+)@([\w.\-:/]+)"), r"\1/***@***"),
    (re.compile(r"(?i)(identified\s+by\s+)\S+"), r"\1***"),
]


def mask_secrets(text: str) -> tuple[str, int]:
    hits = 0
    for pattern, repl in SECRET_PATTERNS:
        text, n = pattern.subn(repl, text)
        hits += n
    return text, hits


def local(tag) -> str:
    return etree.QName(tag).localname if isinstance(tag, str) else ""


def children(el, name):
    return [c for c in el if local(c.tag) == name]


def attr(el, name, default=None):
    return el.get(name, default)


def clean_code(text):
    if not text:
        return ""
    # frmf2xml codifica quebras de linha como &#10;
    return text.replace("\r\n", "\n").strip()


class Parser:
    def __init__(self):
        self.secrets_masked = 0

    def code(self, text):
        masked, hits = mask_secrets(clean_code(text))
        self.secrets_masked += hits
        return masked

    def trigger(self, el, scope, owner):
        return {
            "name": attr(el, "Name", "").upper(),
            "scope": scope,
            "owner": owner,
            "code": self.code(attr(el, "TriggerText", "")),
        }

    def item(self, el, block_name, triggers):
        name = attr(el, "Name")
        for t in children(el, "Trigger"):
            triggers.append(self.trigger(t, "item", f"{block_name}.{name}"))
        data = {
            "name": name,
            "type": attr(el, "ItemType", "Text Item"),
            "dataType": attr(el, "DataType"),
            "maxLength": int(attr(el, "MaximumLength")) if attr(el, "MaximumLength", "").isdigit() else None,
            "prompt": attr(el, "Prompt"),
            "label": attr(el, "Label"),
            "required": attr(el, "Required") == "true",
            "dbItem": attr(el, "DatabaseItem", "true") != "false",
            "column": attr(el, "ColumnName") or name,
            "lov": attr(el, "LovName"),
            "canvas": attr(el, "CanvasName"),
            "visible": attr(el, "Visible", "true") != "false",
            "primaryKey": attr(el, "PrimaryKey") == "true" or None,
            # frmf2xml usa InitializeValue; algumas versoes exportam InitialValue
            "initialValue": attr(el, "InitializeValue") or attr(el, "InitialValue"),
            "checkedValue": attr(el, "CheckedValue"),
            "uncheckedValue": attr(el, "UncheckedValue"),
            "listValues": self.list_values(el) or None,
        }
        return {k: v for k, v in data.items() if v not in (None, "")}

    @staticmethod
    def list_values(el):
        """Elementos de List Item e botoes de Radio Group: [{label, value}]."""
        out = []
        for c in el:
            name = local(c.tag)
            if name == "ListItemElement":
                out.append({"label": attr(c, "Name", ""), "value": attr(c, "Value", attr(c, "Name", ""))})
            elif name == "RadioButton":
                out.append({"label": attr(c, "Label") or attr(c, "Name", ""), "value": attr(c, "RadioButtonValue", attr(c, "Name", ""))})
        return out

    def block(self, el, triggers):
        name = attr(el, "Name")
        for t in children(el, "Trigger"):
            triggers.append(self.trigger(t, "block", name))
        records = attr(el, "RecordsDisplayCount", "1")
        return {
            "name": name,
            "source": attr(el, "QueryDataSourceName") or attr(el, "DMLDataName"),
            "dbBlock": attr(el, "DatabaseBlock", "true") != "false",
            "records": int(records) if records.isdigit() else 1,
            "where": attr(el, "WhereClause"),
            "orderBy": attr(el, "OrderByClause"),
            "insertAllowed": attr(el, "InsertAllowed", "true") != "false",
            "updateAllowed": attr(el, "UpdateAllowed", "true") != "false",
            "deleteAllowed": attr(el, "DeleteAllowed", "true") != "false",
            "items": [self.item(i, name, triggers) for i in children(el, "Item")],
        }

    def menu(self, module) -> dict:
        """MenuModule (.mmb pelo frmf2xml): menus, itens e o codigo de cada comando."""
        menus = []
        for m in children(module, "Menu"):
            items = []
            for it in children(m, "MenuItem"):
                command = (attr(it, "CommandType") or "").lower()
                sub = attr(it, "SubMenuName") or attr(it, "SubMenu")
                kind = "menu" if command == "menu" or sub else "plsql" if "pl/sql" in command or attr(it, "MenuItemCode") else "nenhum"
                items.append({
                    "name": attr(it, "Name"),
                    "label": attr(it, "Label") or attr(it, "Name"),
                    "kind": kind,
                    "subMenu": sub,
                    "code": self.code(attr(it, "MenuItemCode") or attr(it, "CommandText") or ""),
                    "separator": (attr(it, "MenuItemType") or "").lower() == "separator",
                })
            menus.append({"name": attr(m, "Name"), "title": attr(m, "Title"), "items": items})
        return {
            "irVersion": IR_VERSION,
            "kind": "menu",
            "menu": {"name": attr(module, "Name"), "mainMenu": attr(module, "MainMenu") or (menus[0]["name"] if menus else None), "menus": menus},
            "meta": {"secretsMasked": self.secrets_masked},
        }

    def parse(self, xml_bytes: bytes) -> dict:
        safe = etree.XMLParser(resolve_entities=False, no_network=True, huge_tree=False, load_dtd=False)
        root = etree.fromstring(xml_bytes, parser=safe)
        find = lambda name: root if local(root.tag) == name else next((e for e in root.iter() if local(e.tag) == name), None)
        form = find("FormModule")
        if form is None:
            menu = find("MenuModule")
            if menu is not None:
                return self.menu(menu)
            raise ValueError("Elemento FormModule ou MenuModule nao encontrado. O arquivo foi gerado pelo frmf2xml?")

        triggers = [self.trigger(t, "form", attr(form, "Name")) for t in children(form, "Trigger")]
        blocks = [self.block(b, triggers) for b in children(form, "Block")]

        return {
            "irVersion": IR_VERSION,
            "kind": "form",
            "form": {
                "name": attr(form, "Name"),
                "title": attr(form, "Title"),
                "firstBlock": attr(form, "FirstNavigationBlockName"),
            },
            "blocks": blocks,
            "triggers": triggers,
            "programUnits": [
                {
                    "name": attr(p, "Name"),
                    "kind": attr(p, "ProgramUnitType", "Procedure"),
                    "code": self.code(attr(p, "ProgramUnitText", "")),
                }
                for p in children(form, "ProgramUnit")
            ],
            "lovs": [
                {"name": attr(l, "Name"), "recordGroup": attr(l, "RecordGroupName"), "title": attr(l, "Title")}
                for l in children(form, "LOV")
            ],
            "recordGroups": [
                {"name": attr(r, "Name"), "query": clean_code(attr(r, "RecordGroupQuery", ""))}
                for r in children(form, "RecordGroup")
            ],
            "canvases": [
                {"name": attr(c, "Name"), "kind": attr(c, "CanvasType", "Content")}
                for c in children(form, "Canvas")
            ],
            "attachedLibraries": [attr(a, "Name") for a in children(form, "AttachedLibrary")],
            "meta": {"secretsMasked": self.secrets_masked},
        }


def main():
    if len(sys.argv) != 2:
        print("uso: forms_parser.py arquivo.xml", file=sys.stderr)
        sys.exit(2)
    path = Path(sys.argv[1])
    if path.stat().st_size > MAX_BYTES:
        print(f"arquivo maior que {MAX_BYTES} bytes", file=sys.stderr)
        sys.exit(3)
    try:
        ir = Parser().parse(path.read_bytes())
    except (etree.XMLSyntaxError, ValueError) as exc:
        print(f"erro de parse: {exc}", file=sys.stderr)
        sys.exit(4)
    json.dump(ir, sys.stdout, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
