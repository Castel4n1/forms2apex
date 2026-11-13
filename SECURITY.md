# Segurança

- Parser sem resolução de entidades e sem rede (bloqueia XXE), com limite de tamanho.
- Senhas e connect strings no código do form são mascaradas antes de qualquer envio à IA.
- Código do usuário é tratado como dado no prompt; a resposta da IA é validada por schema e nunca executada no servidor.
- Riscos bloqueantes (HOST, serviços externos) nunca são convertidos automaticamente.
- Demo pública: rate limit por IP, limites de tamanho, arquivos apagados ao fim de cada migração, sem conexão a banco.
- A chave da API fica só no servidor.

Encontrou uma vulnerabilidade? Não abra issue pública. Use "Report a vulnerability" na aba Security do GitHub.
