# Spec — Blog do JT Studio (Supabase + Netlify + pre-render)

> Documento de implementação. Escrito para ser lido por uma sessão nova do Claude Code
> (ou por ti) sem contexto prévio da conversa em que foi decidido.
>
> **Estado:** planeado, nada implementado.
> **Última revisão:** 2026-09-15

---

## 1. Objetivo

Adicionar ao site um blog que a cliente (Jaqueline) possa alimentar sozinha, com texto e
fotografias, **sem tocar no repositório nem no GitHub**, e garantindo que cada post:

- É indexável pelo Google como uma página real (HTML com conteúdo, não um `<div id="root">` vazio).
- Tem preview correto quando partilhado no Instagram, WhatsApp e Facebook (`og:image`,
  `og:title` e `og:description` próprios de cada post, no HTML cru).
- Entra automaticamente no `sitemap.xml`.

O tráfego deste negócio vem maioritariamente do Instagram, por isso **os previews sociais
são tão importantes como o Google** — e os crawlers sociais não executam JavaScript de todo.

---

## 2. Estado atual do repositório (factos verificados)

| Aspeto | Situação |
|---|---|
| Framework | React 19 + Vite, SPA client-side rendered |
| Build tool | `vite` está **sobreposto por `npm:rolldown-vite@7.2.5`** via `overrides` no `package.json` |
| Routing | `react-router-dom` v7, rotas declaradas em JSX dentro de `src/App.jsx` |
| Entry point | `src/main.jsx` — `createRoot` + `HelmetProvider` + `BrowserRouter` |
| Meta tags | `src/components/SEO.jsx`, via `react-helmet-async` — **injetadas no cliente** |
| JSON-LD | Duplicado: estático em `index.html` **e** dinâmico em `SEO.jsx` |
| Sitemap | `public/sitemap.xml` estático, escrito à mão, `lastmod` fixo em `2026-05-09` |
| Redirects | `public/_redirects` com `/* /index.html 200` (fallback de SPA) |
| Headers | `public/_headers` já com cache imutável para `/assets/*` |
| Conteúdo | Estático em `src/data/*.js` (`servicesData`, `faqData`, `galleryData`) |
| Imagens | `src/assets/`, ~1.9 MB, importadas como módulos e processadas pelo Vite |
| Hosting | Netlify |

Rotas existentes: `/`, `/servicos`, `/info`, `/galeria`, `/contactos`.

---

## 3. Arquitetura escolhida

```
  Jaqueline                    Supabase Cloud                   Netlify
  ─────────                    ──────────────                   ───────
  /admin  ──login──────────►   Auth (1 utilizador)
          ──escreve post───►   Postgres: tabela posts
          ──upload fotos───►   Storage: bucket blog-images
                                      │
                               Database Webhook
                               (on UPDATE status='published')
                                      │
                                      └──POST──────────►  Build Hook
                                                               │
                                                          vite build
                                                          + fetch dos posts
                                                          + render para HTML
                                                          + gera sitemap.xml
                                                               │
                                                          CDN: /blog/<slug>/index.html
                                                          HTML estático e completo
```

**O site continua estático.** O Supabase só é consultado em duas ocasiões: no painel `/admin`
(runtime, no browser dela) e durante o build (Node, no Netlify). Os visitantes normais nunca
falam com o Supabase — recebem HTML puro do CDN do Netlify.

### Porquê esta arquitetura

- **SEO igual ao de páginas feitas à mão.** O HTML já contém o texto, as meta tags e o JSON-LD.
- **Custo zero.** Netlify free (300 min de build/mês; aqui um build são ~40 s) + Supabase free
  (500 MB DB, 1 GB Storage, 5 GB de tráfego).
- **Sem infraestrutura nova para manter.** Nada vai para a VPS — ver secção 10.
- **Performance inalterada.** Nenhum request extra em runtime para o visitante.

### Custo desta arquitetura

Publicar um post **não é instantâneo**: demora o tempo do build (~1 minuto). Isto tem de ser
comunicado à cliente, e o painel deve dizê-lo explicitamente depois de ela carregar em publicar.

