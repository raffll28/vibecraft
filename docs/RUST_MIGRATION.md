# Migração para Rust (prova de conceito)

Objetivo: medir quanto o vibecraft melhora quando partes dele são reescritas
em Rust, trocando uma peça de cada vez e provando a cada passo, com a mesma
bateria de testes, que nada quebrou.

> **Este documento é o histórico.** As fases 0–4 citam código que já foi
> removido na fase 5 (o servidor Node em `server/`, o hook em bash, o CLI
> `bin/cli.js`, o fuzzing diferencial TS × Rust). Para o estado atual, veja o
> [README](../README.md) e o [CLAUDE.md](../CLAUDE.md).

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

## Comandos (estado atual)

| Comando | O que faz |
|---|---|
| `npm test` | Build + `cargo test` + todos os testes de contrato e unitários |
| `npm run test:hook` | Contrato do hook (contra o binário Rust) |
| `npm run test:server` | Contrato do servidor (HTTP + WebSocket + arquivo de eventos) |
| `npm run test:unit` | Regra do semáforo das zonas |
| `npm run test:rust` | Testes dos crates Rust (`cargo test`) |
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
| PreToolUse | 13.5 ms | 14.1 ms |
| PostToolUse | 11.9 ms | 12.4 ms |
| Stop | 14.9 ms | 15.5 ms |
| UserPromptSubmit | 11.3 ms | 11.9 ms |
| *Referência: `sh` + `cat` (processo quase vazio)* | *3.9 ms* | *4.2 ms* |

Ou seja: ~11–15 ms por chamada, ~25 ms por uso de ferramenta.

> A primeira medição (13.6 / 13.5 / 17.4 / 13.8 ms) estava inflada: o
> benchmark relia o arquivo de eventos inteiro a cada execução, e ele crescia
> durante a medição. Corrigido em `bench/hook.bench.ts`; os números acima são
> da versão corrigida.

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

## Fase 1: hook em Rust (concluída)

Crate `rust/vibecraft-hook`: substitui bash + jq + curl por um binário de
400 KiB que só depende da libc. Dependências de compilação: `serde_json`
(e 4 crates pequenas que ele puxa: `serde_core`, `itoa`, `memchr`, `zmij`).

```bash
cd rust && cargo build --release   # gera rust/target/release/vibecraft-hook
npx vibecraft setup                # instala o binário se existir, senão o .sh
```

**Validação**
- Os 23 testes de contrato de `tests/hook/` passam com
  `VIBECRAFT_HOOK_CMD=rust/target/release/vibecraft-hook`.
- 8 testes do próprio crate (`cargo test`): `tail`, truncamento por caractere,
  semântica de erro do jq.
- Teste diferencial com dados reais: 47 transcripts de sessões do Claude Code ×
  3 tipos de evento, bash e Rust lado a lado: 141 comparações, 0 diferenças.

**Resultado** (p50, 300 execuções por caso)

| Evento | bash + jq | Rust | Ganho |
|---|---|---|---|
| PreToolUse | 13.5 ms | 2.0 ms | 6.7× |
| PostToolUse | 11.9 ms | 2.0 ms | 5.8× |
| Stop | 14.9 ms | 2.8 ms | 5.3× |
| UserPromptSubmit | 11.3 ms | 2.0 ms | 5.6× |

Com notificação a um servidor de verdade (`BENCH_NOTIFY_URL`): bash
11.2–15.1 ms, Rust 2.2–3.0 ms. O Rust espera a resposta do servidor (o bash
fazia `curl &`), e isso custa ~0.2 ms no loopback. Com o servidor parado, a
conexão é recusada na hora; com ele travado, o custo máximo é de 250 ms
(conexão) + 500 ms (resposta).

Por uso de ferramenta (pre + post): de ~25 ms para ~4 ms.

**Diferenças em relação ao bash (intencionais)**
- Entrada vazia não grava mais uma linha em branco no `events.jsonl`.
- O caminho do transcript é lido do JSON já decodificado (o bash usava uma
  regex no texto bruto, que falharia com caracteres escapados).
