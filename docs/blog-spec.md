# Spec — Blog editorial do JT Studio

Última revisão: 2026-10-11.

**Estado:** revisão escrita aprovada pelo utilizador em 2026-10-11. A feature ainda
não está implementada. O [plano de implementação](superpowers/plans/2026-10-11-blog-editorial.md)
está preparado e aguarda revisão do utilizador. A aprovação desta spec permite
preparar esse plano; não equivale à aprovação da execução, integração ou publicação
em produção.

Esta revisão substitui a proposta de 2026-09-15 do branch
`claude/awesome-hamilton-xizq67`. Conserva o objetivo de gerar HTML estático indexável,
mas altera o editor, a autenticação, o modelo de publicação e o tratamento de imagens.

## 1. Objetivo e critérios de sucesso

A Jaqueline deve conseguir escrever e rever artigos sobre dicas, técnicas, cuidados
e dúvidas frequentes, usando telemóvel ou computador. O iPhone é o dispositivo móvel
prioritário. O editor deve ser visual, simples e acessível.

O objetivo comercial é atrair potenciais clientes de Setúbal e da região de Lisboa.
Os artigos, em português de Portugal, devem também ser úteis a outros leitores de
língua portuguesa. Avaliar o resultado por visitas vindas das pesquisas e interesse
nos serviços, incluindo cliques para contacto ou marcação. Mais visitas não garantem,
por si só, melhores posições no Google.

A publicação deve ser eficiente: preparar dez artigos e confirmar todos os que estão
prontos deve originar uma única publicação e um único deploy em condições normais.
Gravar rascunhos, carregar fotografias e editar artigos não desencadeia deploys.

Os planos gratuitos são a preferência, não um requisito absoluto. O utilizador aceita
custos se necessários, mas quer evitar consumo e manutenção desnecessários.

## 2. Estado verificado e operação existente

Inventário consultado em 2026-10-11, apenas em leitura:

| Elemento | Estado |
|---|---|
| Produção | Site live no Netlify; segundo o utilizador, `main` faz auto-deploy |
| Git | `main` e remoto em `5749be9`; branch do Claude em `e4616c6` |
| Branch do Claude | Acrescenta apenas a spec original; não contém código do blog |
| AGENTS.md | Ficheiro físico inicialmente fora do Git; copiar fielmente para a branch de documentação |
| Aplicação | SPA React, cinco rotas: `/`, `/servicos`, `/info`, `/galeria`, `/contactos` |
| Lockfile | React/React DOM 19.2.6, React Router 7.15.0, Tailwind 4.3.0 |
| Build | Vite sobreposto por `npm:rolldown-vite@7.2.5`; plugin React SWC |
| Metadata | `react-helmet-async` 2.0.5 no cliente; JSON-LD também em `index.html` |
| Sitemap | `public/sitemap.xml` manual |
| Netlify | `_redirects` com fallback SPA e `_headers`; configuração do dashboard ainda não verificada |
| Comandos existentes | `npm run dev`, `npm run build`, `npm run lint`, `npm run preview` |
| Testes/CI | Sem script de testes; workflows presentes para Claude, sem gate de build/lint identificado |
| Supabase | Projeto existente `jt-studio`, ativo, organização Free, região `eu-west-1` |
| Supabase Database | Sem tabelas públicas nem migrações registadas |
| Supabase Auth/Storage | Zero contas Auth e zero buckets |

Não criar outro projeto Supabase para cumprir a região sugerida na spec antiga.
Os preços e quotas têm de ser verificados no plano efetivo antes da configuração.
Os números antigos de minutos de build não são uma base válida para esta decisão.

**Regra de produção:** alterações em `main` podem publicar imediatamente o site.
Trabalhar em branch e worktree isoladas. Push, PR, merge e deploy exigem autorização
explícita, segundo `AGENTS.md`. A documentação não altera estas permissões.

## 3. Arquitetura

```text
Painel /admin no iPhone ou computador
  ├─ editor visual Tiptap e pré-visualização
  ├─ otimização local dos ficheiros de imagem
  └─ pedidos autenticados para Netlify Functions
       ├─ login, sessão persistente e logout
       ├─ leitura e gravação editorial autorizadas
       ├─ preparação de media e confirmação da publicação
       └─ build hook protegido no servidor
            │
Supabase    ├─ Auth: uma conta criada manualmente
            ├─ Database: trabalho editorial e versões confirmadas
            ├─ Storage privado: media em preparação
            └─ Storage público: media aprovada e URLs permanentes
            │
Build Netlify: uma versão confirmada e imutável
  └─ HTML dos artigos, metadata, sitemap e dados públicos para navegação React
       ├─ texto e aplicação servidos pelo Netlify
       └─ imagens publicadas servidas diretamente pelo Supabase
```

