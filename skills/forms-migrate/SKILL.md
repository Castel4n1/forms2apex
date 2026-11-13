---
name: forms-migrate
description: Migra um Oracle Forms (XML do frmf2xml) para Oracle APEX de ponta a ponta. Use quando o usuário pedir para migrar, converter ou analisar um form .fmb/.xml para APEX.
---

# Migrar um form para APEX

Orquestra as outras skills. Nunca pule a pré-orientação.

1. Confirme que existe o XML. Se o usuário só tiver o `.fmb`, peça para rodar `frmf2xml ARQUIVO.fmb` no Forms Builder.
2. Rode a skill `forms-preorientacao` e salve as respostas em `profile.json`.
3. Rode: `npm run migrate -- <form.xml> --out output/<FORM> --profile profile.json --json` (acrescente `--apex-base fNNN.sql` se houver aplicação de destino).
4. Leia `output/<FORM>/PENDENCIAS.md`. Para cada pendência que não for bloqueante, use a skill `trigger-convert`.
5. Use a skill `apex-generate` para importar `install/04_apex_paginas.sql` e fazer os ajustes de `COMO_IMPORTAR.md`.
6. Use a skill `apex-validate` no schema DEV.
7. Entregue ao usuário: resumo, número de pendências por severidade e o caminho da pasta.

Regras:
- Código de cliente nunca vai para `examples/`, `rag/` ou commits.
- Pendência bloqueante não é resolvida pelo agente sem aprovação explícita do usuário.
- Não invente tabela, coluna ou package que não apareça na IR ou no banco.
