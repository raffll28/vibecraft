# Migração para Rust (prova de conceito)

Objetivo: medir quanto o vibecraft melhora quando partes dele são reescritas
em Rust, trocando uma peça de cada vez e provando a cada passo, com a mesma
bateria de testes, que nada quebrou.

## Regras do jogo

1. **Os testes descrevem o comportamento, não a implementação.** Hook e servidor
   são testados como caixas-pretas (processo externo + stdin/HTTP/WebSocket).
   Os mesmos testes validam a versão atual e a versão em Rust:
   ```bash
   VIBECRAFT_HOOK_CMD=target/release/vibecraft-hook npm run test:hook
   VIBECRAFT_SERVER_CMD=target/release/vibecraft-server npm run test:server
   ```
2. **Casos de teste como dados.** Funções puras são testadas a partir de
   `tests/fixtures/*.json`; o Rust lê os mesmos arquivos nos próprios testes.
3. **Toda troca vem com números.** `npm run bench` antes e depois, com a mesma
   máquina e as mesmas cargas.
4. **Uma peça por vez, sempre funcionando.** Nenhuma fase deixa o projeto
   quebrado; a versão antiga só sai quando a nova passa em tudo.

## Comandos

| Comando | O que faz |
|---|---|
| `npm test` | Build + todos os testes (unit, hook, servidor) |
| `npm run test:unit` | Funções puras (`server/tmuxParsing.ts`, `server/validation.ts`) |
| `npm run test:hook` | Contrato do hook |
| `npm run test:server` | Contrato do servidor (HTTP + WebSocket + arquivo de eventos) |
| `npm run bench` | Benchmarks do hook e do servidor |

Os testes rodam com `HOME` temporário: nunca tocam o `~/.vibecraft/` real.

## Fase 0: estado atual (concluída)

- Bateria de testes: 123 testes (23 do hook, 40 do servidor, 60 de funções puras).
- Primeira modularização: parsers da saída do tmux e validações saíram do
  `server/index.ts` para `server/tmuxParsing.ts` e `server/validation.ts`.
- Bug encontrado pelos testes: payload acima de 1 MiB derrubava a conexão em vez
  de responder 413. Corrigido.

### Baseline (2026-10-29, Node 24.21, Linux)

**Hook** (por chamada, disparado pelo Node como o Claude Code faz;
cada uso de ferramenta chama o hook duas vezes, pre e post):

| Evento | p50 | p95 |
|---|---|---|
| PreToolUse | 13.6 ms | 14.5 ms |
| PostToolUse | 13.5 ms | 14.9 ms |
| Stop | 17.4 ms | 18.1 ms |
| UserPromptSubmit | 13.8 ms | 14.4 ms |
| *Piso: processo vazio (`sh` + `cat`)* | *3.9 ms* | *4.1 ms* |

Ou seja: ~10 ms de trabalho real do bash + jq por chamada, ~20 ms por uso de
ferramenta.

**Servidor** (1000 eventos no disco, 5 clientes WebSocket):

| Métrica | Valor |
|---|---|
| Startup até `/health` responder | 108 ms (p50) |
| `POST /event` sequencial | 0.39 ms (p50), 0.64 ms (p95) |
| `POST /event` com 16 concorrentes | 5340 req/s |
| Linha no `events.jsonl` → cliente WebSocket | **1000 ms** (p50) |
| Memória (RSS) | ~80 MiB |

O 1 s do arquivo vem do chokidar em modo polling (`interval: 1000`). Na prática o
hook também faz POST, então os eventos chegam em <1 ms; o arquivo é o caminho
de reserva.

## Fase 1: hook em Rust

O alvo com mais ganho e menos risco: é um processo curto, chamado de forma
síncrona em toda ferramenta, e hoje gasta ~10 ms em bash + jq.

- Crate `rust/vibecraft-hook`: binário único, sem dependências em runtime.
- Precisa passar nos 23 testes de `tests/hook/` com `VIBECRAFT_HOOK_CMD`.
- Ler só o final do transcript (seek a partir do fim, como `tail`).
- Notificar o servidor sem bloquear (hoje: `curl &`).
- `vibecraft setup` instala o binário quando existir e cai no script bash
  quando não existir.
- Meta: chegar perto do piso de ~4 ms.

## Fase 2: núcleo puro em Rust

- Crate `rust/vibecraft-core`: `tmuxParsing`, `validation`, processamento de
  eventos (duração pre→post, dedupe, histórico).
- Testes do Rust leem `tests/fixtures/*.json`.
- Antes de portar, extrair do `server/index.ts` o que ainda falta modularizar
  (estado das sessões, tiles, histórico), sempre com os testes verdes.

## Fase 3: servidor em Rust, rota por rota

Padrão *strangler*: o servidor Rust (tokio + axum) assume a porta e repassa ao
Node, numa porta interna, tudo que ainda não foi migrado. Cada rota migrada
passa nos testes de contrato antes de sair do Node.

Ordem sugerida:
1. `/event`, WebSocket (connect, history, broadcast) e leitura do
   `events.jsonl` com inotify, sem polling.
2. `/health`, `/config`, `/info`, `/stats`, `/prompt`, `/tiles`, arquivos estáticos.
3. Sessões e tmux (`/sessions/*`, permissões, tokens, git status).
4. Voz (Deepgram), por último.

Antes do passo 3: instalar o tmux e escrever os testes de contrato das sessões
(hoje não cobertos, porque dependem do tmux).

## Fase 4: desligar o Node

Quando todas as rotas estiverem no Rust: remover o proxy, comparar binário,
memória, startup e latência com o baseline da Fase 0.

## Fora do escopo (por enquanto)

**Frontend (Three.js).** O custo dele é GPU/WebGL, e o Rust/wasm não acelera a
renderização; trocar a cena inteira (por exemplo, por Bevy) é outro projeto.
Fica para depois das fases do backend, com medições próprias (FPS, tempo de
frame).

**Rust dentro do Node (napi-rs).** Dá para chamar funções Rust a partir do Node,
mas as funções puras do servidor rodam a cada 1–5 s sobre textos pequenos:
não há ganho mensurável, e o projeto passaria a depender de um addon nativo
por plataforma. Elas vão direto para o servidor Rust.
