---
name: trigger-convert
description: Converte um trigger ou program unit pendente do Oracle Forms em componente APEX (validation, computation, process, dynamic action), consultando os padrões em rag/patterns.
---

# Converter trigger pendente

Ordem obrigatória:
1. Procure um padrão em `rag/patterns/` (grep pelo nome do trigger e pelos built-ins usados).
2. Se houver padrão, aplique-o. Se não, converta e registre o novo padrão sugerido.
3. Troque `:BLOCO.ITEM` pelo item APEX do mapa em `RASTREABILIDADE.md`.
4. Atualize a pendência em `PENDENCIAS.md`: status "Em análise" com a proposta, nunca "Resolvido" sem o usuário aprovar.

Nunca converta automaticamente: HOST, UTL_HTTP, serviços externos, DB links, commit explícito. Proponha e pergunte.