---

## 4. Modelo de dados

### 4.1 Tabela `posts`

```sql
create table public.posts (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique,
  title         text not null,
  excerpt       text,                       -- usado na listagem e na meta description
  content       text not null,              -- Markdown
  cover_url     text,                       -- URL público do Supabase Storage
  cover_alt     text,                       -- obrigatório na UI; acessibilidade + SEO
  cover_width   int,                        -- guardado no upload, evita CLS
  cover_height  int,
  status        text not null default 'draft'
                check (status in ('draft', 'published')),
  published_at  timestamptz,                -- preenchido na 1ª publicação, nunca reescrito
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index posts_published_idx
  on public.posts (published_at desc)
  where status = 'published';
```

`updated_at` deve ser mantido por trigger, não pelo cliente:

```sql
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger posts_touch_updated_at
  before update on public.posts
  for each row execute function public.touch_updated_at();
```

### 4.2 RLS (obrigatório)

```sql
alter table public.posts enable row level security;

-- Qualquer pessoa (e o build) lê apenas posts publicados
create policy "posts_public_read"
  on public.posts for select
  to anon, authenticated
  using (status = 'published');

-- Só utilizadores autenticados escrevem (há apenas uma conta: a da Jaqueline)
create policy "posts_authenticated_write"
  on public.posts for all
  to authenticated
  using (true) with check (true);
```

> Nota: como só existe **uma** conta, `using (true)` para `authenticated` é aceitável. Se
> algum dia houver mais do que um autor, trocar por `auth.uid() = author_id` e acrescentar
> a coluna `author_id`.

### 4.3 Storage

Bucket `blog-images`, **público para leitura**:

```sql
insert into storage.buckets (id, name, public)
values ('blog-images', 'blog-images', true);

create policy "blog_images_public_read"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'blog-images');

create policy "blog_images_authenticated_write"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'blog-images');

create policy "blog_images_authenticated_delete"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'blog-images');
```

### 4.4 Autenticação

- Criar **um único utilizador** manualmente no dashboard do Supabase (email + password).
- **Desativar sign-ups** em Authentication → Settings → "Allow new users to sign up: OFF".
  Sem isto, qualquer pessoa que descubra o `/admin` e as chaves públicas pode criar conta e,
  pela policy acima, escrever posts.
- Não ativar nenhum provider social.

---

## 5. Fases de implementação

Cada fase deve ficar funcional e commitável por si. Sugiro um commit por fase.

### Fase 0 — Preparação

1. Criar projeto no Supabase Cloud (região: Frankfurt / `eu-central-1`, a mais próxima).
2. Aplicar o SQL das secções 4.1 a 4.3 (migração, não cliques no dashboard — guardar em
   `supabase/migrations/` para haver histórico).
3. Criar o utilizador e desativar sign-ups.
4. Instalar `@supabase/supabase-js`.
5. Criar `.env.local` (já coberto por `*.local` no `.gitignore`):

```
VITE_SUPABASE_URL=https://xxxx.supabase.co
VITE_SUPABASE_ANON_KEY=<publishable / anon key>
```

> ⚠️ **Nunca** usar a `service_role` key em nada com prefixo `VITE_`. Tudo o que tem esse
> prefixo é inlined no bundle e fica público. A anon key é feita para ser pública — é a RLS
> que protege os dados.

6. Registar as mesmas variáveis no Netlify (Site settings → Environment variables). Elas
   **não** vêm do `.env.local`; se faltarem, o build passa mas o blog fica vazio.

### Fase 1 — Cliente e leitura

- `src/lib/supabase.js` — cria e exporta o client.
- `src/lib/posts.js` — funções `getPublishedPosts()` e `getPostBySlug(slug)`.
  Estas funções têm de correr **tanto no browser como em Node durante o build**, por isso
  nada de `window`/`document` lá dentro.
- Rotas novas em `src/App.jsx`: `/blog` (listagem) e `/blog/:slug` (post).
- `src/pages/Blog.jsx` e `src/pages/BlogPost.jsx`.
- Link "Blog" no `NavBar` (array `links`) e no `Footer`.
- Renderização do Markdown: `react-markdown` + `remark-gfm`. **Não** usar
  `dangerouslySetInnerHTML` com HTML cru — ver armadilha 8.