- A ordem das chaves no JSON gerado é alfabética (o `serde_json` sem
  `preserve_order`). Nenhum consumidor depende da ordem.

**Limitação que já existia (bash e Rust iguais):** o `assistantText` do
`pre_tool_use` sai vazio na prática. O Claude Code dispara o PreToolUse antes
de gravar no transcript o texto que precede a ferramenta, então não há texto
depois da última mensagem `user` (o `tool_result` anterior). Nos 138 eventos
do bash numa sessão real, todos vieram vazios.

## Fase 2: núcleo puro em Rust (concluída)

**2a. Extração no TypeScript.** O log de eventos (dedupe, duração pre→post,
limite de memória, histórico) saiu do `server/index.ts` para
`server/eventStore.ts`, e a quebra de linhas do `events.jsonl` virou
`LineSplitter`. Dois bugs apareceram na extração, cada um com um teste de
contrato que falhava antes da correção:
- eventos carregados no startup não eram marcados como vistos, e um POST
  posterior do mesmo evento contava duas vezes;
- os bytes eram decodificados antes de quebrar as linhas, e uma leitura que
  cortasse um caractere multibyte ao meio corrompia o evento.

**2b. Crate `rust/vibecraft-core`.** `event_store` (com `LineSplitter`),
`tmux_parsing` e `validation`. Só depende de `serde_json`: os regex do
TypeScript foram reescritos à mão, seguindo a semântica do JavaScript
(`\s` do JS ≠ `is_whitespace`, `/i` só dobra ASCII, `.` não casa `\r`, ordem
das alternativas), documentada em `src/js.rs`.

**Validação**
- Os testes do crate leem os mesmos `tests/fixtures/*.json` do TypeScript
  (9 grupos), mais 5 testes de casos de borda.
- Fuzzing diferencial (`tests/differential/core.diff.ts` + o oráculo
  `examples/oracle.rs`): entradas aleatórias com caracteres perigosos e
  prompts/contadores bem formados com mutações (linhas removidas, duplicadas,
  trocadas, espaços Unicode, `\r`, `\u2028`). Mais de 700 mil comparações em
  vários seeds, 0 diferenças; cerca de 40% dos prompts e 35% dos contadores
  gerados são detectados, então os caminhos difíceis são exercitados.
- Diferença intencional: `is_origin_allowed` rejeita formas exóticas que o
  `new URL` do Node aceita (`http://user@localhost`, `http:/localhost`,
  `http://127.1`). Mais estrito é a direção segura numa allowlist, e
  navegadores sempre mandam a origem canônica. O fuzzer aceita só essa
  direção de diferença.

**Resultado** (`npm run bench:core`, capturas de ~100 linhas, metade com prompt)

| Função | TypeScript | Rust | Ganho |
|---|---|---|---|
| `parseTokensFromOutput` | 4.7 µs | 0.30 µs | 16× |
| `detectPermissionPrompt` | 3.9 µs | 1.1 µs | 3.4× |

O detector chegou a 3.4× com duas otimizações guiadas por medição: busca
case-insensitive sem alocação, e uma saída rápida (um memchr por `?` nas
últimas 30 linhas, já que toda pergunta termina em `?`), que levou as
capturas sem prompt de 1.2 µs para 0.36 µs. Parei aqui: essas funções rodam
a cada 1–5 s, então mesmo a versão TypeScript custa microssegundos por
segundo de uso. O ganho real virá no servidor (Fase 3).

## Fase 3: servidor em Rust

**Mudança de estratégia.** O plano original era um *strangler*: o Rust assume a
porta e repassa ao Node as rotas não migradas. Não funciona bem aqui porque o
estado é compartilhado: eventos, sessões e tiles chegam por HTTP e saem por
broadcast no WebSocket. Um `POST /tiles` atendido pelo Node faria broadcast
para os clientes do Node, mas os navegadores estariam conectados no Rust;
dividir isso exigiria sincronizar estado entre dois processos.

Em vez disso, o servidor Rust (`rust/vibecraft-server`) cresce
funcionalidade por funcionalidade, e cada passo roda a bateria de contrato
inteira (`npm run test:server:native`). O uso diário continua no Node até o
Rust passar em tudo; só então a troca.

