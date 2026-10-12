# Blog editorial do JT Studio — Implementation Plan

> **Retoma em 12 de outubro de 2026:** etapas 1–4 aceites, etapa 5 em correção após revisão, etapas 6–10 não iniciadas. Ler [docs/blog-handoff.md](../../blog-handoff.md) para o estado confirmado e concluir a revisão da etapa 5 antes de avançar.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Os modelos, papéis e permissões de `AGENTS.md` prevalecem: Sol coordena, Gemini implementa via `agy`; Luna é fallback por indisponibilidade, não uma alternativa escolhida silenciosamente.

**Goal:** Permitir à Jaqueline preparar artigos acessíveis num editor visual móvel e publicar todos os preparados através de uma versão imutável e um único deploy.

**Architecture:** Netlify Functions gere sessão e operações editoriais no Supabase. O build gera HTML e dados públicos de uma versão confirmada; fotografias WebP são servidas diretamente pelo Supabase Storage. Rascunhos, sessões e media em preparação ficam protegidos.

**Tech Stack:** JavaScript/JSX, React 19.2.6, React Router 7.15.0, Tailwind 4.3.0, rolldown-vite 7.2.5, Tiptap, Supabase, Netlify Functions, Node Test Runner e Playwright.

**Spec:** [docs/blog-spec.md](../../blog-spec.md), revisão escrita aprovada pelo utilizador em 2026-10-11. O utilizador aprovou também este plano e a execução local em 2026-10-11. Implementação em curso na branch `feature/blog-editorial`; o estado e a evidência de cada tarefa ficam no ledger ignorado `.superpowers/sdd/2026-10-11-blog-editorial/progress.md`. Push, PR, merge e deploy não estão autorizados.

## Global Constraints

- “O iPhone é o dispositivo móvel prioritário. O editor deve ser visual, simples e acessível.”
- “Usar Tiptap com as funcionalidades gratuitas.”
- “Gravar rascunhos, carregar fotografias e editar artigos não desencadeia deploys.”
- “Na primeira versão, confirma-se o conjunto inteiro, sem seleção parcial nessa confirmação.”
- “Guardar uma cópia imutável do conteúdo e das referências de media”.
- “Servir as imagens diretamente pelo Supabase, sem proxy Netlify ou cópia para `dist/`.” Esta regra é para imagens públicas; o painel pode receber media privado através de uma Function autenticada.
- “HEIC/HEIF de iPhone é um critério de aceitação, incluindo upload pelo computador de um ficheiro do iPhone.”
- “Tokens não ficam em `localStorage`, `sessionStorage`, URLs ou respostas para o JavaScript do painel.” Refere-se aos tokens de sessão/Auth; um token CSRF não substitui autenticação.
- “Trabalhar em branch e worktree isoladas. Push, PR, merge e deploy exigem autorização explícita”.
- “Não transformar erros em uma lista vazia nem recuperar silenciosamente artigos de um snapshot antigo.”
- Uma conta de produção, criada manualmente; autorização por UUID no servidor e RLS.
- Não atualizar React, Router, Tailwind ou o bundler durante esta fatia. Justificar e rever alterações ao lockfile.
- Guardar evidência e prompts em `tasks/blog-execution/` (ignorado) ou `/tmp`; nunca segredos nos logs.

## Review Focus

1. iPhone: HEIC sem MIME ou com orientação/cores especiais; converter uma fotografia real, sem rotação duplicada ou perda de transparência (Task 2).
2. Resposta tardia: logout, mudança de artigo ou gravação mais recente; não reconstruir dados nem limpar uma sessão nova através de cookies atrasados (Tasks 4 e 9).
3. Duas abas/dispositivos: edição ou prontidão muda depois do resumo; preservar trabalho e exigir nova confirmação (Tasks 3, 7 e 9).
4. Hook com resposta perdida e deploy de código concorrente: não repetir cegamente nem publicar conteúdo antigo depois do novo (Task 8).
5. Conteúdo estranho: `</script>`, links perigosos, media alheio, ficheiros truncados e URLs de posts retirados; não executar conteúdo nem servir uma falsa página de artigo (Tasks 3, 5 e 6).

## 1. Decisões aprovadas neste plano

Estas escolhas concretizam a spec e foram aprovadas com o plano em 2026-10-11. As versões novas continuam sujeitas às provas de compatibilidade previstas nas tarefas.

### Runtime, pre-render e dependências

- Node **24.21.0** para desenvolvimento/verificação e build; Functions em **`nodejs24.x`**. A máquina atualmente tem Node 26.8.1, pelo que o runtime do gate ainda precisa de ser preparado.
- Manter `rolldown-vite@7.2.5`; gerar bundle cliente e entry SSR separada. Usar `StaticRouter` e `renderToString`, seguido de composição HTML estrutural com `parse5`.
- Atualizar **apenas Helmet de 2.0.5 para 3.0.0**. A versão antiga não declara React 19; a nova usa metadata nativa do React. Não usar `helmetContext.helmet`: em React 19 não é preenchido. Provar head, hidratação e navegação na Task 1.
- Fazer a prova dedicada antes de adotar um plugin SSG ou alterar o bundler. Se falhar por limitação fundamental, parar e devolver evidência ao coordenador; uma mudança de stack exige decisão do utilizador.

| Dependência proposta | Versão consultada | Utilização | Licença declarada |
|---|---|---|---|
| `react-helmet-async` | 3.0.0 | Compatibilidade React 19/metadata | Apache-2.0 |
| `@tiptap/core`, `@tiptap/react`, `@tiptap/pm`, `@tiptap/starter-kit` | 3.31.4 | Editor visual | MIT |
| `@supabase/supabase-js` | 2.117.3 | Auth, dados e Storage no servidor | MIT |
| libheif + libde265 | 1.23.6 + 1.1.3 (explicit approved Task 2 amendment, 2026-10-11) | Locally generated lazy HEVC decoder ESM/WASM, pinned-source rebuild documented in `scripts/build-heif-codec/README.md` | LGPL-3.0 notices retained |
| `@jsquash/webp` | 1.5.0 | Encoder WebP de fallback no painel | Apache-2.0 |
| `sharp` | 0.35.5 | Validar WebP efetivamente descodificado no servidor | Apache-2.0 |
| `parse5` | 8.0.1 | Composição/verificação estrutural do HTML no build | MIT |
| `@playwright/test` | 1.64.0 | Browser/E2E | Apache-2.0 |
| `@axe-core/playwright` | 4.13.0 | Verificações automáticas de acessibilidade | MPL-2.0 |
| `pg` | 8.23.1 | Provas de transações/locks em testes | MIT |
| `supabase` | 2.120.0 | CLI de desenvolvimento local | MIT |
| `netlify-cli` | 27.12.0 | Functions e redirects locais | MIT |