### Fase 2 — Pre-render (a parte crítica)

Esta é a fase que justifica toda a arquitetura e a que tem mais risco técnico. Ler a
armadilha 1 **antes** de começar.

**Plano A — `vite-react-ssg`**

1. Extrair as rotas de `src/App.jsx` para um array de configuração (`src/routes.jsx`).
2. Substituir `src/main.jsx` por `ViteReactSSG(...)`.
3. Implementar `getStaticPaths()` na rota `/blog/:slug`, indo buscar os slugs ao Supabase.
4. Ajustar o `SEO.jsx` — ver armadilha 2.
5. `npm run build` deve produzir `dist/blog/<slug>/index.html` com o texto do post visível
   em `curl`.

**Plano B — script próprio de pre-render (fallback se o A falhar)**

Um script `scripts/prerender.mjs` que corre depois do `vite build`:

1. Vai buscar os posts ao Supabase.
2. Para cada rota, usa `renderToString` do `react-dom/server` com um `StaticRouter`.
3. Injeta o resultado no `dist/index.html` (substituindo `<div id="root"></div>`) e escreve
   `dist/<rota>/index.html`.
4. Injeta também as meta tags e o JSON-LD no `<head>` desse ficheiro.

O Plano B é mais trabalho manual mas é totalmente independente do ecossistema de plugins do
Vite — imune ao problema do `rolldown-vite`.

### Fase 3 — Geração do sitemap

Script `scripts/generate-sitemap.mjs`, corrido no build:

- Rotas estáticas: as 5 atuais + `/blog`.
- Rotas dinâmicas: um `<url>` por post publicado, com `lastmod` = `updated_at` do post.
- Escreve para `dist/sitemap.xml`.
- **Apagar `public/sitemap.xml`** — senão o Vite copia-o para `dist/` e há uma corrida entre
  o ficheiro estático e o gerado (ver armadilha 5).

### Fase 4 — Painel `/admin`

- Rota `/admin`, **excluída do pre-render** e com `<meta name="robots" content="noindex, nofollow">`.
- Acrescentar `Disallow: /admin` ao `public/robots.txt`.
- Login com `supabase.auth.signInWithPassword`.
- Lista de posts (rascunhos e publicados), com editar / publicar / despublicar / apagar.
- Editor: título, slug (auto-gerado a partir do título, editável **só** enquanto for rascunho
  — ver armadilha 7), excerto, capa, texto em Markdown com pré-visualização.
- Upload de imagens: **comprimir e converter para WebP no browser antes de enviar**
  (`canvas` ou `browser-image-compression`), com largura máxima de ~1600 px. Isto poupa
  storage, poupa tráfego, e evita depender das Image Transformations do Supabase
  (ver armadilha 4). Guardar `width`/`height` na tabela no momento do upload.
- Depois de publicar, mostrar uma mensagem clara: *"O post está a ser publicado. Fica visível
  no site dentro de cerca de 1 minuto."*

### Fase 5 — Automação do rebuild

1. No Netlify: Site settings → Build & deploy → Build hooks → criar hook, copiar o URL.
2. No Supabase: Database → Webhooks → novo webhook na tabela `posts`,
   eventos `INSERT`, `UPDATE`, `DELETE`, método `POST` para o URL do build hook.
3. **Filtrar**: só deve disparar quando algo relevante para o site público muda. Um webhook
   em todos os `UPDATE` dispara também em cada gravação de rascunho e queima build minutes.
   Se a UI do webhook não permitir a condição, implementar como trigger SQL que só chama
   `net.http_post` quando `new.status = 'published' or old.status = 'published'`.
4. Deixar um botão "Forçar republicação" no `/admin` que chama o build hook diretamente, para
   quando o webhook falhar silenciosamente.

### Fase 6 — SEO por post

Cada `/blog/<slug>` tem de sair do build com:

