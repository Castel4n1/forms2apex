# forms2apex

Migrador open source de **Oracle Forms para Oracle APEX**, com interface que mostra a migração acontecendo, pré-orientação obrigatória e relatório de regras pendentes.

> Status: v0.2. Extração, diagnóstico, regras determinísticas, plano de páginas, SQL, relatórios e **script de import de páginas APEX 26.1** funcionam. O script segue o formato de um export real do APEX 26.1, mas ainda precisa ser validado em importação num ambiente DEV.

## Como funciona

1. **Pré-orientação**: você decide fidelidade visual, tratamento de multirregistro, program units, validações. "Não sei" aplica um padrão seguro e registra a dúvida.
2. **Extração**: o XML do `frmf2xml` vira uma IR enxuta (economia de tokens).
3. **Classificação**: riscos como `HOST`, `WEBUTIL`, `CALL_FORM`, Reports, serviços externos e DB links são detectados.
4. **Conversão**: regra determinística primeiro, IA (Claude) só se você habilitar e nenhuma regra cobrir.
5. **Geração**: blueprint das páginas, package com program units, LOVs, queries das regiões e `install/04_apex_paginas.sql` (Page Export do APEX 26.1: consulta em Interactive Report, formulário mestre, detalhe em Interactive Grid, validações, processos e defaults).
6. **Relatórios**: `PENDENCIAS.md`, `RASTREABILIDADE.md`, `DECISOES.md`, `ROTEIRO_TESTES.md`, `COMO_IMPORTAR.md` (passo a passo do import e ajustes manuais).

## Começando

Requisitos: Node 20+, Python 3.9+.

```bash
npm run setup   # cria .venv com lxml e instala as dependências Node
npm run migrate -- examples/produtos.xml --out output/produtos
npm run dev     # interface em http://localhost:3000
```

O parser usa, nesta ordem: `F2A_PYTHON`, o `.venv` do projeto, ou o `python3` do sistema (com `lxml` instalado via `pip install --user` também funciona).

### Gerar para uma aplicação APEX existente

Exporte a aplicação de destino (`apex export -applicationid 100` no SQLcl) e passe o arquivo:

```bash
npm run migrate -- meu_form.xml --out output/meu_form --apex-base f100.sql
```

O script herda workspace, aplicação, offset e os templates padrão do tema, e as páginas vão para uma faixa de IDs livre. O export base só é lido localmente; ele e a pasta `output/` nunca devem ir para o repositório. Sem `--apex-base`, o script exige `apex_application_install` (veja o `COMO_IMPORTAR.md` gerado).

Para usar IA: copie `.env.example` para `.env`, preencha `ANTHROPIC_API_KEY` e responda "Sim" em "Usar IA".

Gerar o XML do seu form (precisa do Forms Builder):

```bash
frmf2xml MEU_FORM.fmb
```

## Exemplos

- `examples/clientes.xml`: mestre-detalhe mínimo, com HOST bloqueante.
- `examples/produtos.xml`: auditoria, valores padrão, listas, radio, checkbox S/N, lookups com exception, validações, botões com `CALL_FORM`, `TEXT_IO` e cursor (as regras cobrem 14 de 16 triggers sem IA).

Ambos são fictícios. Código de cliente nunca entra em `examples/`.

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