Versões verificadas no registry em 2026-10-11; fixar exatamente as dependências novas. As ferramentas de teste/build são devDependencies; o SDK Supabase e `sharp` são dependências do servidor. Conferir e conservar os avisos/licenças dos pacotes e componentes distribuídos, incluindo o decoder LGPL. A autorização posterior e explícita para substituir `heic-to` por libheif 1.23.6 + libde265 1.1.3 WASM aplica-se apenas à Task 2; a tabela regista esse amendment. Cada instalação efetiva e alteração ao lockfile são verificadas e registadas na tarefa correspondente.

### Sessão e gravação

- Cookie opaco **`__Host-jt_admin`**, aleatório de 32 bytes, `HttpOnly; Secure; SameSite=Lax; Path=/`, sem Domain.
- Expiração absoluta de **30 dias desde o login**, mantida no cookie e no servidor; depois pede novo login. Refresh de Auth não prolonga esse limite.
- Guardar apenas o digest SHA-256 do cookie; tokens Supabase cifrados no servidor com AES-256-GCM e chave de 32 bytes fora do Git.
- Renovar tokens quando faltarem menos de **120 segundos** para a expiração; uma claim de refresh por sessão. Uma resposta não pode reviver uma sessão revogada.
- Autosave após **1500 ms** sem alterações; uma gravação física de cada vez por artigo, agrupando alterações mais recentes; “Guardar agora” força a próxima gravação.
- GETs, autosaves e refreshes não escrevem cookies. Login/logout são operações serializadas; erro antigo não apaga cookie de um novo login. Manter epoch da sessão no cliente e sinalizar logout entre abas sem persistir dados protegidos.

### Limites de conteúdo e imagem

- JSON do documento: schema **1**, máximo **256 KiB**, **5000 nós**, profundidade **32**; sem HTML cru ou atributos desconhecidos.
- Título publicado: 1–160 caracteres; resumo publicado: 1–320; slug: 1–120, `[a-z0-9]+(?:-[a-z0-9]+)*`. Rascunhos podem estar incompletos.
- Links: `https:`, `http:`, `mailto:` e `tel:`; rejeitar URLs/atributos executáveis. Serviço relacionado: um dos IDs existentes **1–6**, ou vazio com ligação geral aos serviços.
- Decisão confirmada na Task 3: a capa é opcional mesmo para artigos prontos; uma capa indicada tem de ser media completa do proprietário. A release representa a ausência como `coverMedia: null`.
- A amostra de 100 artigos usada nos testes públicos não define um limite de publicação; as releases ficam sujeitas aos limites dos campos e do runtime, sem um teto numérico inventado de artigos ou bytes.
- Entrada de fotografia: formatos da spec, até **30 MiB**, dimensão até **12000 px** por eixo e **60 milhões de pixels**; uma fotografia processada de cada vez.
- Master: maior lado até **1600 px**, mantendo proporção e sem ampliar. Variantes com larguras 480, 960 e largura do master, eliminando resoluções duplicadas ou maiores que o master.
- WebP: qualidade inicial **0.84**, piso **0.78**. Alvos de bytes por variante: **128/256/512 KiB**; teto de upload **1 MiB por ficheiro**. Se os alvos não forem alcançados com qualidade aceitável, registar e rever o perfil com amostras; não esconder a falha sacrificando os detalhes.
- A Task 2 é a prova destes valores, incluindo qualidade/cores numa fotografia real. Ajustes justificados ao perfil são decididos pelo coordenador e registados antes do restante upload/editor.
- Media privado em `blog-drafts`; aprovado em `blog-public`. Objetos imutáveis, identificados pelo digest dos bytes e largura real.

## 2. Pré-condições e método de execução

Estado observado: Gemini `gemini-3.8-flash-high` consta no catálogo `agy models`; CLI suporta `--model`, `--effort`, `--sandbox`, `--mode`, `--log-file` e saída JSON. O catálogo é evidência de seleção disponível, não prova de execução de uma tarefa. A consulta produziu avisos de escrita em caminhos `.gemini` protegidos; validar permissões pelo mecanismo suportado, sem bypass.

Ferramentas de delegação expõem `gpt-6.1-sol`/high, `gpt-6-luna`/high e `gpt-6-astra`/medium. Usar os papéis de `AGENTS.md`; não lançar agentes nesta etapa de planeamento. Implementação preferencial via `agy`, uma tarefa de cada vez, com modelo e esforço explícitos. Fallback Luna apenas quando o caminho Gemini estiver efetivamente indisponível, preservando diff e evidência. Dois re-plans no máximo; terceira falha real exige Astra Medium.

Antes da Task 1, criar/reutilizar uma worktree de implementação baseada no commit de documentação aprovado, numa branch `feature/blog-editorial`. Manter a branch de documentação e o ficheiro original do utilizador. O coordenador entrega a cada tarefa a spec, contratos deste plano e o estado atual; não o histórico integral. Reutilizar a sessão CLI apenas para corrigir/continuar essa mesma tarefa.

Na preparação inicial, Docker não estava acessível. Em 2026-10-11, o contexto `desktop-linux` passou a responder com daemon 29.8.0. O inventário protegido foi guardado em `/tmp/jt-studio-protected-docker-20261011.json`; nenhum container foi iniciado nesta preparação. Antes da Task 3, revalidar disponibilidade, portas e recursos e registar o runtime isolado no runbook. Não iniciar serviços do sistema nem usar o projeto cloud como substituto automático dos testes locais.

Antes de iniciar containers, o runbook da Task 1 inventaria recursos/portas e identifica os protegidos. Proposta de runtime: projeto Supabase local `jt-studio-blog-tests`, API 54341, DB 54342, Studio 54343, mail 54344. Reservar as restantes portas a partir do `config.toml` efetivamente gerado pela CLI. Usar apenas esse projeto para fixtures/reset. Não fazer prune, apagar volumes ou parar serviços alheios.

O projeto cloud existente `jt-studio` só recebe migrações/configuração da fatia no passo de provisionamento autorizado. A conta real e as opções de signup são preparadas manualmente no dashboard pelo utilizador; nunca pedir passwords/chaves em chat. A configuração Netlify real, variáveis, site ID e hook ainda precisam de ser confirmados. Um preview HTTPS para o iPhone também precisa de autorização explícita de deploy, depois de existir código verificável.

## 3. Contratos entre tarefas

Todos os ficheiros de domínio são ES modules JavaScript; usar JSDoc para os contratos. Não introduzir TypeScript nesta fatia.

