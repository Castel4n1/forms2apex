# forms2apex: instruções para agentes (Maestri / Claude Code)

Projeto open source que migra Oracle Forms para Oracle APEX.

## Princípio
Script faz o determinístico, RAG fornece padrões, IA só no ambíguo. Nada some: o que não for convertido com segurança vira pendência em PENDENCIAS.md.

## Mapa
- `parser/forms_parser.py`: XML do frmf2xml para IR (JSON). Mascara segredos, bloqueia XXE.
- `packages/core/src/`: diagnose (riscos), rules (conversões determinísticas), ai (Claude), plan (páginas), generate (SQL), apex (script de import APEX 26.1), report (docs), pipeline.
- `packages/cli`: `npm run migrate -- <xml> --out <pasta> --profile <json> [--apex-base fNNN.sql]`.
- `apps/web`: interface Next.js com migração ao vivo (`npm run dev`).
- `skills/`: skills por fase. Comece por `skills/forms-migrate`.
- `rag/patterns/`: padrões Forms para APEX.

## Regras
- Leia a IR, não o XML bruto.
- Nova regra determinística vai em `rules.ts` com teste em `tests/`.
- Nunca commitar código de cliente, `.env`, `output/` ou export de aplicação APEX de cliente.
- Parâmetros novos em `apex.ts` só com base em um export real do APEX (copie a chamada, não invente nome de parâmetro).
- Rodar `npm test` antes de qualquer commit.
