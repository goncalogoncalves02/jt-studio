# Blog editorial — pausa e ponto de retoma (execução de 2026-10-11)

> **Retoma confirmada em 2026-10-12:** o utilizador pediu a continuação. HEAD e
> alterações locais da etapa 5 foram preservados; esta continua por aceitar.
> Os ficheiros temporários de `/tmp` desapareceram após o reinício da máquina.
> A baseline protegida foi recuperada do inventário durável exato (7 containers,
> 236 volumes), sem criar uma baseline a partir do estado atual. O mesmo Storage
> foi arrancado após preflight e revisão independente; o initializer, volume,
> dados, estado e locks foram preservados. A verificação operacional original
> `verify-existing` passou com Node 26.8.1; os gates da aplicação exigem Node 24.21.0.
> Gemini voltou a constar no catálogo, mas a execução headless recusou a permissão
> de comandos e não produziu trabalho. A mesma correção foi entregue ao fallback
> GPT Luna 6 High. Evidência atual no ledger ignorado
> `.superpowers/sdd/2026-10-11-blog-editorial/coordinator-resume-20261012.md`.
> As secções abaixo descrevem o checkpoint histórico da pausa; o diff e o ledger
> atual prevalecem. Sem aceitação da etapa 5 nem início da etapa 6.

Pausa registada na passagem para 2026-10-12 (Europe/Lisbon).

O utilizador pediu uma pausa por limite de utilização. Não continuar implementação,
testes ou agentes até pedir a retoma. Este documento é o ponto de entrada do estado
atual; as entradas cronológicas anteriores não representam trabalho ainda pendente.

## Estado confirmado na pausa

- Repositório principal: `/home/goncalo/projects/jt-studio`, `main` em
  `5749be91186f79587ed5d3ee5a0688f75a4a6564`. Tem `AGENTS.md` local ainda não
  versionado. Push para main publica automaticamente no Netlify.
- Implementação: `/home/goncalo/.codex/worktrees/e094/jt-studio`, branch
  `feature/blog-editorial`, HEAD `3422117a08389370eca89b31980f55d67740abbe`.
- Worktree documental anterior: `/home/goncalo/.codex/worktrees/8d4a/jt-studio`,
  `docs/blog-editorial-design`, HEAD `8307839`; não é a árvore de implementação.
- Etapas 1–4 aceites localmente. Base aceite da etapa 4:
  `6124e2267003ba401cbf5152d774071ab342b7cb`.
- A etapa 5 tem commit local assinado e DCO, mas **não está aceite**. A revisão
  independente pediu cinco correções; existem alterações locais por concluir.
- Etapas 6–10 não iniciadas. O plano completo de execução local foi aprovado;
  a pausa suspende essa execução até ao pedido de retoma.
- Sem push, PR, merge, deploy ou alterações cloud. Não existe prova de CI remoto,
  Lambda/Netlify em produção ou aceitação num iPhone físico.

Fontes: [especificação aprovada](blog-spec.md),
[plano aprovado](superpowers/plans/2026-10-11-blog-editorial.md),
[runbook de desenvolvimento e verificação](blog-development.md).

## Trabalho local a preservar

Na pausa, `git status --short --untracked-files=all` identificou:

```text
 M package-lock.json
 M scripts/build-media-harness.mjs
 M src/admin/MediaPicker.jsx
 M tests/e2e/blog-media.mjs
 M tests/unit/media-api.test.mjs
?? tests/browser/media-picker-harness/index.html
?? tests/browser/media-picker-harness/main.jsx
?? tests/browser/media-picker.spec.js
```

O diff acompanhado tinha 288 inserções e 30 remoções em cinco ficheiros.
Há código para as cinco correções, incluindo um harness React/Playwright real
com transportes simulados. Isso não estabelece que as correções estejam
concluídas, que os novos testes tenham passado ou que o lock/instalação estejam
consistentes. Não executar reset, checkout de ficheiros, limpeza ou reinstalação
para substituir este trabalho. Os ficheiros novos também devem ser revistos.

O implementador `/root/blog_task5` (GPT Luna 6 High) foi interrompido. Foram
identificados e enviados SIGTERM apenas aos processos Node próprios de testes
unitários PID 401300 e 401233, ambos na worktree de implementação, executando
`tests/unit/supabase-local.test.mjs` e/ou `tests/unit/docker-loopback-proxy.test.mjs`.
O resultado desses processos interrompidos não é um gate concluído. Docker Desktop,
containers e volumes foram preservados. Não iniciar novos testes durante a pausa.

## Próxima ação: concluir a revisão da etapa 5

