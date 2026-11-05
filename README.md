# Alagora

APS - 8º Semestre

## Como rodar

Precisa só do Docker Desktop rodando. No Windows, basta abrir `INICIAR.bat`. Ou, no terminal desta pasta:

```sh
docker compose up --build -d --wait
```

Depois abra http://localhost:8080. Na primeira vez o build leva alguns minutos.

| Perfil | E-mail | Senha |
| --- | --- | --- |
| Cidadão | demo@alagora.local | Demo@12345 |
| Gestão | admin@alagora.local | Admin@12345 |

As ocorrências de exemplo são fictícias e marcadas como `DEMO`. Para mudar a porta, copie `.env.example` para `.env` e altere `APP_PORT`. `docker compose down` para tudo e mantém os dados; `docker compose down -v` apaga o banco.

## Serviços

| Serviço | O que faz |
| --- | --- |
| `app` | Nginx: serve a interface (PWA em React) e divide os acessos entre as réplicas da API |
| `api` | Node.js/Express, duas réplicas: login, ocorrências, tempo real (SSE) |
| `coletor` | Node.js: busca a chuva no Open-Meteo e calcula o risco por bairro |
| `db` | PostgreSQL: dados e canal de mensagens entre os processos (LISTEN/NOTIFY) |

## Funcionalidades

- Cadastro e login; registro de ocorrência com local no mapa ou GPS, gravidade e foto.
- Lista e mapa com filtros; situação (Ativa, Em acompanhamento, Resolvida) com histórico.
- Tempo real: ocorrências e risco chegam aos aparelhos na hora, mesmo entre réplicas diferentes.
- Chuva e risco por bairro, com tempo limite, novas tentativas e disjuntor na chamada externa. Sem internet, usa uma simulação identificada.
- "Perto de você": ocorrências abertas num raio de 2 km e aviso quando o risco sobe.
- Fila offline: registros feitos sem rede ficam no aparelho e são enviados depois, sem duplicar.
- Controle de versão: duas pessoas alterando a mesma ocorrência não sobrescrevem uma à outra (HTTP 409).
- Tela de status com os serviços no ar e botão de simulação de tempestade (conta de gestão).

## Usar no celular

O app é um PWA: no Chrome ou Edge, em `localhost:8080`, dá para instalar pelo ícone na barra de endereço. No celular, na mesma rede Wi-Fi, abra `http://IP-DO-COMPUTADOR:8080` (o IP aparece no `ipconfig`). Por HTTP via IP o navegador bloqueia GPS e instalação, então o local é marcado tocando no mapa. Com cabo USB, dá para usar o port forwarding do `chrome://inspect` e abrir `localhost:8080` no celular.

## Testes

- `rodar-testes.bat`: roda os 26 testes da API dentro do Docker e sobe o sistema.
- `medir-falhas.bat`: para uma réplica da API, o coletor e o banco e mede o tempo de recuperação. Resultado em `docs/RESULTADOS-FALHAS.md`.

Sem Docker, dá para rodar em `server` com `npm ci && npm test`.

## Estrutura

```text
compose.yaml        serviços
server/src/         API, coletor, regras de risco, resiliência, banco
server/test/        testes automáticos
server/replay/      chuva simulada para demonstração
mobile/src/         interface React
mobile/nginx.conf   proxy e balanceamento
ferramentas/        medição de falhas
docs/               arquitetura, roteiro de testes e resultados
```
