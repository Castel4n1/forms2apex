# Roadmap

- [x] Fase 0: estrutura, CI, licença, exemplo
- [x] Fase 1: parser XML para IR, diagnóstico de riscos, máscara de segredos
- [x] Fase 2: regras determinísticas (POST-QUERY, PRE-INSERT, KEY-COMMIT, WHEN-VALIDATE-ITEM, ON-ERROR, WHEN-NEW-FORM-INSTANCE)
- [x] Fase 3 (parcial): script de import de páginas APEX 26.1 (Form, IG, IR de consulta, validações, processos, defaults), com export base opcional para herdar tema e offset. Falta: validar importando num APEX DEV, Dynamic Actions, validações de coluna do IG, form modal do modo IR
- [x] Regras: teclas KEY-*, abertura do form, PRE-INSERT/PRE-UPDATE com auditoria, WHEN-CREATE-RECORD, POST-QUERY com vários lookups, validação com condição genérica
- [x] Modo aplicação: pasta com forms, menu (.mmb) e bibliotecas (.pld) vira uma aplicação APEX (faixa de páginas por form, Navigation Menu, CALL_FORM/OPEN_FORM/NEW_FORM como redirect, :GLOBAL como application item, PLL como package), com PROXIMOS_PASSOS.md, DUVIDAS_DE_REGRA.md e MAPA_DA_APLICACAO.md. Falta: object libraries (.olb), property classes, Reports, autorização a partir de roles do Forms
- [x] Regras do Forms 4.5/5/6: exit_form com argumento, commit_form com aviso de sucesso
- [x] Fase 4 (parcial): IA com validação por schema e prompt caching; falta RAG vetorial e cache por hash
- [x] Fase 5 (parcial): interface com pré-orientação e migração ao vivo
- [x] Fase 6 (parcial): skills e CLI
- [ ] Fase 7: deploy da demo pública (OCI ARM + Cloudflare)
