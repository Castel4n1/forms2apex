---
name: apex-validate
description: Valida no banco DEV o resultado da migração Forms para APEX (compilação, objetos referenciados, roteiro de testes).
---

# Validar

Somente em schema DEV dedicado, com usuário sem privilégio de DBA. Peça confirmação antes de executar DDL.

1. Compile os packages e liste erros: `select * from user_errors`.
2. Confirme que tabelas e colunas usadas nas queries existem (`all_tab_columns`).
3. Percorra `ROTEIRO_TESTES.md` e marque o que passou.
4. Registre falhas como novas pendências em `PENDENCIAS.md`.
