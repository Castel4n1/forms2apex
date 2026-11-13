---
name: forms-preorientacao
description: Faz as perguntas de pré-orientação antes de migrar um form (fidelidade visual, multirregistro, program units, validações, teclas, uso de IA) e grava profile.json.
---

# Pré-orientação

Pergunte as opções definidas em `packages/core/src/profile.ts` (QUESTIONS). Sempre ofereça "Não sei".

Antes de perguntar, rode a extração e mostre o diagnóstico de riscos (HOST, WEBUTIL, CALL_FORM, Reports, serviços externos, DB links). Esses itens mudam as respostas.

Grave `profile.json` assim:

```json
{ "fidelidade": "hibrido", "multirregistro": "interactive_grid", "program_units": "package",
  "validacoes": "servidor", "teclas_menus": "botoes", "uso_ia": "nao" }
```

Valores desconhecidos ou "nao_sei" aplicam o padrão seguro e aparecem em `DECISOES.md`.