- `<title>` e `<meta name="description">` próprios (excerto do post).
- `<link rel="canonical" href="https://jaquelinetakiutistudio.com/blog/<slug>">`.
- `og:type` = `article` (o `SEO.jsx` atual tem `website` fixo — tornar configurável).
- `og:image` = a capa do post, em URL **absoluto**. Previews sociais ignoram URLs relativos.
- `og:image:width` / `og:image:height` reais — o `SEO.jsx` atual tem `1200`/`630` hardcoded,
  o que estará errado para as capas dos posts.
- JSON-LD `BlogPosting` com `headline`, `image`, `datePublished`, `dateModified`,
  `author` e `publisher`.
- Na página `/blog`, JSON-LD `Blog` com a lista de posts.

---

## 6. Armadilhas (ler antes de escrever código)

### 1. `rolldown-vite` pode partir o `vite-react-ssg` 🔴 risco mais alto

O `package.json` tem `"vite": "npm:rolldown-vite@7.2.5"` em `dependencies` **e** em
`overrides`. O `rolldown-vite` é a variante experimental do Vite com bundler em Rust; plugins
que dependem de internals do Rollup ou da API de SSR do Vite podem simplesmente não funcionar.

**Validar isto na primeira hora de trabalho**, antes de refatorar seja o que for: instalar o
`vite-react-ssg`, pôr **uma** rota estática a gerar HTML, confirmar que passa. Se falhar, há
duas saídas:
- Remover o override e voltar ao Vite oficial (verificar que o build continua a passar), ou
- Ir para o Plano B da Fase 2 (script próprio com `renderToString`), que não depende de plugins.

Não avançar para as fases seguintes com esta questão em aberto.

### 2. `react-helmet-async` vs. o `<Head>` do `vite-react-ssg`

O `vite-react-ssg` traz o seu próprio componente `Head` e é isso que ele consegue serializar
para o HTML estático. Meta tags postas via `react-helmet-async` podem continuar a ser
injetadas **só no cliente** — ou seja, o pre-render corre, o HTML sai, e as meta tags
continuam invisíveis para os crawlers. Seria o pior resultado possível: todo o trabalho feito
e o problema original por resolver.

O `src/components/SEO.jsx` é usado por **todas** as páginas, por isso esta migração afeta o
site inteiro, não só o blog.

**Critério de aceitação, não negociável:**
```bash
npm run build
grep -o '<meta property="og:image"[^>]*>' dist/blog/<slug>/index.html
```
Se isto não devolver o URL da capa do post, a Fase 2 não está feita.

### 3. Free tier do Supabase pausa o projeto ao fim de ~7 dias sem atividade

Se o projeto pausar, o `fetch` durante o build não responde e **o blog desaparece do deploy**
— silenciosamente, se o código apanhar a exceção e devolver `[]`.

Mitigações, aplicar as três:
- O build **falha em voz alta** (`process.exit(1)`) se o fetch dos posts der erro. Melhor um
  deploy falhado e visível do que um deploy com o blog vazio.
- Netlify Scheduled Function semanal que faz um `select` trivial e mantém o projeto acordado.
- Guardar um snapshot em `src/data/posts-fallback.json`, atualizado a cada build bem
  sucedido, para nunca haver um deploy com zero posts.

### 4. Image Transformations do Supabase podem não estar no plano gratuito

Não assumir que `?width=800` funciona no URL do Storage. **Resolver no upload**: comprimir,
redimensionar e converter para WebP no browser antes de enviar. Beneficia o storage, o
tráfego e o tempo de carregamento, e não depende de plano nenhum.

### 5. `public/sitemap.xml` colide com o sitemap gerado

O Vite copia tudo o que está em `public/` para `dist/`. Se o script de geração correr antes
dessa cópia, o ficheiro gerado é sobreposto pelo estático (que tem `lastmod` fixo em
`2026-05-09` e não conhece os posts). **Apagar `public/sitemap.xml` na Fase 3.**

### 6. JSON-LD duplicado