| Tipo | Campos essenciais |
|---|---|
| `DocumentV1` | `type: 'doc'`, `content`; nós permitidos: paragraph, text, heading H2/H3, bulletList, orderedList, listItem, hardBreak, image; marks bold/italic/link; preservar spans whitespace; pronto exige texto não whitespace no conjunto do corpo |
| `ArticleDraft` | id, revision, title, slug, excerpt, document, coverMediaId, serviceId, preparedAction, preparedRevision, contentModifiedAt, firstConfirmedAt |
| `MediaVariant` | width, height, mime `image/webp`, byteLength, sha256, objectKey; URL público só após promoção |
| `MediaGroup` | id, pipelineVersion 1, ownerId, state uploading/complete, variants |
| `PublicPost` | id, slug, title, excerpt, document, cover/media públicos, serviceId, publishedAt, modifiedAt; sem owner/session/URLs privados |
| `ReleaseV1` | schemaVersion 1, releaseId, posts completos imutáveis; payload textual e digest armazenados juntos |
| `PublicationSummary` | baseReleaseId, changes `{postId, revision, action}`, digest; inclui alterações aprovadas ainda não online |
| `AuthContext` | userId, authSessionId, appSessionDigest, generation, userSdk; exclusivamente no servidor |
| `PublicationStatus` | requestId, releaseId, attemptId, state, deployId; estados preparing/queued/building/live/failed/unknown |
| `PublicPageData` | releaseId, index com resumos sem corpos, post da rota ou null |

API do painel sob `/api/admin`: session (GET/POST/DELETE), posts (GET/PUT), readiness (POST), media (POST/GET), publication-summary (GET), publications (POST/GET), publication-progress (POST) e retry (POST). Mutations exigem cookie, Origin exato e `X-CSRF-Token`; a resposta contém apenas dados necessários. Erros estáveis: 400 validação, 401 sessão, 403 autoridade/origin, 409 revisão/publicação em curso, 413 limites, 503 dependência/resultado por confirmar. GET de estado não promove media nem dispara hooks.

O build usa uma identidade de servidor protegida, sem chaves em `VITE_`. Previews não recebem credenciais/hook de produção. Fixture build exige modo explícito e dados sintéticos, nunca um fallback depois de falhar uma consulta real.

## 4. Ficheiros e responsabilidade

- `src/blog/content-schema.js`, `content-validate.js`, `safe-json.js`: documento, campos e serialização segura partilhados entre build/servidor.
- `src/blog/media-contract.js`, `image-processing.js`, `image-worker.js`: política de media e otimização, carregada só no painel.
- `src/blog/PublicDataContext.jsx`, `ContentRenderer.jsx`, `public-data.js`: apresentação e leitura estática, sem SDK Supabase.
- `src/admin/api.js`, `session.js`, `autosave.js`, `useEditorDraft.js`: transportes e ciclo de vida do painel.
- `src/admin/Admin.jsx`, `ArticleEditor.jsx`, `ImageNode.jsx`, `MediaPicker.jsx`, `PublicationReview.jsx`: UI móvel.
- `server/blog/config.mjs`, `auth.mjs`, `session-store.mjs`, `csrf.mjs`, `repositories.mjs`, `media.mjs`, `publication.mjs`, `netlify-api.mjs`: Functions e operações de build; nunca importados pela aplicação pública.
- `netlify/functions/blog-admin.mjs`: adaptador HTTP fino para os serviços anteriores.
- `src/entry-server.jsx`, `scripts/build-blog.mjs`, `render-html.mjs`, `public-files.mjs`, `check-public-artifacts.mjs`: build e verificação dos artefactos.
- `supabase/config.toml`, migrações geradas pela CLI e `tests/db/`: schema e provas reais de acesso/transação.
- `tests/unit/`, `tests/browser/`, `tests/e2e/`, `tests/fixtures/`: fixtures sintéticas e cenários automatizados.
- `scripts/test-backend.mjs`, `test-db.mjs`, `e2e-server.mjs`, `playwright.config.js`: execução isolada/reproduzível.
- `docs/blog-development.md`: runbook de runtime, proteção de recursos, gates e configuração; detalhe transitório no ledger ignorado.

Criar ficheiros apenas na tarefa que os necessita. Não fazer scaffolding vazio de todos os módulos.

## Task 1: Prova de HTML/metadata e ambiente de verificação

**Files:** criar `src/entry-server.jsx`, `src/blog/PublicDataContext.jsx`, `src/blog/safe-json.js`, `scripts/render-html.mjs`, `scripts/build-blog.mjs`, `scripts/check-public-artifacts.mjs`, `tests/unit/render-html.test.mjs`, `tests/browser/existing-pages.spec.js`, `tests/fixtures/empty-release.json`, `playwright.config.js`, `docs/blog-development.md`, `.nvmrc`, `.npmrc`, `netlify.toml`; modificar `src/main.jsx`, `package.json`, lockfile, `vite.config.js`, `eslint.config.js`, `index.html`, `.gitignore` apenas para artefactos desta execução.

**Interfaces:** `renderRoute(pathname, pageData) -> markup`; `composeHtml(template, markup, pageData) -> html`; `buildBlog({mode, release, outDir}) -> Promise<manifest>`. `PublicDataContext` fornece `PublicPageData`. Nesta prova a release é vazia e só se renderizam as cinco rotas atuais.

- [ ] **1 — Escrever provas:** `render_html_keeps_assets_and_moves_metadata_to_head` verifica um title/description/canonical, BeautySalon único e assets existentes; `safe_bootstrap_cannot_close_script` testa `</script>`; `five_routes_keep_their_content` lê HTML das cinco páginas. Criar a harness Node/Playwright que as executa.
- [ ] **2 — Preparar dependências/runtime e executar RED:** após confirmar a versão Node, instalar apenas Helmet 3.0.0, parse5 e ferramentas de teste necessárias. Configuração de projeto `legacy-peer-deps=false`; confirmar instalação com resolução de peers, sem alterar a configuração global. `node --test tests/unit/render-html.test.mjs` deve falhar por ausência de implementação, não por setup.
- [ ] **3 — Implementar a prova:** builds cliente/SSR em diretórios diferentes; composição DOM com parse5. Helmet 3 em React 19 devolve metadata no markup nativo; extrair os nós hoistable para head sem presumir contexto Helmet. Preservar scripts/fontes/assets existentes; remover apenas metadata/JSON-LD estáticos duplicados. Introduzir modo fixture explícito, serialização segura do bootstrap e hydrateRoot para HTML pré-renderizado; conservar createRoot para shells sem SSR. Criar checker mínimo e prova de browser das cinco páginas, antes de expandir para o blog.
- [ ] **4 — Verificar GREEN:** mesmo comando unitário, `npm run build:fixture`, `node scripts/check-public-artifacts.mjs` após criar o checker mínimo. Testar hidratação/navegação das cinco rotas em browser, sem avisos de mismatch ou assets 404. Documentar baseline e comando de cada script introduzido.
- [ ] **5 — Autorrevisão e commit local:** aceitar esta abordagem só com HTML/metadata demonstrados; senão devolver evidência ao coordenador. Commit assinado+DCO dos ficheiros da tarefa: `feat: prove static React rendering on the existing build stack`.

