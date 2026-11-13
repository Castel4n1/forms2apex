---
trigger: POST-QUERY
builtins: [select into]
apex: region_query
---
# POST-QUERY que busca descrição

Forms:
```sql
select descricao into :cli.desc_cidade from cidades where id = :cli.cidade_id;
```

APEX: subconsulta escalar na query da região (sem trigger).
```sql
(select descricao from cidades x where x.id = t.cidade_id) as desc_cidade
```
Alternativa: Popup LOV no item CIDADE_ID exibindo a descrição.
