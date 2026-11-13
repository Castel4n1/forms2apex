---
name: apex-generate
description: Importa no Oracle APEX as páginas geradas pelo forms2apex (install/04_apex_paginas.sql) e conclui os ajustes manuais listados em COMO_IMPORTAR.md.
---

# Gerar APEX

Entrada: `install/*.sql`, `COMO_IMPORTAR.md`, `conversoes.json`, `blueprint.json`.

1. Se houver aplicação de destino, gere de novo com `--apex-base fNNN.sql` (export dela) para herdar tema, templates e offset. Sem isso, o script exige `apex_application_install`.
2. Somente em DEV: compile `install/01_*_pkg.sql` (units com pendência ficam comentadas).
3. Importe `install/04_apex_paginas.sql` (SQLcl ou App Builder > Import). Se um ID de página já existir, o import para e faz rollback: não force.
4. Faça cada item de "Ajustes manuais" do `COMO_IMPORTAR.md` (Dynamic Actions, validações de coluna do IG, botões sem ação, ordem display/return das LOVs).
5. Siga `layoutNotes` do blueprint para a fidelidade visual escolhida.
6. Exporte a aplicação (SQLcl: `apex export -applicationid <ID>`) para versionar.

Se o import falhar, registre a mensagem do erro e o trecho do script como pendência e avise: o gerador foi escrito a partir de um export real do 26.1, mas cada versão do APEX pode mudar parâmetros.