Ler primeiro o relatório independente completo
`/tmp/jt-studio-task5-final-independent-review-3422117.md` e o brief de correção
`/tmp/jt-studio-task5-review-corrections-20261011.md`. Os cinco pedidos foram aceites
pelo coordenador dentro do âmbito da etapa 5, sem nova dependência ou arquitetura:

1. **R1 P1 — estado privado após mudança de sessão.** Limpar preview, media,
   estado e progresso em logout/sessão sucessora; abortar a operação antiga.
   Capturar o epoch original em todos os pedidos e proteger callbacks/finally
   pelo epoch e identidade do controller. Provar que uma resposta antiga não
   apaga nem reconstitui o estado de uma operação nova.
2. **R2 P2 — cancelar e progresso.** Botão acessível para cancelar processamento
   e upload; progresso em português; cancelamento não conclui media nem altera
   o artigo. Distinguir a prova de componente com mocks da prova real do servidor.
3. **R3 P2 — lockfile.** Restaurar as raízes nanoid 3.3.12 e source-map-js 1.2.1,
   preservando resoluções nested válidas para PostCSS 8.5.29 de Vue, que requer
   nanoid ^3.3.19 e source-map-js ^1.2.2. Preservar Sharp 0.35.5 e a sua closure.
   Verificar o lock, instalação e alterações de ordenação sem upgrades alheios.
4. **R4 P2 — Storage com JWT ainda válido.** Prova HTTP direta de GET/POST
   privado com JWT do owner cuja assinatura/expiração ainda são válidas, mas
   apenas a autoridade da aplicação foi revogada; repetir num contexto distinto
   com apenas a sessão do provider expirada. Controlos positivos antes, autoridade
   oposta ainda ativa, negação específica e ausência de novas escritas depois.
   Não guardar tokens no browser, ficheiros ou logs. Preservar objetos/histórico;
   invalidar apenas a autoridade dos fixtures próprios no finally.
5. **R5 P2 — descodificação completa.** Teste WebP de 26 bytes com RIFF/VP8L
   estruturalmente válido, metadata 40×20 legível e pixels inválidos. O teste deve
   rejeitar e falhar causalmente quando só a descodificação completa é retirada
   numa cópia transitória, preservando o servidor original.

Após retoma: reconciliar HEAD/diff/ledger/processos/autoridade dos fixtures;
continuar a mesma etapa com um implementador, executar os gates afetados,
criar commit local assinado+DCO filho de `3422117`, congelar evidência e fazer
revisão independente das correções. Só então aceitar a etapa 5 e passar à 6.
Gemini Flash 3.8 High via `agy` estava indisponível para execução headless;
o fallback Luna 6 High foi estabelecido. Confirmar capacidades atuais sem trocar
modelos por iniciativa própria. Sol 6.1 High coordena e revê; Astra Medium é
reservado à escalation prevista no AGENTS.md. Não houve falha fundamental da
abordagem nem re-plan consumido por estes pedidos de revisão.

## Evidência já concluída antes das correções

O commit `3422117` passou build, build de fixture, 121 unit tests (zero falhas/skips),
lint focado, syntax/diff-check, gate SQL Storage, bloqueios PostgreSQL reais com
`pg_blocking_pids` e expiração, E2E de Functions/Auth/Storage e duas corridas
físicas de logout/resposta tardia. O coordenador confirmou assinatura/DCO, parent
exato e repetiu os 121 testes. Estes resultados pertencem ao commit anterior,
**não ao diff das correções na pausa**.

O E2E provou upload/complete privado, preview no-store, idempotência, RLS
não-owner/anon, promoção imutável confirmada e imagem pública anónima diretamente
pelo URL Supabase em Chromium. Cancelamento após escrita real retém o orphan
privado mas nega o RPC tardio; preview descarregado antes do logout é negado
antes de devolver pixels. A prova específica R4 acima continua pendente.

O ZIP Linux x64/nodejs24.x com Sharp passou import e roundtrip WebP na máquina
local. Isto não comprova execução no runtime de produção.

- Pacote imutável final: `/tmp/jt-studio-task5-final-review-3422117-r3.tar`, SHA-256
  `ce106fb19e881dfc4c47ff5359b79ec74a356a3a2223ef0248d2bcd5263443af`.
- Patch desse pacote: SHA-256
  `ed1ff16c53b2284ef726eaed4c88f2899915132010c432a6b379f0a9e0e3e4d0`.
- ZIP: `/tmp/jt-studio-task5-sharp-function-package/blog-media.zip`, SHA-256
  `cb17cf35c0d34ac9abd19c49d10068c08e36e403169cd149b142b37c8a04a513`.
- Ledger ignorado: `.superpowers/sdd/2026-10-11-blog-editorial/progress.md`,
  `task5-ledger.md`, `task5-report.md` e logs finais nessa mesma pasta.