**Gate:** não avançar com erro de peers escondido, metadata ausente ou incompatibilidade fundamental do bundler. O runbook define recursos locais protegidos antes de qualquer container.

## Task 2: Pipeline de fotografias, incluindo iPhone

**Files:** criar `src/blog/media-contract.js`, `image-processing.js`, `image-worker.js`, o parser limitado `src/blog/media-header.js`, `src/blog/codecs/` (adapter C-API e artefactos ESM/WASM reproduzíveis), `scripts/build-heif-codec/`, `tests/unit/` e `tests/browser/` dedicados, e fixtures de imagem com origem/licença identificadas. O encoder WebP mantém `@jsquash/webp` 1.5.0; não se distribui decoder npm. O comando de rebuild é separado do build normal do site. Fotografias reais fornecidas para a prova ficam fora do Git.

**Interfaces:** `optimizeImage(file, {signal, onProgress}) -> Promise<{pipelineVersion:1, variants:BlobVariant[]}>`; `validateInputImage(file) -> InputInfo`; `BlobVariant` tem blob WebP, largura/altura reais, tamanho e digest. Publicar as constantes de política em `media-contract.js`.

- [ ] **1 — Escrever provas:** JPEG rodado, PNG com alpha, WebP pequeno, HEIC/HEIF sem MIME e AVIF; assert WebP descodificável, dimensões proporcionais, sem ampliação, sem EXIF/XMP e transparência preservada. `cancelled_image_never_attaches_to_another_article` cancela e muda de artigo antes do resultado. Um ficheiro inválido deve produzir erro legível, sem perder texto.
- [ ] **2 — Executar RED:** `node --test tests/unit/media-policy.test.mjs` e `npm run test:browser -- tests/browser/image-processing.spec.js`; provar ausência de comportamento, não ausência de browser/fixture.
- [ ] **3 — Implementar:** worker carregado por `new URL(..., import.meta.url)`, processamento sequencial e libertação de bitmaps/object URLs. O decoder HEIC/HEIF ESM/WASM gerado localmente a partir das versões corrigidas aprovadas de libheif/libde265 só é carregado ao processar HEIC/HEIF; a validação limitada resolve a imagem primária e rejeita metadados inválidos/ambíguos antes da alocação do decoder. Encoder WebP nativo validado por MIME e assinatura RIFF, com fallback WASM empacotado localmente. Não buscar bibliotecas de CDN durante conversão. Interromper o worker em cancelamento/erro; conservar a geração do artigo que originou o pedido.
- [ ] **4 — Verificar GREEN e qualidade:** executar os comandos focados em Chromium e WebKit sobre o worker/decoder realmente compilados; provar carregamento local lazy, imagem primária, dados malformados/limites, orientação, fallback, cancelamento, cap do lado maior e dimensões únicas. Medir bytes/tempo e comparar a imagem WebP completa com a referência descodificada a resolução igual. Uma imagem pública de câmara é evidência de uma amostra; qualidade de retratos/detalhe, memória máxima e Safari num iPhone físico continuam gates próprios.
- [ ] **5 — Autorrevisão e commit:** registar perfil validado e licenças no runbook; commit assinado+DCO `feat: optimize uploaded photos to responsive WebP variants`.

**Gate:** o amendment explícito de 2026-10-11 aprova o build reprodutível de libheif 1.23.6 + libde265 1.1.3 nesta Task 2. Manter source commits/hashes, notices completos, identidade do compiler e hashes dos outputs; o build só é reproduzível byte a byte se hashes de duas execuções concordarem. Não alegar reprodução do advisory nativo no browser, pico de memória ou aceitação de device. A aceitação da Task 2 continua a cargo da revisão independente do coordenador.

## Task 3: Modelo editorial, RLS e composição imutável

**Files:** criar config Supabase pela CLI; gerar migração com `supabase migration new blog_editorial` (nome temporal fornecido pela CLI), `src/blog/content-schema.js`, `content-validate.js`, `server/blog/repositories.mjs`, `scripts/test-backend.mjs`, `test-db.mjs`, `tests/db/editorial.sql`, `publication.sql`, `concurrency.mjs`, `tests/unit/content-validate.test.mjs`; ampliar `safe-json.js` se necessário e runbook. Consultar `--help` da CLI instalada antes dos comandos de setup/migração.

**Interfaces:** `validateDraft(input) -> normalizedDraft`; `validateReadyArticle(draft, media) -> normalizedArticle`; `savePost(auth, input, expectedRevision) -> ArticleDraft`; `markPrepared(auth, postId, expectedRevision, action) -> ArticleDraft`; `getPublicationSummary(auth) -> PublicationSummary`; `freezeRelease(auth, requestId, expectedDigest) -> {releaseId,payload,digest}`. Os RPCs de gravação/prontidão/composição têm os mesmos nomes em snake_case com prefixo `blog_`.

Schema proposto: `public.blog_posts`, `blog_media`; `blog_private.settings`, `admin_sessions`, `releases`, `publication_requests`, `build_slot`. Releases são imutáveis; o estado de execução fica separado. Settings contém o UUID autorizado. Revogar EXECUTE PUBLIC de todos os RPCs; conceder apenas o necessário. Helper de autorização em schema não exposto, search_path explícito e guardas `auth.uid()`; justificar qualquer SECURITY DEFINER em vez de o usar para esconder erros de permissão. Os testes criam owner e sessão sintéticos; a Task 4 acrescenta criação/refresh/revogação através de Auth real. Seed inicial explícito de release vazia, sem fallback em produção.

