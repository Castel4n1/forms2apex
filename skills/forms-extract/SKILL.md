---
name: forms-extract
description: Converte o XML do Oracle Forms em IR (JSON enxuto) com o parser Python, mascarando segredos. Use antes de qualquer análise de um form.
---

# Extração

```bash
python3 -I parser/forms_parser.py <form.xml> > output/<FORM>/ir.json
```

- Leia a IR, nunca o XML bruto: ela é dezenas de vezes menor e economiza tokens.
- Se `meta.secretsMasked > 0`, avise o usuário que há credenciais no form original.
- Para PLLs: gere o XML da biblioteca e trate como program units.
