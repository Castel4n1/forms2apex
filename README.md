# forms2apex

Migrador open source de **Oracle Forms para Oracle APEX**, com interface que mostra a migração acontecendo, pré-orientação obrigatória e relatório de regras pendentes.

> Status: v0.3. Migra **um form ou uma aplicação Forms inteira** (forms, menu e bibliotecas) para **uma aplicação APEX 26.1**, com menu, navegação entre forms, application items e o roteiro do que falta. O script segue o formato de um export real do APEX 26.1, mas ainda precisa ser validado em importação num ambiente DEV.

## Como funciona

1. **Pré-orientação**: você decide fidelidade visual, tratamento de multirregistro, program units, validações. "Não sei" aplica um padrão seguro e registra a dúvida.
2. **Extração**: o XML do `frmf2xml` vira uma IR enxuta (economia de tokens).
3. **Classificação**: riscos como `HOST`, `WEBUTIL`, `CALL_FORM`, Reports, serviços externos e DB links são detectados.
4. **Conversão**: regra determinística primeiro, IA (Claude) só se você habilitar e nenhuma regra cobrir.
5. **Geração**: blueprint das páginas, package com program units, LOVs, queries das regiões e `install/04_apex_paginas.sql` (Page Export do APEX 26.1: consulta em Interactive Report, formulário mestre, detalhe em Interactive Grid, validações, processos e defaults).
6. **Relatórios**: `PENDENCIAS.md`, `RASTREABILIDADE.md`, `DECISOES.md`, `ROTEIRO_TESTES.md`, `COMO_IMPORTAR.md` (passo a passo do import e ajustes manuais).

## Aplicação inteira

Passe uma pasta (ou vários arquivos) em vez de um form:

```bash
npm run migrate -- examples/app_vendas --out output/vendas [--apex-base f100.sql]
```

| Entra (Forms) | Sai (APEX) |
| --- | --- |
| Todos os forms (`.xml` do frmf2xml) | Uma aplicação: cada form ganha sua faixa de páginas (100, 200...) |
| Menu (`.mmb` em `.xml` pelo frmf2xml) | Navigation Menu com a mesma árvore |
| `CALL_FORM`, `OPEN_FORM`, `NEW_FORM` | Botões "Redirect to Page" para a página do form chamado |
| `:GLOBAL.X` | Application item `GLOBAL_X`, passado na URL entre páginas |
| Bibliotecas (`.pll` em texto: `frmcmp module=LIB.pll module_type=library script=yes` gera o `.pld`) | Package `LIB_PKG`; chamadas nos forms ficam `LIB_PKG.ROTINA` |

Com `--apex-base`, o resultado é o **export completo da aplicação** (`install/03_fNNN_aplicacao.sql`): o tema, o menu e os itens da aplicação de destino, mais as páginas dos forms. Sem base, é um script de componentes para importar numa aplicação existente.

Documentos para fechar as arestas:

- `PROXIMOS_PASSOS.md`: onde a migração parou (por form), ordem de instalação, ajustes manuais, testes e checklist antes de publicar.
- `DUVIDAS_DE_REGRA.md`: cada ponto que a ferramenta não decidiu vira uma pergunta para quem conhece o negócio, com motivo, sugestão, código original e espaço para a resposta. Junta pendências dos forms, perguntas da IA, forms chamados que não vieram e itens de menu sem destino.
- `MAPA_DA_APLICACAO.md`: forms e páginas, árvore do menu, navegação entre forms, application items (onde são preenchidos e lidos) e bibliotecas.
- `install/instalar_tudo.sql`: bibliotecas, packages e aplicação na ordem certa.

Na interface web, selecione vários arquivos (ou "Usar aplicação de exemplo") e baixe tudo num `.zip`.

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
- `examples/produtos.xml`: auditoria, valores padrão, listas, radio, checkbox S/N, lookups com exception, validações, botões com `CALL_FORM`, `TEXT_IO` e cursor (as regras cobrem 15 de 16 triggers sem IA).
- `examples/forms5_departamentos.xml`: vícios do Forms 5 (`POST-CHANGE`, `NAME_IN`, `RUN_PRODUCT`, `COMMIT_FORM` com aviso).
- `examples/app_vendas/`: aplicação completa com 5 forms que se chamam, menu e biblioteca (44 de 50 triggers por regra; 49 com IA).

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