- [ ] **1 — Escrever provas:** rascunho incompleto guardável, pronto inválido rejeitado, revisão stale 409, slug bloqueado depois da confirmação, edição invalida prontidão. Conteúdo executável/atributos estranhos e media fora do âmbito são rejeitados. Compor A publicado + B pronto + C rascunho mantém A/B e exclui C; remoção pronta retira A. Snapshot B não muda depois de editar o working copy.
- [ ] **2 — Executar RED em backend próprio:** inventariar Docker/portas; iniciar exclusivamente o projeto local do runbook quando disponível. `npm run test:db -- editorial publication concurrency` e `node --test tests/unit/content-validate.test.mjs`. O runner recusa URL cloud, projeto diferente e reset sem identificação do runtime de teste. Mostrar bloqueio real através de `pg_blocking_pids`, não sleeps.
- [ ] **3 — Implementar:** trigger de revisão/contentModifiedAt, constraints, índice de slug e RLS por UUID. Distinguir `preparedAction` upsert/remove e `preparedRevision`. Bloquear as linhas ao congelar base/revisões; armazenar payload textual completo e digest. Manter primeira confirmação e bloquear mutação/delete dos snapshots. Private schema fora do Data API; RPCs privilegiados de sessão/build só para servidor. Migração local iterável, advisors e ficheiro de migração gerado pela CLI antes do commit.
- [ ] **4 — Verificar GREEN:** repetir os mesmos comandos com owner, conta autenticada não autorizada e anon. Provar que as guardas negativas falham quando removidas e que a ordem real dos locks impede confirmação stale. Testar lista aprovada pendente após build falhado como base da publicação seguinte, sem ocultar diferenças face à versão online.
- [ ] **5 — Autorrevisão e commit:** guardar DDL, nomes reais da migração, advisors e provas redigidas no ledger; commit assinado+DCO `feat: add revisioned editorial data and immutable releases`.

## Task 4: Sessão persistente, cookies e fronteira HTTP

**Files:** criar `server/blog/config.mjs`, `auth.mjs`, `session-store.mjs`, `csrf.mjs`, `netlify/functions/blog-admin.mjs`, `src/admin/api.js`, `session.js`, `.env.example`, `tests/unit/auth.test.mjs`, `tests/e2e/session.spec.js`; gerar migração adicional pela CLI se os RPCs de sessão o exigirem; modificar Netlify/runbook.

**Interfaces:** `login({email,password}, request) -> {response, session}`; `requireAdmin(request, {mutation}) -> Promise<AuthContext>`; `logout(auth) -> void`; `executeSessionMutation(auth, {operation,input}) -> result`, onde operation é um enum fechado de RPCs editoriais; cliente `adminFetch(path, options, {epoch,signal}) -> data`, `getSession()`, `login()`, `logout()`. Cada RPC executa lock/revalidação da sessão, autorização owner e escrita numa única transação PostgreSQL. Não tentar manter uma transação entre chamadas HTTP independentes ao Supabase nem executar callbacks JavaScript dentro dela. RPCs privilegiados são estreitos, com grants explícitos e guardas testadas; nenhuma operação CRUD genérica através de service-role.

- [ ] **1 — Escrever provas:** login cookie correto/sem JWT na resposta; reabrir browser mantém sessão; expiração 30 dias falha fechada; conta errada 403; Origin/CSRF inválidos bloqueiam escrita. Testar duas renovações concorrentes e logout enquanto uma resposta está em voo. `late_401_does_not_clear_new_login_cookie` verifica o transporte/Set-Cookie, além do estado React.
- [ ] **2 — Executar RED:** `node --test tests/unit/auth.test.mjs`; `npm run test:e2e -- tests/e2e/session.spec.js` com Auth real local e Functions reais locais. Usar apenas fixture origin, sem relaxar Secure/CSRF/RLS para obter verde.
- [ ] **3 — Implementar:** SDK servidor `persistSession:false`, `autoRefreshToken:false`, `detectSessionInUrl:false`; cookie opaco/digest e tokens cifrados em tabela privada. Claim CAS de refresh por sessão; atualizar apenas a geração ativa. Tratar refresh ambíguo conservadoramente; exigir novo login sem descartar texto se não houver renovação demonstrada. Validar identidade com Auth, UUID autorizado e sessão app revogável. Mutations e logout coordenam o mesmo registo de sessão e revalidam após o lock; não basta abortar consumidores.
- [ ] **4 — Verificar GREEN:** mesmos comandos e prova DB de ordenação logout/escrita. Logout revoga primeiro a sessão app e tenta terminar a sessão Supabase; resposta atrasada não a recria. Não alterar cookie em GET/refresh/erro. Cliente serializa login/logout e invalida epochs entre abas. Logs/artefactos omitem tokens, passwords e payloads de login.
- [ ] **5 — Autorrevisão e commit:** validar grants/crypto/config/cache e diferença entre autorização RLS e autenticação; commit assinado+DCO `feat: add persistent server-managed admin sessions`.

## Task 5: Upload privado validado e promoção de media

**Files:** criar `server/blog/media.mjs`, `src/admin/MediaPicker.jsx`, `tests/unit/media-api.test.mjs`, `tests/db/storage.sql`, `tests/e2e/media.spec.js`; acrescentar rotas no adaptador Functions, policies/buckets em migração gerada e dependência sharp.

**Interfaces:** `uploadVariant(auth, mediaId, variant, bytes) -> MediaVariant`; `completeMedia(auth, mediaId) -> MediaGroup`; `readPrivateVariant(auth, mediaId, width) -> Response`; `promoteMedia(auth, mediaIds) -> publicMediaMap`. Pipeline cliente da Task 2 é a única entrada da UI.

- [ ] **1 — Escrever provas:** WebP real válido, MIME/extension falsificados, bytes truncados, EXIF, dimensões e >1 MiB. Conta errada/anon não acedem a drafts. Repetir upload idêntico reutiliza objeto; bytes diferentes não sobrepõem uma referência existente. Uma variante falhada não marca o grupo complete nem o liga ao artigo.
- [ ] **2 — Executar RED:** `node --test tests/unit/media-api.test.mjs`, `npm run test:db -- storage`, `npm run test:e2e -- tests/e2e/media.spec.js`.
- [ ] **3 — Implementar:** pedidos limitados a uma variante por vez; validar descodificação e metadata com sharp e depois guardar WebP. Bucket privado com policies owner e limites de tipo/tamanho; bucket público sem escrita direta authenticated. Gerar caminhos/digests no servidor. Promover por download/upload servidor apenas objetos novos referenciados pela versão confirmada; não sobrescrever. Preview privado autenticado com `Cache-Control: private, no-store`, sem tokens Supabase no browser.
- [ ] **4 — Verificar GREEN:** mesmos comandos; após publicar, navegador público lê URL Supabase e nenhum pedido de imagem pública passa pelo Netlify. Alterar fotografia mantém URL anterior funcional para a versão antiga. Testar upload cancelado e logout durante upload, validando sessão antes de finalizar/vincular.
- [ ] **5 — Autorrevisão e commit:** registar byte limits/grants e que imagens aprovadas podem ficar públicas antes do deploy concluir. Sem GC/limpeza de media por iniciativa do agente; commit assinado+DCO `feat: add private draft media and immutable public image URLs`.

## Task 6: Páginas públicas, metadata e dados estáticos por rota