O lint global continua vermelho (1 282 achados em artefactos gerados/ignorados e
NavBar preexistente). A etapa 6 inclui resolver os ignores operacionais e o NavBar;
não remover cobertura, enfraquecer gates ou apresentar o lint global como verde.
Os parágrafos antigos dos relatórios que dizem “clean worktree” ou “review pending”
descrevem a entrega anterior; este ponto de pausa e o diff atual prevalecem.

## Ambiente local e dados protegidos

Runtime Node: `/tmp/jt-studio-runtime/node-v24.21.0-linux-x64/bin`;
cache npm `/tmp/jt-studio-npm-cache`; browsers `/tmp/jt-studio-browsers`.
Comandos e variáveis restantes estão no runbook. A worktree de implementação é
read-only na sandbox normal: escritas locais aprovadas precisaram de escalations
limitadas ao âmbito; não usar sudo, chmod ou alterações globais como workaround.

Backend local `jt-studio-blog-tests`, API `127.0.0.1:54341`, PostgreSQL
`127.0.0.1:54342`, bridge `jt-studio-blog-tests-network`. Docker Desktop é partilhado.
Baseline protegida `/tmp/jt-studio-protected-docker-20261011.json`: sete containers
e 236 volumes preexistentes, incluindo Keepy. Os IDs da baseline têm 12 caracteres:
comparar prefixo único com nome exato, não igualdade com IDs de 64 caracteres.

Storage próprio (última verificação concluída: healthy, Node UID/GID 1000:1000,
sem ports, apenas bridge própria, 1 CPU/768 MiB/Pids 256/CapDrop ALL/nnp):

- Service `supabase_storage_jt-studio-blog-tests`, ID
  `64db731c94b829cd30427a0b30630e5979e17f15d157d297ac13d7fe0a5910e1`.
- Initializer finito, exited 0, ID
  `fc07c13392c9b099a44ac67f3d175dd87980513a907596b62c71fd01774417bc`.
- Volume persistente `supabase_storage_jt-studio-blog-tests`; tem uploads/orphans.
- Imagem `supabase/storage-api:v1.79.36@sha256:a68a0da4ab90eea4ce0bac36a2b855a162c8f3c03973615c6795995448f7d154`.
- Estado e locks: `task5-storage-runtime.json` e `task5-storage-runtime*.lock`
  no ledger ignorado; preservar. Recovery dos mesmos IDs concluída e aceite.

Não repetir init/start/resume só porque houve pausa. Confirmar estado real em modo
read-only pelo runbook antes de qualquer lifecycle. Não resetar a base, remover
fixtures, objetos, volumes, imagens ou parar o daemon partilhado. A migração
`20261011204337_blog_private_media.sql` já foi aplicada; não a reescrever.

Último E2E final concluído: owner `5117c4e2-1f8d-41b4-b630-9c99e9958605`, media
`720cf4d0-8061-45d0-bf30-831ceecbf89b`, orphan cancelado
`a8ff489b-89d0-4426-961a-58ac0c99115d`. O inventário pós-run confirmou owner NULL,
zero autoridades ativas e sessões provider, histórico e objetos retidos. Antes de
novo teste confirmar novamente; não tratar este inventário histórico como atual.

As autorizações explícitas de Sharp 0.35.5 e dos recursos Storage exatos já foram
dadas e resolveram rejeições de auto-review; não pedir de novo. Não abrangem
limpeza adicional nem alterações cloud. Context7 esgotou quota mensal nesta
execução; foi usado fallback para documentação oficial/pinned. Se continuar
indisponível amanhã, declarar a limitação e manter fontes primárias.

## Produto e sequência a manter

Editor visual Tiptap gratuito, prioridade iPhone/acessibilidade, capa opcional;
artigos sobre técnicas/dúvidas para SEO português e clientes de Setúbal/Lisboa.
Uma conta manual Supabase, autorização server/RLS, sessão em cookie HttpOnly;
nenhum token de sessão em localStorage. Fotos de ficheiros diversos, incluindo
HEIC/HEIF iPhone, convertidas/comprimidas para WebP no browser. Decoder corrigido
libheif 1.23.6 + libde265 1.1.3, artefactos e fontes preservados.

Gravações/uploads não fazem deploy. Um conjunto inteiro confirmado gera um
snapshot imutável e um único dispatch normalmente; não retry cego de resultado
ambíguo. Imagens públicas diretas Supabase, privadas através do BFF autenticado.
As próximas etapas são páginas/SEO (6), confirmação/dispatch (7), build/reconciliação
serializada (8), painel móvel/autosave/distribuição LGPL (9) e gate integrado (10).
Consultar os contratos detalhados no plano em vez de reinventar decisões. O
provisionamento cloud terá plano concreto e aprovação própria; não foi feito.