**Dependências:** só `serde_json` e o `vibecraft-core`. HTTP/1.1, WebSocket
(handshake com SHA-1, frames, fragmentação, ping/pong) e inotify (FFI direta
com a libc) foram escritos à mão. Uma thread por conexão (são poucos
clientes locais), estado atrás de um mutex, e uma thread escritora por
cliente WebSocket com fila limitada.

### 3a. Núcleo do servidor (concluído)

Eventos (`/event`, arquivo com inotify, dedupe, durações), WebSocket
(origem, saudação, histórico, `get_history`, broadcast), `/health`,
`/config`, `/info`, `/stats`, `/prompt` (incluindo envio ao tmux), `/tiles`,
`/sessions` e `/projects` (leitura), CORS e arquivos estáticos.

**Validação**
- Os 45 testes de contrato do servidor passam no Node e no Rust.
- Escrever o contrato para o Rust revelou dois bugs no Node, corrigidos com
  testes: `GET` de um diretório (ex.: `/assets`) derrubava o servidor
  inteiro, e `POST /event` aceitava JSON que não é objeto (`5`, `"x"`) e o
  repassava aos navegadores.
- Teste com navegador real (Chromium) contra o Rust, com uma cópia dos dados
  reais: histórico, zonas, feed e evento ao vivo pelo arquivo funcionando.

**Resultado** (`npm run bench`, 1000 eventos no disco)

| Métrica | Node | Rust | Ganho |
|---|---|---|---|
| Startup até `/health` | 97.5 ms | 9.8 ms | 10× |
| `POST /event`, 16 conexões keep-alive | 56 mil req/s | 134 mil req/s | 2.4× |
| Linha no `events.jsonl` → navegador (p50 / máx) | 1000 / 1005 ms | 1.2 / 1.35 ms | ~830× |
| Memória (startup / sob carga / fim) | 80 / 153 / 88 MiB | 7.3 / 9.1 / 11 MiB | 8–17× |
| Para rodar | Node 24 + `node_modules` (141 MiB, incluindo as ferramentas de build do frontend) | binário de 683 KiB, só libc | |

O throughput é medido com um gerador de carga em Rust
(`examples/load.rs`): com o `fetch` do Node como cliente, os dois servidores
empatavam em ~5 mil req/s, o limite era o cliente.

**Diferenças intencionais**
- Fila por cliente WebSocket limitada a 4096 mensagens: um cliente que não
  acompanha é desconectado (o navegador reconecta e recebe o histórico). O
  Node acumula sem limite: no benchmark, chegou a 153 MiB com clientes
  parados.
- `/health` reporta `version: "unknown"`, como o Node compilado. Uma versão
  real ligaria a checagem de atualização contra o repositório original.

### 3b. Sessões e tmux (concluído)

Sessões gerenciadas (criar no tmux, renomear, apagar, prompt, cancel,
restart, link), status a partir dos eventos, polling de prompts de
permissão e tokens (e o aceite automático do aviso de bypass), health check,
timeout de "working", git status, autocomplete e remoção de projetos,
`permission_response` pelo WebSocket.

**Testes primeiro.** `tests/server/sessions.test.ts` (21 testes) foi escrito e
validado contra o Node antes do Rust existir. Cada teste usa um servidor tmux
próprio (`TMUX_TMPDIR` no HOME temporário, sem a variável `TMUX`, que faria
os comandos irem para o tmux do usuário) e um `claude` falso
(`tests/fixtures/fake-claude.mjs`) primeiro no PATH: ele imprime prompts de
permissão, o aviso de bypass e contadores de tokens sob comando, e registra
o que recebe (argumentos, texto, Ctrl+C, a tecla escolhida no prompt).

Os testes acharam três bugs no Node, corrigidos:
- autocomplete de `~/...` listava a partir da raiz do disco
  (`resolve(home, '/code/')` descarta o home);
- o git status contava a mudança não staged do primeiro arquivo como staged
  (`trim()` apagava o espaço inicial de `" M arquivo"`, que é a coluna staged);