**Files:** criar `src/pages/Blog.jsx`, `BlogPost.jsx`, `NotFound.jsx`, `src/blog/ContentRenderer.jsx`, `public-data.js`, `scripts/public-files.mjs`, `tests/fixtures/published-release.json`, `tests/unit/public-files.test.mjs`, `tests/browser/public-blog.spec.js`; ampliar checker da Task 1; modificar entry SSR, build/composição, `src/App.jsx`, `main.jsx`, `components/SEO.jsx`, NavBar/Footer, `pages/Services.jsx` para anchors dos serviços, `_redirects`, `_headers`, `robots.txt`; retirar sitemap manual quando o gerado existir.

**Interfaces:** `renderDocument(document, mediaMap) -> ReactNode`; `writePublicFiles(release, outDir, deployMeta) -> manifest`; `loadPublicIndex({signal}) -> summaries`, `loadPublicPost(slug,{signal}) -> PublicPost`; `checkPublicArtifacts(outDir, expectedReleaseId) -> report`. Dados em `/blog-data/<releaseId>/index.json` e `posts/<slug>.json`; manifest público `/blog-release.json` contém apenas releaseId/deployId/digest/schema.

- [ ] **1 — Escrever provas:** dois posts com capas/canonical/datas diferentes, rascunho excluído, título `</script>` inofensivo e sem schemas duplicados. Index não contém corpos; navegação para um artigo não descarrega os outros 99. Artigo retirado/inexistente tem 404 real no servidor e estado 404 client-side.
- [ ] **2 — Executar RED:** `node --test tests/unit/public-files.test.mjs`; `npm run test:browser -- tests/browser/public-blog.spec.js`. Usar release sintética com 100 resumos e conteúdo sentinela por post.
- [ ] **3 — Implementar:** só nós/marks permitidos, URL/media validados e React para escapar texto. Bootstrap JSON seguro e apenas dados da rota; hydrateRoot quando houver SSR e createRoot para shells SPA. Assets/dados versionados são servidos estaticamente; não consultar SDK no browser público. Metadata por post, Blog/BlogPosting, dimensões OG reais e datas da revisão confirmada. Canonical base fixa `https://jaquelinetakiutistudio.com`. Listagem recente, links de serviço e autoria. Emitir HTML cinco rotas + blog/posts, sitemap e 404; regra `/blog/*` 404 precede fallback SPA e respeita os ficheiros existentes.
- [ ] **4 — Verificar GREEN:** repetir comandos, checker e navegação sem hydration warnings. Lazy loading abaixo da zona inicial e sizes conforme largura renderizada; index.html/JSON/HTML com cache revalidável, dados versionados com cache imutável. Verificar fotos srcset e nenhuma chave/URL privado nos artefactos. Layout/comportamento das cinco páginas preservados.
- [ ] **5 — Autorrevisão e commit:** confirmar slug/datas/404 e não introduzir editor/SDK no bundle público; commit assinado+DCO `feat: render static blog pages with per-post metadata and sitemap`.

## Task 7: Confirmação do conjunto e dispatch idempotente

**Files:** criar `server/blog/publication.mjs`, `tests/unit/publication.test.mjs`, `tests/db/publication-dispatch.sql`; ampliar repositories/RPCs e rotas Functions.

**Interfaces:** `preparePublication(auth) -> PublicationSummary`; `confirmPublication(auth,{requestId,expectedDigest}) -> PublicationStatus`; `advancePublication(auth,{requestId}) -> PublicationStatus`; `dispatchPublication(requestId,attemptId) -> PublicationStatus`; `retryPublication(auth,{requestId,retryId}) -> PublicationStatus`. `retryId` é uma chave nova por tentativa explicitamente pedida; mantém releaseId. A promoção trabalha em passos limitados, persistindo progresso por objeto; o painel chama POST publication-progress para avançar a intenção já confirmada, incluindo após reabrir a página. Não depender de trabalho em memória depois de a Function devolver resposta, nem de uma única Function promover todas as fotografias de 100 artigos. Consultar/medir limites reais de runtime antes de fixar o tamanho de cada passo.

- [ ] **1 — Escrever provas:** dez prontos produzem release única e mock hook chamado uma vez; double-click/pedido repetido mantém IDs. Mudar prontidão/revisão/base após resumo dá 409 e zero hooks. Estado ready só é consumido na confirmação correta. Falha de promoção não dispara hook nem publica snapshot parcialmente preparado. Interromper/reabrir o painel a meio da promoção reutiliza objetos concluídos e conserva a única intenção confirmada.
- [ ] **2 — Executar RED:** `node --test tests/unit/publication.test.mjs`; `npm run test:db -- publication-dispatch` com dois pedidos físicos concorrentes e evidência de bloqueio.
- [ ] **3 — Implementar:** transação grava intenção/snapshot e reserva publicação; promoção verifica geração/intenção antes do dispatch. Hook URL só configuração servidor, host/path allowlisted, branch main fixa; payload com requestId/releaseId/attemptId. Claim de dispatch persistente, uma só tentativa ativa. Não instalar Database Webhook em cada save/status: a confirmação é o único caminho editorial para o hook.
- [ ] **4 — Verificar GREEN:** mesmos comandos; resposta perdida do hook gera unknown, não retry automático. Só permitir repetir depois de erro terminal demonstrado; reutilizar a release e nunca ampliar a confirmação com working copies mais recentes. Exibir também artigos aprovados de uma tentativa anterior ainda não online.
- [ ] **5 — Autorrevisão e commit:** rever fronteira de efeito externo e idempotência; commit assinado+DCO `feat: confirm and dispatch batched blog publications`.

## Task 8: Build serializado e reconciliação do deploy

**Files:** criar `server/blog/netlify-api.mjs`, `scripts/production-release.mjs`, `tests/unit/deploy-state.test.mjs`, `tests/db/build-slot.sql`, `tests/e2e/publication.spec.js`; ampliar build, publication/repositories e runbook.

**Interfaces:** `acquireBuild({deployId,hookPayload}) -> ReleaseV1`; `assertBuildCurrent({deployId,releaseId}) -> void`; `getDeploy(deployId) -> DeployEvidence`; `reconcilePublication(requestId) -> PublicationStatus`. Evidence contém siteId, deployId, context, branch, terminalState e publishedDeployId; não devolver payload completo Netlify ao browser.

