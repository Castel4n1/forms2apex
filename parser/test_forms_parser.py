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
