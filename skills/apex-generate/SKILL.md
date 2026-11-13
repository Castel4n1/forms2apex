---
name: apex-generate
description: Monta a aplicação Oracle APEX a partir do blueprint.json e dos scripts em install/ gerados pelo forms2apex.
---

# Gerar APEX

Entrada: `blueprint.json`, `install/*.sql`, `conversoes.json`.

1. Compile `install/01_*_pkg.sql` no schema DEV (só depois de revisar as pendências de program units).
2. Crie as LOVs de `install/02_lovs.sql` em Shared Components.
3. Para cada página do blueprint, crie a página com o tipo de região indicado (`form`, `interactive_grid`, `interactive_report_modal`) usando a query de `install/03_queries_regioes.sql`.
4. Aplique cada item de `conversoes.json`: validações, computações, PK por sequence.
5. Siga `layoutNotes` do blueprint para a fidelidade visual escolhida.
6. Exporte a aplicação (SQLcl: `apex export -applicationid <ID>`) para versionar.

Status: a geração automática do script de import APEX é a fase 3 do roadmap. Até lá, esta skill guia a criação assistida.