- [ ] **1 — Escrever provas:** code build A reserva slot e confirmação B espera/rejeita até A terminar; build hook B só lê a sua release. Callback A tardio não marca B online. Preview, site errado, deploy ready não publicado e lease expirada sem prova terminal não avançam o estado. Falha de fetch/config dá saída !=0 e nenhum artefacto vazio.
- [ ] **2 — Executar RED:** `node --test tests/unit/deploy-state.test.mjs`, `npm run test:db -- build-slot`, `npm run test:e2e -- tests/e2e/publication.spec.js` com hook/API provider locais controlados e backend real.
- [ ] **3 — Implementar:** todos os builds de produção adquirem o mesmo slot antes de escolher a versão; confirmações editoriais não avançam requestedRelease enquanto um build anterior puder publicar. Uma reserva editorial só é adquirida pelo request/attempt do seu hook. Payload `INCOMING_HOOK_BODY` descodificado estritamente; `DEPLOY_ID` identifica o build. Revalidar slot/versão antes de concluir. Não libertar slot só por timeout: reconciliar com API Netlify e deploy atualmente publicado. API token servidor, endpoints fixos e redirects rejeitados. Reconciliação considera terminal/publicado, não o HTTP 200 do hook.
- [ ] **4 — Verificar GREEN:** mesmos comandos e atrasos determinísticos do provider. Estado live exige site/context/branch corretos, deploy publicado e manifest da origem pública fixa com IDs/digest esperados. Se houver erro de integração/estado desconhecido, manter bloqueio e última versão pública. Sem PAT/config suficiente, o gate fica pendente em vez de prometer retries seguros.
- [ ] **5 — Autorrevisão e commit:** documentar recuperação de unknown, falhas e build interrompido; commit assinado+DCO `feat: coordinate production builds and verify published releases`.

**Gate:** a simulação prova o contrato local. Verificar posteriormente o contrato de publication/atomic deploy numa integração Netlify autorizada; não afirmar prova remota só com mocks.

## Task 9: Painel móvel Tiptap, autosave e revisão de publicação

**Files:** criar `src/admin/Admin.jsx`, `ArticleEditor.jsx`, `ImageNode.jsx`, `PublicationReview.jsx`, `autosave.js`, `useEditorDraft.js`, `tests/unit/autosave.test.mjs`, `tests/e2e/editor.spec.js`, `tests/e2e/accessibility.spec.js`; ampliar MediaPicker/API/session e rota lazy `/admin`; instalar Tiptap fixado.

**Interfaces:** `AutosaveController({save,debounceMs,onState})` com `change(draft)`, `flush()`, `dispose()`; `useEditorDraft(postId,sessionEpoch) -> {draft,saveState,update,saveNow,markReady}`. Image node guarda mediaId/alt/caption, não src privado. UI consome APIs das Tasks 4–8 e a pré-visualização partilha ContentRenderer.

- [ ] **1 — Escrever provas:** escrita/formatação/links e upload numa viewport móvel; teclado/click targets/foco/labels; auto/manual save e erro preservam texto. `older_save_response_cannot_overwrite_newer_text`, conflito duas abas, navegação com alterações por guardar e logout em voo. Summary mostra todos os prontos e diferenças pendentes, confirmação provoca uma publicação e estado online só após evidência.
- [ ] **2 — Executar RED:** `node --test tests/unit/autosave.test.mjs`; `npm run test:e2e -- tests/e2e/editor.spec.js tests/e2e/accessibility.spec.js`. Ligar UI às Functions/Auth/Storage reais do backend local; interceptar apenas serviços externos e provider Netlify, sem substituir guardas da aplicação.
- [ ] **3 — Implementar:** Tiptap StarterKit limitado ao schema (desativar nós/marks não aprovados), image node próprio e toolbar acessível compacta. Título/capa/resumo/corpo/serviço, slug auto editável só antes da primeira confirmação. Autosave serial/epoch com latest queued draft, estado “Guardado” após ACK real; preparar/remover/publicar ações claras. Antes de mudar artigo, resolver gravação pendente ou pedir decisão explícita preservando o texto. Painel não carrega 100 corpos/imagens de uma vez: paginação de 20 artigos, detalhes só ao abrir. `/admin` usa noindex em metadata e `X-Robots-Tag` nos headers, fica fora do sitemap e não contém dados privados no shell HTML; verificar isso no E2E.
- [ ] **4 — Verificar GREEN:** mesmos comandos, axe sem violações novas na superfície criada, teclado e leitor de ecrã manual. Testar barra com teclado móvel aberto, progressos, conflito e falhas anunciadas. Confirmar que epoch descartado não volta a guardar, mesmo quando o consumidor foi abortado; esperar transportes em operações de login/logout.
- [ ] **5 — Autorrevisão e commit:** conferir texto pt-PT e ausência de imports pesados no bundle público; commit assinado+DCO `feat: add accessible mobile-first visual blog administration`.

## Task 10: Gate integrado, provisionamento e handoff

**Files:** criar `.github/workflows/blog-verification.yml`, `tests/e2e/full-flow.spec.js`, `scripts/verify-blog.mjs`; consolidar runbook, spec/estado e ledger. Sem mudanças estruturais ao AGENTS.md por iniciativa do implementador.

**Interfaces:** `verifyBlog({mode:'local'|'authorized-preview'}) -> report` executa os gates aplicáveis e regista também os pendentes. `npm run verify:blog` é o gate integrado local definido abaixo.

- [ ] **1 — Escrever prova integrada:** conta owner + não autorizada, dez artigos prontos + um rascunho, três formatos incluindo HEIC, revisão de artigo online, remoção, callback atrasado, falha e retry demonstrado. Provar um hook para o primeiro conjunto; snapshots/HTML/sitemap coerentes, zero rascunhos/segredos, cinco rotas e navegação funcionais. Cenário rede lenta 200 kbit/s e RTT 400 ms mede variantes/bytes/layout; toda a base permanece estável durante E2E.
- [ ] **2 — Executar RED:** `npm run test:e2e -- tests/e2e/full-flow.spec.js`; correr cedo os novos cenários. A prova precisa de falhar causalmente quando as guardas de autorização/epoch/idempotência forem removidas, numa cópia descartável da própria fatia, sem alterar trabalho alheio.
- [ ] **3 — Implementar gate/CI:** Node 24.21.0 e lockfile, instalação sem ignorar peers, runtime Supabase de teste isolado, build fixture imutável + Netlify Dev offline + Playwright. Instalar browsers antes dos testes. Proteger logs/artefactos; traces de login/upload privado desligadas e restantes evidências com fixtures sintéticas. Nunca usar chaves cloud/hook real em CI de PR. Comparar baseline das cinco páginas e consumo do novo bundle/HTML/imagens.
- [ ] **4 — Verificar GREEN local e rever globalmente:** `npm run verify:blog`; revisão independente do coordenador sobre diff Gemini/Luna, especialmente sessão, locks, snapshots, efeitos externos, RLS/Storage e HTML. Corrigir achados e repetir apenas os gates afetados, depois o integrado. Relatar qualquer precondição/falha sem causa; não adicionar retries/skips/timeouts para esconder problemas.
- [ ] **5 — Preparar provisionamento concreto:** validar migração em backend vazio local e advisors; apresentar SQL/configuração e recursos exatos antes da ação cloud abrangida pela autorização. Projeto existente jt-studio, sem criar outro. Utilizador cria conta e desativa signup/anónimos; registar só UUID autorizado. Preparar variáveis/hook/runtime no Netlify sem revelar valores. Não disparar hook real, push, PR ou deploy nesta etapa sem autorização explícita desses atos.
- [ ] **6 — Após autorização de preview HTTPS:** usar ambiente/configuração que não possa disparar produção. Testar o iPhone real, login ao reabrir, HEIC real, VoiceOver/teclado, HTML raw/sitemap e preview WhatsApp. Provar mapping do deploy e leitura dos URLs públicos. Se algum destes gates não puder ocorrer, manter entrega como implementação local verificada, com gates remotos/dispositivo pendentes.
- [ ] **7 — Commit local e handoff:** commit assinado+DCO `test: verify integrated blog publishing and document operation`; entregar HEAD/parent, diff, resultados, recursos preservados e opções de integração só após gates/revisão aplicáveis. Integração/produção são decisões do utilizador.