A aplicação pública não consulta a base de dados durante as visitas. As imagens são
a exceção à independência do Supabase: o browser descarrega-as do Storage público.
O editor deve ser carregado apenas no painel, evitando o seu custo nas páginas públicas.

## 4. Fluxo editorial e editor

### 4.1 Editor e campos

Usar Tiptap com as funcionalidades gratuitas. Conteúdo guardado como JSON estruturado,
com um schema explícito e versionado. O servidor valida os tipos de nós, atributos,
links, referências de imagens e limites; HTML arbitrário não é um formato de entrada.

Campos do artigo: título, slug, resumo, capa, corpo e serviço relacionado. O corpo
suporta parágrafos, subtítulos, negrito, itálico, listas, links, fotografias,
texto alternativo, legenda opcional e desfazer/refazer. A pré-visualização usa as
mesmas regras de conteúdo e apresentação da página pública.

O slug é editável até à primeira confirmação de publicação. Depois fica imutável
no servidor, incluindo após despublicação. O título pode ser alterado sem mudar o URL.
O título da página é o único H1; os subtítulos do corpo começam em H2.

### 4.2 Gravação e concorrência

Guardar automaticamente após uma pequena pausa, mantendo o botão “Guardar agora”.
Mostrar “A guardar…”, “Guardado” ou “Não foi possível guardar”. Mostrar “Guardado”
apenas depois da resposta confirmada do servidor. Se falhar, manter o texto em edição
e indicar as alterações ainda por guardar.

Cada gravação usa a revisão esperada do artigo. Uma resposta tardia não pode substituir
texto mais recente; duas abas ou dispositivos não podem sobrepor alterações
silenciosamente. Perante conflito, conservar o trabalho local e pedir resolução.
Não acrescentar sincronização offline nem guardar rascunhos sensíveis em storage
persistente do browser nesta fatia.

### 4.3 Estados visíveis

- **Rascunho:** trabalho ainda não preparado para publicação.
- **Pronto para publicar:** revisão guardada e validada, explicitamente marcada.
- **Online:** revisão presente no deploy de produção verificado.
- **Com alterações pendentes:** artigo online com uma cópia editorial diferente.

Um artigo pode estar online e ter uma revisão em preparação. A interface deve mostrar
essa relação, em vez de interpretar um único campo de estado como ambas as versões.
Editar uma revisão marcada como pronta invalida a sua prontidão; é necessário voltar
a marcá-la depois de guardar e validar o novo conteúdo.

## 5. Publicação por conjuntos e versões imutáveis

### 5.1 Confirmação

O botão “Publicar alterações no site” apresenta todos os artigos prontos e as ações
preparadas sobre artigos existentes, incluindo despublicações. Na primeira versão,
confirma-se o conjunto inteiro, sem seleção parcial nessa confirmação.

O servidor verifica que a lista e as revisões correspondem às que foram apresentadas.
Se mudarem antes da confirmação, atualizar o resumo e obter nova confirmação; não
incluir silenciosamente um artigo que ficou pronto entretanto.

### 5.2 Composição da versão

Uma versão confirmada contém o conjunto público **completo**:

1. Artigos já aprovados que não tenham alterações prontas mantêm a revisão anterior.
2. Artigos novos prontos e revisões prontas substituem ou acrescentam conteúdo.
3. Despublicações explicitamente preparadas retiram os artigos correspondentes.
4. Rascunhos e revisões não marcadas como prontas ficam fora do conjunto.

Não construir o conjunto apenas com os artigos novos: isso apagaria os existentes.
Guardar uma cópia imutável do conteúdo e das referências de media, não referências
a linhas editoriais que ainda podem mudar. O identificador da versão acompanha o
build e o artefacto publicado.

### 5.3 Build, idempotência e confirmação de que ficou online

Confirmar uma publicação grava primeiro a intenção e a versão. Só depois uma operação
autorizada de servidor dispara o hook. Cliques duplicados ou repetição do pedido com
o mesmo identificador não podem criar versões ou disparar hooks adicionais.

O hook transporta o identificador da versão; o build não lê “os posts mais recentes”
em edição. A documentação Netlify permite transportar payload através de
`INCOMING_HOOK_BODY`. Builds normais de `main` também usam exclusivamente uma versão
confirmada, escolhida uma vez no início, nunca os rascunhos.

