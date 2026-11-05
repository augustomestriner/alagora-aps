# Validação

Testado em 04 e 05/11/2026 no Windows 11 com Docker Desktop.

| Verificação | Resultado |
| --- | --- |
| 26 testes automáticos da API (`rodar-testes.bat`) | todos passaram |
| Build da interface e subida dos quatro serviços | ok |
| Coleta de chuva real no Open-Meteo para as 6 áreas | ok |
| Simulação de tempestade pela conta de gestão | risco subiu e desceu conforme os limiares; desligar voltou ao Open-Meteo |
| Interface no navegador (desktop e largura de celular) | ok |

## Medições de falha (`medir-falhas.bat`)

| Cenário | Resultado |
| --- | --- |
| Balanceamento | 40 requisições divididas 20/20 entre as réplicas |
| Escrita até o evento chegar em outro cliente | média de 37 ms (máx. 134 ms) |
| Queda de uma réplica com leituras contínuas | 0 erros em 107 requisições |
| Reconexão do tempo real após a queda | 0,6 s |
| Réplica religada recebendo acessos | 11 s |
| Coletor parado | marcado sem sinal em 40 s; o app continuou respondendo |
| Banco reiniciado | API de volta em 3,1 s |
| Comando de simulação até o evento no aparelho | 327 ms |

Detalhes em `RESULTADOS-FALHAS.md`.

## O que não foi testado

Não houve teste em celular físico, só no navegador do computador em largura de celular. A queda real da internet foi testada só nos testes automáticos (com fonte falsa fora do ar). Não foram feitos testes de carga.
