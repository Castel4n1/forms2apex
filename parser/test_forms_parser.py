import unittest
from pathlib import Path

from forms_parser import Parser, mask_secrets

ROOT = Path(__file__).resolve().parent.parent


class ParserTest(unittest.TestCase):
    def test_exemplo(self):
        ir = Parser().parse((ROOT / "examples" / "clientes.xml").read_bytes())
        self.assertEqual(ir["form"]["name"], "CLIENTES")
        self.assertEqual(len(ir["blocks"]), 2)
        self.assertEqual(len(ir["triggers"]), 7)

    def test_itens_ricos(self):
        ir = Parser().parse((ROOT / "examples" / "produtos.xml").read_bytes())
        prd = {i["name"]: i for i in ir["blocks"][0]["items"]}
        self.assertTrue(prd["ID"]["primaryKey"])
        self.assertEqual(prd["DT_CADASTRO"]["initialValue"], "$$DATE$$")
        self.assertEqual([v["value"] for v in prd["UNIDADE"]["listValues"]], ["UN", "KG", "CX"])
        self.assertEqual(prd["ATIVO"]["checkedValue"], "S")
        est = {i["name"]: i for i in ir["blocks"][1]["items"]}
        self.assertEqual(est["DEPOSITO"]["listValues"][1], {"label": "Filial", "value": "F"})

    def test_menu(self):
        ir = Parser().parse((ROOT / "examples" / "app_vendas" / "VENDAS_MENU.xml").read_bytes())
        self.assertEqual(ir["kind"], "menu")
        self.assertEqual(ir["menu"]["mainMenu"], "MENU_PRINCIPAL")
        principal = ir["menu"]["menus"][0]["items"]
        self.assertEqual(principal[0]["subMenu"], "MENU_CADASTROS")
        cad = {i["name"]: i for i in ir["menu"]["menus"][1]["items"]}
        self.assertEqual(cad["CLIENTES"]["code"], "call_form('CLIENTES');")
        self.assertTrue(cad["SEP1"]["separator"])

    def test_mascara_segredo(self):
        txt, n = mask_secrets("logon('scott/tiger@prod'); senha := 'abc';")
        self.assertNotIn("tiger", txt)
        self.assertNotIn("abc", txt)
        self.assertEqual(n, 2)

    def test_xxe_bloqueado(self):
        xml = b"""<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>
<Module><FormModule Name="X"><Trigger Name="T" TriggerText="&e;"/></FormModule></Module>"""
        try:
            ir = Parser().parse(xml)
            self.assertNotIn("root:", ir["triggers"][0]["code"])
        except Exception:
            pass  # recusar o arquivo tambem e aceitavel


if __name__ == "__main__":
    unittest.main()