Permitir apenas uma publicação editorial em curso. Novos rascunhos continuam editáveis,
mas outra confirmação aguarda a resolução da anterior. O plano deve coordenar esta
regra com os builds de código e a concorrência real do Netlify, provando que um build
antigo não pode fazer regredir a versão pública.

Mostrar estados distintos: preparação, publicação em curso, online, falha e resultado
por confirmar. Aceitar o POST do hook não equivale a um deploy concluído. Marcar online
apenas depois de verificar um deploy de produção publicado com a versão esperada;
callbacks antigos ou provenientes de previews não podem avançar esse estado.

Uma falha do build mantém o último deploy público. Permitir repetir a versão confirmada
após uma falha demonstrada. Se a resposta do hook se perder e o resultado for ambíguo,
reconciliar o estado antes de reenviar: não prometer entrega exatamente uma vez entre
dois serviços nem criar deploys duplicados por retries cegos.

### 5.4 Leitura de dados e recuperação

Falhar o build se faltar configuração, se o Supabase não responder, ou se a versão
estiver incompleta/inválida. Não transformar erros em uma lista vazia nem recuperar
silenciosamente artigos de um snapshot antigo. Um conjunto vazio só é válido se for
uma versão explicitamente confirmada, incluindo a inicialização do blog vazio.

`published_at` pertence à primeira confirmação de publicação do artigo e conserva-se
em republicações. A data de modificação pública corresponde à revisão publicada,
não à última gravação de um rascunho. Manter as datas no servidor.

## 6. Fotografias e desempenho em ligações lentas

### 6.1 Entrada e otimização

A entrada é um ficheiro previamente guardado ou escolhido pela câmara/galeria.
Não há importação por URL de terceiros. Prever JPEG/JPG, PNG, WebP, HEIC/HEIF e AVIF,
com verificação real dos decoders nos browsers suportados. HEIC/HEIF de iPhone é um
critério de aceitação, incluindo upload pelo computador de um ficheiro do iPhone.

Antes do upload, corrigir a orientação, redimensionar, converter para WebP e comprimir.
Preservar transparência quando existir e remover metadados desnecessários, incluindo
localização. Validar que o resultado é efetivamente WebP; uma extensão `.webp` ou um
fallback silencioso do encoder não basta.

Preservar detalhes relevantes da pele e das técnicas. O plano deve definir dimensões,
qualidade e orçamento de bytes com amostras reais; não impor um tamanho de ficheiro
que degrade esses detalhes. Gerar variantes adequadas à apresentação no telemóvel e
computador e referenciá-las através de `srcset`/`sizes`, evitando ampliar imagens pequenas.

Mostrar progresso e falhas de processamento/upload. O upload só fica concluído depois
de validar formato, dimensões e tamanho no ponto de confiança. A otimização no browser
não substitui validação do servidor. Um ficheiro rejeitado não apaga o artigo.

### 6.2 Storage privado e público

Guardar as imagens de trabalho num bucket privado. O painel tem acesso autenticado ou
temporário autorizado; URLs com tokens privados não entram em versões públicas,
metadata, logs ou artefactos de build.

Ao confirmar uma versão, promover apenas o media que ela referencia para um bucket
público, com nomes/versionamento imutáveis. A confirmação autoriza tornar essas imagens
públicas; se o build falhar depois, as imagens aprovadas podem já estar acessíveis pelo
URL, embora o artigo ainda não esteja online. Rascunhos não confirmados continuam privados.

Promover apenas ficheiros novos ou alterados e reutilizar URLs públicos existentes.
Não reenviar todas as fotografias em cada deploy. Substituir uma fotografia cria uma
nova referência; não sobrepor um ficheiro usado por uma versão publicada.

Servir as imagens diretamente pelo Supabase, sem proxy Netlify ou cópia para `dist/`.
Guardar largura/altura reais e reservar o espaço na página. Carregar imagens abaixo
da zona inicial à medida que forem necessárias; a capa inicial não deve ser atrasada.

As imagens públicas consomem tráfego Supabase e dependem da sua disponibilidade.
Uma despublicação do artigo não torna automaticamente privado um URL de imagem já
partilhado. Limpeza de media e retenção de versões são operações separadas: preservar
referências de versões recuperáveis e não remover dados por iniciativa do agente.

## 7. Autenticação e autorização

Uma conta email/password, criada manualmente no Supabase, partilhada pelo casal se
necessário. O sistema não distingue qual das duas pessoas realizou uma ação.
Desativar novos registos, autenticação anónima e providers não utilizados. Não criar
fluxo de registo no site nem incluir credenciais no código/repositório.

