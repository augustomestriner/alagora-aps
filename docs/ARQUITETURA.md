# Arquitetura

## Componentes

| Componente | Papel |
| --- | --- |
| App (PWA em React) | Telas, mapa, GPS, fila offline no IndexedDB, conexão de tempo real |
| Nginx (`app`) | Serve a interface, encaminha `/api` e alterna entre as réplicas da API |
| API (`api`, 2 réplicas) | Autenticação, validação, permissões, concorrência, idempotência, SSE |
| Coletor (`coletor`) | Busca chuva no Open-Meteo, calcula o risco e publica eventos |
| PostgreSQL (`db`) | Dados, transações e canal de mensagens (LISTEN/NOTIFY) |

## Comunicação

- HTTP/JSON para comandos e consultas.
- Tempo real por Server-Sent Events em `GET /api/events` (eventos `report`, `risk` e `resync`). Se a conexão cai, o app reconecta com espera crescente.
- Quem grava (API ou coletor) chama `pg_notify` dentro da transação. O PostgreSQL só entrega a mensagem depois do COMMIT, então transação desfeita não gera evento. Todas as réplicas da API escutam o canal e repassam aos seus clientes.
- Depois da primeira carga, o app pede só o que mudou (`GET /api/reports?since=`). A consulta periódica fica como reserva.

## Consistência e falhas

- Cada ocorrência tem um UUID gerado no aparelho antes do envio. Repetir o mesmo POST não duplica nada (`ON CONFLICT DO NOTHING`).
- A mudança de situação compara a versão enviada com a atual (`SELECT ... FOR UPDATE`). Se outra pessoa alterou antes, a API devolve 409.
- Sem rede, o registro fica na fila do aparelho e é reenviado quando a conexão volta.
- O Nginx desvia para a outra réplica se uma não responder. Leituras são repetidas pelo proxy; escritas são reenviadas pelo próprio app, com o mesmo UUID.
- Na chamada ao Open-Meteo: tempo limite de 8 s, até 3 tentativas e disjuntor que abre após 3 ciclos com falha (pausa de 5 min). Sem a fonte, o coletor usa a simulação e avisa na tela.
- Advisory locks no PostgreSQL garantem que só um coletor rode o ciclo por vez.
- API (a cada 10 s) e coletor (a cada 15 s) gravam batimentos na tabela `services`, exibidos em `GET /api/status`.

## Risco de alagamento

O coletor roda a cada 120 s para seis áreas de Jundiaí. Considera a chuva de 1 h, 3 h e 24 h, a previsão das próximas 3 h e as ocorrências abertas perto da área, e classifica em sem risco, atenção, alto ou muito alto. Os limiares estão em `server/src/risco.js` e foram definidos pelo grupo, sem calibração com dados históricos. Na simulação, cada ciclo de 30 s avança uma hora de uma tempestade gravada.

## Limitações

Um único banco, sem replicação nem alta disponibilidade. O limite de tentativas de login fica na memória de cada réplica. Fora de `localhost` o app roda em HTTP, o que bloqueia GPS e instalação do PWA no celular. As fotos ficam no banco, o que serve para a demonstração mas não para grande volume.

## Rotas da API

| Rota | Acesso | Descrição |
| --- | --- | --- |
| GET `/api/health` | público | API e banco no ar |
| GET `/api/events` | público | fluxo SSE |
| GET `/api/reports` | público | ocorrências (`q`, `status`, `severity`, `mine`, `since`) |
| GET `/api/reports/:id` | público | ocorrência e histórico |
| GET `/api/reports/:id/photo` | público | foto |
| POST `/api/reports` | logado | cria ocorrência (201, ou 200 se repetida) |
| PATCH `/api/reports/:id/status` | autor/gestão | muda situação com controle de versão |
| GET `/api/rain`, `/api/rain/:id/history` | público | risco e chuva por área |
| GET `/api/nearby` | público | ocorrências num raio |
| GET `/api/status` | público | batimentos dos serviços |
| POST `/api/admin/simulation` | gestão | liga/desliga a simulação |
| POST `/api/auth/register`, `/login`, `/logout`; GET `/api/auth/me` | | contas e sessão |
