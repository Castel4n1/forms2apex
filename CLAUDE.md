# forms2apex: instruções para agentes (Maestri / Claude Code)

Projeto open source que migra Oracle Forms para Oracle APEX.

## Princípio
Script faz o determinístico, RAG fornece padrões, IA só no ambíguo. Nada some: o que não for convertido com segurança vira pendência em PENDENCIAS.md.

## Mapa
- `parser/forms_parser.py`: XML do frmf2xml para IR (JSON). Mascara segredos, bloqueia XXE.
- `packages/core/src/`: diagnose (riscos), rules (conversões determinísticas), ai (Claude), plan (páginas), generate (SQL), report (docs), pipeline.
- `packages/cli`: `npm run migrate -- <xml> --out <pasta> --profile <json>`.
- `apps/web`: interface Next.js com migração ao vivo (`npm run dev`).
- `skills/`: skills por fase. Comece por `skills/forms-migrate`.
- `rag/patterns/`: padrões Forms para APEX.

## Regras
- Leia a IR, não o XML bruto.
- Nova regra determinística vai em `rules.ts` com teste em `tests/`.
- Nunca commitar código de cliente, `.env` ou `output/`.
- Rodar `npm test` antes de qualquer commit.
