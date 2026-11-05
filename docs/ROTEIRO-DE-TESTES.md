# Roteiro de testes

Suba o sistema (`INICIAR.bat`) e abra o app em duas janelas (uma pode ser anônima).

1. **Consulta:** veja os exemplos na lista e no mapa, use os filtros e abra os detalhes.
2. **Registro em tempo real:** entre como `demo@alagora.local`, registre uma ocorrência com local no mapa e, se quiser, uma foto. Ela aparece na outra janela sem recarregar.
3. **Situação e histórico:** mude a situação para "Em acompanhamento" e depois "Resolvida". A versão sobe e o histórico guarda cada mudança.
4. **Conflito:** abra a mesma ocorrência como demo numa janela e como admin na outra. Salve numa e depois na outra: a segunda recebe o aviso de conflito em vez de sobrescrever.
5. **Offline:** no DevTools, aba Network, marque Offline, registre uma ocorrência e veja-a pendente em "Meus registros". Volte a ficar online: ela é enviada uma única vez.
6. **Chuva e risco:** como admin, em "Status do sistema", clique em "Simular tempestade". Na tela "Chuva e risco", o risco dos bairros sobe a cada ~30 s nas duas janelas.
7. **Perto de você:** marque um ponto perto da Vila Arens. Aparecem as ocorrências num raio de 2 km e um aviso quando o risco da área sobe.
8. **Queda de réplica:** `docker stop alagora-api-1`. O app continua funcionando pela outra réplica e a tela de status mostra a parada. `docker start alagora-api-1` para voltar.
9. **Coletor parado:** `docker compose stop coletor`. O app continua; o coletor aparece sem sinal em ~40 s. `docker compose start coletor`.
10. **Persistência:** `docker compose down` e depois `INICIAR.bat`. Os dados continuam lá.

O `medir-falhas.bat` faz os testes de queda automaticamente e grava os tempos em `docs/RESULTADOS-FALHAS.md`.