- `DELETE /projects/<caminho malformado>` derrubava o servidor
  (`decodeURIComponent` fora de qualquer `try`).

**No Rust:** os 21 testes passaram de primeira, e os 66 testes de contrato do
servidor (45 + 21) passam nos dois. tmux e git nunca rodam com o lock do
estado preso: lê-se o necessário, solta-se o lock, roda o comando, e trava de
novo para aplicar o resultado.

## Fase 4: a troca (concluída)

`vibecraft` (`bin/cli.js`) inicia o servidor Rust quando ele foi compilado,
senão o Node compilado, senão o tsx. `VIBECRAFT_SERVER=node` força o Node.
Com o hook da Fase 1, o caminho inteiro do dia a dia é Rust: hook →
`events.jsonl`/POST → servidor → navegador.

**Voz e sons removidos.** Só a parte gráfica animada é usada, então saíram a
entrada por voz (Deepgram) e os efeitos sonoros (Tone.js, áudio espacial):
`src/audio/`, `VoiceControl`, `soundHandlers`, os controles de volume e
áudio espacial nas configurações, o botão de microfone, o atalho de voz, e
o código de voz dos dois servidores (`voiceEnabled` saiu do `/health`).
Isso também evitou portar a voz para Rust, que exigiria TLS (`rustls` e
dezenas de crates).

| | Antes | Depois |
|---|---|---|
| Dependências de runtime (npm) | 5 | 3 (`chokidar`, `three`, `ws`) |
| `node_modules` | 141 MiB | 107 MiB |
| Bundle do frontend | 998 KB | 734 KB |

## Fase 5: só monitor, sem Node em runtime (concluída)

O uso real é monitorar as sessões abertas no terminal, então tudo que existia
para criar e conduzir sessões pelo navegador saiu:

- **Frontend:** sem painel lateral (feed, lista de sessões, prompt), sem
  criação de zonas, sem os modais de sessão, pergunta, permissão, info e
  comando. Cada zona leva o nome da pasta (`nome (2)` para repetidas) e um
  semáforo: verde livre, amarelo ocupado, vermelho precisa de você
  (`src/events/zoneStatus.ts`). `main.ts` foi de 2897 para 1025 linhas.
- **Servidor Rust:** sem sessões gerenciadas, tmux, git status, projetos,
  `/prompt`, `/stats` e `/info`. Ficaram eventos, WebSocket, rótulos do
  chão, `/config` e `/health`. Os clientes só recebem. Binário: 683 → 573 KiB.
- **Node só como ferramenta de desenvolvimento:** removidos o servidor Node,
  o CLI `bin/cli.js` (o `setup`/`uninstall` agora é
  `vibecraft-server setup`, que preserva a ordem das chaves do
  `settings.json` e registra também o `PreCompact`), o hook em bash e os
  scripts de instalação. Os testes de contrato rodam contra os binários
  Rust; os fixtures JSON continuam nos testes do Rust.
- **Analytics:** removido o script do Amplitude, que mandava cliques e
  formulários para a conta do projeto original.

| | Antes da fase 5 | Depois |
|---|---|---|
| Dependências de runtime (npm) | 3 | 0 (`three` vai no bundle) |
| `node_modules` (só desenvolvimento) | 107 MiB | 82 MiB |
| Bundle do frontend | 734 KB | 656 KB |
| Servidor Rust | 683 KiB | 573 KiB |

## Fora do escopo (por enquanto)

**Frontend (Three.js).** O custo dele é GPU/WebGL, e o Rust/wasm não acelera a
renderização; trocar a cena inteira (por exemplo, por Bevy) é outro projeto.
Fica para depois das fases do backend, com medições próprias (FPS, tempo de
frame).

**Rust dentro do Node (napi-rs).** Dá para chamar funções Rust a partir do Node,
mas as funções puras do servidor rodam a cada 1–5 s sobre textos pequenos:
não há ganho mensurável, e o projeto passaria a depender de um addon nativo
por plataforma. Elas vão direto para o servidor Rust.