O painel chama Netlify Functions no mesmo origin. Manter a sessão num cookie persistente
`HttpOnly`, `Secure` e `SameSite`, com expiração definida, renovação controlada e logout.
Tokens não ficam em `localStorage`, `sessionStorage`, URLs ou respostas para o JavaScript
do painel. O plano deve fixar a duração e armazenamento da sessão no servidor, com
coordenação de refresh por sessão e revogação efetiva.

Proteger operações de escrita contra CSRF e validar origin, sessão e identidade
autorizada em cada operação. Logout limpa o estado protegido e impede respostas tardias
de reconstruí-lo. Segredos de sessão, credenciais privilegiadas e URL do build hook
ficam apenas no servidor; nenhuma destas variáveis usa prefixo `VITE_`.

As policies RLS de dados e Storage restringem o acesso editorial ao UUID explicitamente
autorizado. Não usar `authenticated` com `using (true)` como autorização. As operações
editoriais usam a identidade do utilizador, preservando RLS; operações privilegiadas
de publicação são estreitas, autorizadas e não concedem acesso genérico ao painel.

Snapshots, sessões, rascunhos e publicação não são APIs públicas de escrita. Novas
tabelas precisam de RLS e dos grants adequados ao Data API efetivamente configurado.
Registar quem confirmou cada versão, quando, a versão e os resultados de publicação,
sem tokens ou passwords nos registos.

## 8. Site público, HTML e SEO

- `/blog`: capa, título, resumo e data, ordenados por primeira publicação mais recente.
- `/blog/<slug>`: artigo completo, autoria da Jaqueline, datas e ligação ao serviço.
- Link Blog na navegação e no footer, integrado no design existente.
- Conteúdo, links, title, description, canonical e metadata social presentes no HTML cru.
- JSON-LD adequado ao blog/artigo, coerente com o conteúdo e sem duplicações.
- Imagem social pública, URL absoluto e dimensões reais; verificar preview no WhatsApp.
- Sitemap a partir da mesma versão confirmada; não incluir painel nem rascunhos.
- `/admin` com `noindex`, fora do sitemap; `robots.txt` não substitui autorização.
- URLs inexistentes e artigos retirados não devem responder com uma falsa página de artigo.

Texto, listagem, metadata e sitemap devem usar exatamente a mesma versão. A navegação
client-side usa dados públicos dessa versão e não inicia consultas editoriais ao Supabase.

Preservar as cinco páginas atuais e a navegação React. Provar cedo o pre-render com
`rolldown-vite`, React 19 e a gestão de metadata. Comparar uma integração SSG adequada
com um renderer de build dedicado, usando a menor alteração comprovada que satisfaça
os contratos. Não substituir o bundler ou migrar toda a stack sem devolver a decisão
ao utilizador. Uma solução Node tem de tratar JSX, imports de assets e a renderização
React; `renderToString` isoladamente não resolve estas dependências.

Consolidar a origem de JSON-LD/metatags ao introduzir pre-render. Remover o sitemap manual
quando a geração entrar no build, sem colisões com a cópia de `public/`. Verificar que
os ficheiros HTML dos artigos ganham ao fallback SPA nos deploys de preview autorizados.

## 9. Acessibilidade, verificação e gates

Prioridade móvel, com ecrã estreito e teclado aberto. Controlos com alvos de toque
confortáveis, labels acessíveis, foco visível, contraste legível, navegação por teclado
e leitura compreensível de estados/erros. Verificar Safari no iPhone, desktop e leitor
de ecrã; emulação não substitui a verificação real do dispositivo prioritário.

O plano de implementação deve introduzir verificações proporcionais e indicar comandos
reais, fixtures, browsers, runtime e gates. TDD e delegação seguem `AGENTS.md`.

Critérios obrigatórios:

- [ ] Escrever, formatar, inserir fotografias e pré-visualizar pelo iPhone e computador.
- [ ] Gravação automática e manual corretas; erro, conflito e resposta tardia preservam texto.
- [ ] Login persiste ao fechar/reabrir o browser; logout e sessão inválida bloqueiam operações.
- [ ] Conta não autorizada e pedidos sem sessão não leem rascunhos nem alteram conteúdo/media.
- [ ] CSRF e pedidos diretos não contornam as guardas; provas falham se a guarda for removida.
- [ ] JPEG/PNG/WebP/HEIC/HEIF/AVIF reais são convertidos para WebP antes do upload.
- [ ] Orientação, transparência, detalhes relevantes e metadados são tratados corretamente.
- [ ] Fotografias de rascunhos permanecem privadas; ficheiros inválidos são rejeitados.
- [ ] Dez artigos prontos resultam em uma confirmação, uma versão e um único hook/deploy.
- [ ] Clique duplicado não duplica a publicação; resultado ambíguo do hook é reconciliado.
- [ ] Rascunho não pronto fica fora; editar durante o build não altera a versão confirmada.
- [ ] Editar artigo online mantém a versão anterior até publicar a revisão pronta.
- [ ] Um lote novo preserva artigos existentes; despublicação confirmada remove artigo/sitemap.
- [ ] Builds de código, callbacks e publicações concorrentes não fazem regredir conteúdo.
- [ ] Falha do Supabase/configuração/render não publica um blog vazio nem recupera retirados.
- [ ] HTML cru contém texto, canonical, metadata e JSON-LD corretos por artigo.
- [ ] WhatsApp mostra título/capa corretos; sitemap coincide com a versão servida.
- [ ] Navegação client-side e cinco páginas existentes continuam funcionais.
- [ ] Rede lenta carrega variantes adequadas sem saltos de layout; avaliar bytes e qualidade.
- [ ] Editor/rotas públicas cumprem a revisão de acessibilidade, incluindo teclado e leitor de ecrã.
- [ ] Gate integrado e revisão global concluídos antes de propor integração.

Nenhum destes critérios está marcado como cumprido nesta revisão documental.

## 10. Sequência para o plano de implementação

1. Confirmar runtime/Netlify, isolamento dos testes, ferramentas/modelos e comandos de gate.
2. Prova técnica inicial do HTML/metadata e conversão de fotografias reais do iPhone.
3. Modelo editorial, revisões, RLS e snapshots com testes de composição/concorrência.
4. Functions, sessão persistente, autorização e Storage, com verificações negativas.
5. Site público a partir de versão fixa, metadata, sitemap e navegação client-side.
6. Painel móvel Tiptap, autosave, upload otimizado e pré-visualização.
7. Confirmação do conjunto, hook protegido e reconciliação com o deploy real.
8. Gate integrado, revisão, documentação operacional e decisão de integração pelo utilizador.

Esta sequência orienta o próximo plano, não é autorização de execução. Só um implementador
de cada vez, com os modelos e limites definidos em `AGENTS.md`.

Antes da execução, fechar no plano: técnica SSG comprovada, decoder/encoder de imagens,
política de dimensões/bytes, mecanismo/duração da sessão, mecanismo de serialização e
confirmação de deploy, comandos de testes e ambiente isolado. Confirmar a configuração
real Netlify, Auth e eventuais variáveis já existentes sem imprimir segredos.

Não tratar retenção, limpeza de media ou políticas de recuperação como aprovadas por
este documento. Se a implementação depender delas, definir o contrato antes da ação.
Também não reativar automaticamente projetos pausados, criar outro projeto ou executar
keep-alive por iniciativa do agente. O acesso MCP permite trabalhar no âmbito autorizado,
não concede autorização genérica para deploys ou operações destrutivas.

## 11. Fontes consultadas

Documentação consultada através de Context7 e fontes oficiais durante o brainstorming:

- [Conteúdo útil para pessoas — Google](https://developers.google.com/search/docs/fundamentals/creating-helpful-content)
- [Preços Netlify](https://www.netlify.com/pricing/)
- [Preços Supabase](https://supabase.com/pricing)
- [Build hooks Netlify](https://docs.netlify.com/build/configure-builds/build-hooks/)
- [Functions API Netlify](https://docs.netlify.com/build/functions/api/)
- [Configuração Auth Supabase](https://supabase.com/docs/guides/auth/general-configuration)
- [Sessões Supabase](https://supabase.com/docs/guides/auth/sessions)
- [RLS Supabase](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Buckets Storage Supabase](https://supabase.com/docs/guides/storage/buckets/fundamentals)
- [CDN Storage Supabase](https://supabase.com/docs/guides/storage/cdn/fundamentals)
- [Editor Tiptap](https://tiptap.dev/docs/editor/getting-started/overview)
- [Browser Image Compression](https://github.com/Donaldcwl/browser-image-compression)
- [Canvas toBlob — MDN](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/toBlob)
- [Imagens responsivas — MDN](https://developer.mozilla.org/en-US/docs/Web/HTML/Guides/Responsive_images)

Tiptap está escolhido. Browser Image Compression foi consultado como candidato,
mas não foi escolhido como dependência nem resolve sozinho os formatos do iPhone.
Versões de dependências e política de runtime devem ser verificadas e fixadas no plano.