## 5. Scripts e gate integrado a introduzir

| Script proposto | Comando/responsabilidade |
|---|---|
| `test:unit` | `node --test tests/unit/*.test.mjs` |
| `test:db` | `node scripts/test-db.mjs` (seleção de suites por argumentos) |
| `test:browser` | `playwright test tests/browser` |
| `test:e2e` | `playwright test tests/e2e` |
| `build:fixture` | `node scripts/build-blog.mjs --fixture tests/fixtures/published-release.json` (empty-release na prova inicial) |
| `build` | `node scripts/build-blog.mjs --production` (valida contexto/configuração e obtém slot/release) |
| `verify:blog` | `node scripts/verify-blog.mjs --local` |

`verify-blog` executa sequentialmente lint, unit, DB, build fixture/checker, browser e E2E. Falta de daemon, fixture, browser ou segredo de teste é erro de setup distinto; não skip. Não invocar build de produção/hook num gate local. `eslint.config.js` deve separar globals browser/Node e incluir `.mjs`; não apenas ignorar o servidor/scripts.

`e2e-server.mjs` inicia Netlify Dev **offline** sobre `vite preview` do `dist` já construído (port 8888, target 4173, framework `#custom`, no-open); não usar HMR como gate final. Processos/portas da execução são registados e apenas os próprios são parados. A CLI deve ler configuração local de teste, não descarregar variáveis do site de produção. Confirmar Secure cookie em loopback; se o browser exigir HTTPS, preparar TLS de teste confiado, não desativar a guarda/cookie para obter verde.

## 6. Variáveis e configuração

Configuração servidor: `SUPABASE_URL`, chave publishable, segredo servidor Supabase, `BLOG_ADMIN_USER_ID`, `BLOG_SESSION_ENCRYPTION_KEY`, `BLOG_PUBLIC_ORIGIN`, `BLOG_NETLIFY_SITE_ID`, `BLOG_NETLIFY_API_TOKEN`, `BLOG_NETLIFY_BUILD_HOOK`. Tokens privilegiados são usados exclusivamente em helpers estreitos do servidor; o CRUD editorial usa a identidade/RLS do owner. O mesmo código distingue explicitamente fixture/local/produção e recusa hosts cruzados.

Netlify build: `NODE_VERSION=24.21.0`; Functions `AWS_LAMBDA_JS_RUNTIME=nodejs24.x` configurado no dashboard/API, não no toml. Variáveis necessárias disponíveis nos contextos corretos; conferir capacidade efetiva do plano Free para scopes. Não copiar .env.local nem segredos para Git. Dados públicos versionados têm releaseId fixado no bundle; não introduzir env `VITE_` para credenciais.

O plano Free Supabase e disponibilidade do Storage continuam um risco operacional conhecido. Medir utilização/monitorizar estado; não criar keep-alive ou reativar projetos por iniciativa do agente. Retenção e limpeza de media/snapshots ficam fora desta autorização: nenhum gate apaga volumes/dados de produção nem referências de versões recuperáveis.

## 7. Cobertura e aceitação do plano

| Secções da spec | Tarefas |
|---|---|
| 1–3: objetivo, stack e arquitetura | 1, 6, 10 |
| 4: editor, autosave, revisões e estados | 3, 9 |
| 5: conjuntos, snapshots, idempotência e falhas | 3, 7, 8, 10 |
| 6: formatos, WebP, privado/público, tráfego | 2, 5, 6, 10 |
| 7: conta, sessão, RLS, CSRF e segredos | 3, 4, 5, 10 |
| 8: HTML, metadata, sitemap, navegação | 1, 6, 10 |
| 9–10: gates, ordem, recursos e integração | todas, com gate final 10 |

A execução local deste plano foi aprovada em 2026-10-11. Executar as tarefas pela ordem prevista, com revisão e verificações antes da aceitação de cada uma. Ações cloud seguem a preparação concreta da Task 10; push, PR, merge e deploy exigem autorização explícita. O método e os modelos de `AGENTS.md` mantêm-se.

## 8. Referências técnicas consultadas

- [Vite 7 SSR](https://v7.vite.dev/guide/ssr)
- [React Router StaticRouter](https://reactrouter.com/api/declarative-routers/StaticRouter), API declarativa mantida na v7 existente; confirmar export da versão instalada na Task 1.
- [Helmet 3 e React 19](https://github.com/staylor/react-helmet-async#react-19)
- [libheif v1.23.6](https://github.com/strukturag/libheif/tree/v1.23.6), [libde265 v1.1.3](https://github.com/strukturag/libde265/tree/v1.1.3), e [Emscripten Docker guidance](https://emscripten.org/docs/building_from_source/using_docker.html); a build e os artefactos Task 2 têm provenance/licenças documentadas no runbook.
- [Netlify Functions runtime](https://docs.netlify.com/build/functions/configuration)
- [Netlify build variables](https://docs.netlify.com/build/configure-builds/environment-variables/)
- [Netlify CLI dev](https://cli.netlify.com/commands/dev/)
- [Netlify API](https://docs.netlify.com/api-and-cli-guides/api-guides/get-started-with-api/)
- [Supabase sessions](https://supabase.com/docs/guides/auth/sessions)
- [Postgres client transactions](https://node-postgres.com/features/transactions)
- [Sharp input validation](https://sharp.pixelplumbing.com/api-input/)

As versões/flags novas são propostas verificadas documentalmente, não provas executadas de compatibilidade. As Tasks 1–2 e os gates de integração produzem essa evidência antes de aceitação da implementação.