O schema `BeautySalon` está em `index.html` (estático) **e** em `SEO.jsx` (via Helmet). Hoje
o Google tolera. Depois do pre-render, o mesmo bloco fica literalmente duas vezes no HTML de
todas as páginas. Escolher um sítio só — recomendo manter apenas o do `SEO.jsx`, que passa a
ser pre-renderizado de qualquer forma — e remover o outro.

### 7. Slugs são URLs permanentes

Se ela renomear um post publicado e o slug mudar, o URL antigo passa a 404 e perde-se o que
o Google já tivesse indexado, além de partir links já partilhados no Instagram.

Regra: **o slug fica bloqueado assim que `status` passa a `published`.** No editor, o campo
fica read-only. Se algum dia for mesmo preciso mudar, acrescentar um `301` ao `_redirects`.

### 8. Markdown e XSS

Mesmo com uma única autora, renderizar Markdown com HTML embutido via
`dangerouslySetInnerHTML` é um risco desnecessário. Usar `react-markdown` sem
`rehype-raw`, ou com `rehype-sanitize`. Nota extra: isto corre também durante o build
(em Node), portanto qualquer falha aqui parte o deploy, não só a página.

### 9. Tráfego das imagens conta para a quota do Supabase

Imagens servidas a partir do Storage consomem os 5 GB/mês do free tier — ao contrário das
imagens servidas pelo Netlify, que não têm essa restrição. Com um blog pequeno não é
problema, mas se um post correr bem no Instagram pode ser.

Otimização opcional (fazer só se a quota apertar): descarregar as imagens durante o build
para `dist/blog-media/` e reescrever os URLs. O Supabase passa a ser só a origem; o tráfego
real fica todo no CDN do Netlify.

### 10. O fallback de SPA do `_redirects`

O `public/_redirects` tem `/* /index.html 200`. O Netlify serve ficheiros estáticos com
prioridade sobre rewrites não forçados, por isso `dist/blog/<slug>/index.html` deve ganhar.
**Confirmar mesmo assim** com `curl` a um post depois do primeiro deploy: se vier o HTML
genérico do `index.html` em vez do post, o pre-render está a ser contornado e o SEO não existe.

### 11. O webhook falha em silêncio

Se o build hook der erro, o Supabase não reclama e ela fica convencida de que publicou.
O botão "Forçar republicação" da Fase 5 é o remédio. Vale a pena mostrar no `/admin` a data
do último deploy bem sucedido, para ela conseguir confirmar sozinha.

### 12. Variáveis de ambiente do Netlify

Têm de ser configuradas no dashboard. O `.env.local` não é commitado (e ainda bem). Sem elas,
o build não estoira necessariamente — apenas produz um site sem blog.

### 13. Fotografias de clientes e RGPD

O site já tem Cookiebot, portanto a parte de cookies está tratada. Mas posts com fotografias
de clientes reais precisam de consentimento explícito para publicação online. Não é uma
questão técnica, é uma questão a levantar com a cliente antes de o blog ir para o ar.

### 14. Build minutes

300 minutos/mês no free tier, ~40 s por build ≈ 450 builds. Folgado — **desde que** o webhook
não dispare a cada gravação de rascunho (armadilha coberta na Fase 5, ponto 3).

---

## 7. Checklist de aceitação

Marcar só o que estiver verificado à mão, não o que "devia funcionar":

- [ ] `curl https://<site>/blog/<slug>` devolve o texto do post no HTML, sem executar JS.
- [ ] Esse mesmo HTML contém `og:image` com o URL absoluto da capa **do post**.
- [ ] Esse mesmo HTML contém JSON-LD `BlogPosting` válido
      (validado no Rich Results Test do Google).
- [ ] `https://<site>/sitemap.xml` inclui `/blog` e todos os posts publicados,
      com `lastmod` correto.
- [ ] Partilhar um link de post no WhatsApp mostra a capa e o título desse post.
- [ ] Publicar um post no `/admin` dispara um deploy no Netlify sem intervenção manual.
- [ ] Um post em rascunho **não** aparece no site nem no sitemap.
- [ ] `/admin` não está no sitemap, tem `noindex`, e está no `Disallow` do `robots.txt`.
- [ ] Um utilizador não autenticado não consegue escrever na tabela `posts`
      (testar com a anon key diretamente).
