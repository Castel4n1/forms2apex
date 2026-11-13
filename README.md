# forms2apex

Migrador open source de **Oracle Forms para Oracle APEX**, com interface que mostra a migração acontecendo, pré-orientação obrigatória e relatório de regras pendentes.

> Status: v0.1 (MVP). Extração, diagnóstico, regras determinísticas, plano de páginas, SQL e relatórios funcionam. A geração do script de import APEX completo está no roadmap (fase 3).

## Como funciona

1. **Pré-orientação**: você decide fidelidade visual, tratamento de multirregistro, program units, validações. "Não sei" aplica um padrão seguro e registra a dúvida.
2. **Extração**: o XML do `frmf2xml` vira uma IR enxuta (economia de tokens).
3. **Classificação**: riscos como `HOST`, `WEBUTIL`, `CALL_FORM`, Reports, serviços externos e DB links são detectados.
4. **Conversão**: regra determinística primeiro, IA (Claude) só se você habilitar e nenhuma regra cobrir.
5. **Geração**: blueprint das páginas, package com program units, LOVs e queries das regiões.
6. **Relatórios**: `PENDENCIAS.md`, `RASTREABILIDADE.md`, `DECISOES.md`, `ROTEIRO_TESTES.md`.

## Começando

Requisitos: Node 20+, Python 3.10+ com `lxml`.

```bash
npm install
pip install -r parser/requirements.txt
npm run migrate -- examples/clientes.xml --out output/clientes
npm run dev   # interface em http://localhost:3000
```

Para usar IA: copie `.env.example` para `.env`, preencha `ANTHROPIC_API_KEY` e responda "Sim" em "Usar IA".

Gerar o XML do seu form (precisa do Forms Builder):

```bash
frmf2xml MEU_FORM.fmb
```

## Docker

```bash
docker compose up --build
```

## Com agentes (Maestri / Claude Code)

Coloque a pasta no workspace do agente. O `CLAUDE.md` e as skills em `skills/` explicam o fluxo. Comece pela skill `forms-migrate`.

## Segurança

Veja [SECURITY.md](SECURITY.md). Não envie código de clientes para a demo pública.

## Licença

Apache 2.0. Projeto não afiliado à Oracle. Oracle, Forms e APEX são marcas da Oracle Corporation.
