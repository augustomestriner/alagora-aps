# Resultados das medições de falhas

Gerado por `medir-falhas.bat` em 05/11/2026. Os tempos foram medidos por um cliente que acessa o sistema pelo Nginx, como um aparelho faria.

## 1. Balanceamento entre réplicas da API

2 réplica(s) em execução. 40 requisições `GET /api/health` seguidas pelo Nginx:

| Réplica que respondeu | Requisições |
| --- | --- |
| api@e598e94b6c0f | 20 |
| api@7776c7d31e8a | 20 |

## 2. Latência do tempo real

Tempo entre a escrita e a chegada do evento a outro cliente conectado.

| Medida | Resultado |
| --- | --- |
| Criação de ocorrência → evento | 516 ms |
| Mudança de situação → evento (10 alterações) | 37 ms (mín. 18, p95 134, máx. 134; n=10) |
| Alterações gravadas por uma réplica e entregues pelo SSE de outra | 2 de 10 |

## 3. Queda de uma réplica da API

Réplica parada: `alagora-api-1` (a que atendia o tempo real do cliente de teste). Carga contínua de `GET /api/reports` a cada 200 ms durante a queda.

| Medida | Resultado |
| --- | --- |
| Requisições durante o teste | 107 |
| Requisições com erro | 0 |
| Tempo de resposta durante a queda | 44 ms (mín. 5, p95 65, máx. 3092; n=107) |
| Tempo até o tempo real reconectar em outra réplica | 0,6 s após o comando de parada (agora em api@e598e94b6c0f) |
| Tempo até a tela de status mostrar a réplica parada como sem sinal | 23,0 s (batimento a cada 10 s; limite de 2,5 intervalos + 5 s) |
| Evento entregue com a réplica fora | 36 ms |
| Tempo até a réplica religada ficar saudável e voltar a receber acessos pelo Nginx | 11,0 s após o comando de início |

## 4. Serviço coletor parado

| Medida | Resultado |
| --- | --- |
| Tempo até o status marcar o coletor como sem sinal | 40,2 s (batimento a cada 15 s; limite de 2,5 intervalos + 5 s) |
| API com o coletor parado | `/api/rain` HTTP 200 (último risco calculado), `/api/reports` HTTP 200 |
| Tempo até o coletor religado voltar a saudável | 1,0 s |

## 5. Banco de dados reiniciado

| Medida | Resultado |
| --- | --- |
| Requisições `/api/health` com erro durante o reinício | 1 de 4 (janela de 0,0 s) |
| Tempo até a API voltar a responder com o banco | 3,1 s após o comando de reinício |
| Assinatura do canal (LISTEN) restabelecida e `resync` enviado aos aparelhos | sim, 3,6 s após o comando de reinício |
| Evento em tempo real após o reinício | 88 ms |

## 6. Comando assíncrono para o coletor

| Medida | Resultado |
| --- | --- |
| `POST /api/admin/simulation` → coletor recebe pelo canal, recalcula e o evento `risk` chega ao aparelho | 327 ms (resposta HTTP 202) |

## Observações

- Requisições de leitura que encontram uma réplica fora são repetidas pelo Nginx na outra réplica (`proxy_next_upstream`); escritas (POST) não são repetidas pelo proxy, pois o próprio app reenvia com o mesmo identificador (idempotência).
- O registro “Medição automática (pode ignorar)” foi criado e encerrado pela ferramenta.