- [ ] Sign-ups estão desativados no Supabase.
- [ ] Lighthouse nas páginas existentes não regrediu depois da migração para pre-render.
- [ ] As 5 páginas atuais continuam a funcionar, incluindo navegação client-side entre elas.

---

## 8. Ordem de trabalho sugerida

1. **Fase 2, Plano A, prova de conceito** — uma rota estática a pre-renderizar com o
   `rolldown-vite` (armadilha 1). Decidir A ou B **aqui**.
2. Fase 0 (Supabase) + Fase 1 (leitura e rotas) — com dois posts inseridos à mão via SQL,
   sem painel nenhum.
3. Fase 2 a sério + Fase 3 (sitemap). Neste ponto o SEO já está resolvido.
4. Fase 6 (meta tags e JSON-LD por post). Validar tudo na checklist da secção 7.
5. Fase 4 (painel `/admin`).
6. Fase 5 (webhook). Última, porque até aqui os rebuilds podem ser manuais.

A ordem é deliberada: o risco técnico está todo no início e a parte de UI, que é a mais
demorada e a menos incerta, fica para o fim. Se o passo 1 correr mal, só se perdeu uma hora.

---

## 9. Ficheiros afetados

**Novos**
```
src/lib/supabase.js
src/lib/posts.js
src/pages/Blog.jsx
src/pages/BlogPost.jsx
src/pages/Admin.jsx            (+ componentes do editor)
src/routes.jsx                 (se Plano A)
scripts/generate-sitemap.mjs
scripts/prerender.mjs          (se Plano B)
supabase/migrations/*.sql
```

**Modificados**
```
src/main.jsx                   entry point do SSG
src/App.jsx                    rotas novas
src/components/SEO.jsx         og:type, dimensões de imagem, BlogPosting, possível migração de Helmet
src/components/NavBar.jsx      link do blog
src/components/Footer.jsx      link do blog
index.html                     remover JSON-LD duplicado
public/robots.txt              Disallow: /admin
package.json                   dependências novas, scripts de build
```

**Removidos**
```
public/sitemap.xml             passa a ser gerado
```

---

## 10. Nota sobre a VPS (decisão já tomada)

Foi ponderado alojar este site na VPS (2 cores, 4 GB RAM) que corre o projeto de SaaS.
**Decisão: não.**

Capacidade nunca foi o problema — um site estático em nginx consome uns 20–30 MB de RAM e
praticamente nenhum CPU, mesmo ao lado do SaaS. O problema é o que se perde: o Netlify já dá
CDN global, TLS automático, deploy previews, rollbacks e build hooks, de graça e sem
manutenção. Migrar para a VPS troca isso por gestão de certificados, backups, uptime, e um
ponto único de falha partilhado com o projeto comercial — se a VPS cair por causa do SaaS,
cai também o site da cliente.

Onde a VPS **seria** de facto insuficiente é a self-hostar o Supabase: o stack completo
(Postgres, GoTrue, PostgREST, Realtime, Storage, Kong, Studio) pede facilmente mais de 2 GB
de RAM, o que espremeria a máquina ao lado do SaaS. Daí a escolha de Supabase Cloud.

---

## 11. Alternativa que foi rejeitada (para referência)

**CMS git-based (Sveltia CMS ou Decap CMS).** Painel visual em `/admin` que, em vez de
escrever numa base de dados, faz commit de Markdown e imagens no próprio repositório via
GitHub OAuth; o commit dispara o rebuild do Netlify automaticamente.

Vantagens: zero backend, zero base de dados, nada que possa pausar por inatividade, menos
peças a manter a longo prazo.

Desvantagens: o repositório cresce com as fotografias, e a cliente precisaria de uma conta
GitHub.

Continua a ser uma opção defensável se, a meio da implementação, a complexidade do Supabase
não estiver a compensar. A Fase 2 (pre-render) é **exatamente a mesma** nas duas abordagens,
por isso o trabalho de maior risco não se perde se houver mudança de ideias.
