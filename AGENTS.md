# AGENTS.md

Regras de colaboração, execução e verificação para este repositório. Os detalhes de produto, stack, ambientes e comandos devem ser obtidos na configuração e documentação confirmadas do projeto. Os modelos e papéis dos agentes são os definidos neste ficheiro e mantêm-se entre projetos, salvo nova instrução explícita do utilizador.

As regras dependentes de servidor, autenticação, persistência, containers, i18n, CI ou delegação aplicam-se apenas quando esses elementos existirem. Este ficheiro não obriga a introduzi-los nem concede permissões especiais de execução.

## Retoma local do blog editorial

Execução retomada por pedido do utilizador em 12 de outubro de 2026, após a pausa
por limite de utilização. Ler primeiro [docs/blog-handoff.md](docs/blog-handoff.md),
[docs/blog-development.md](docs/blog-development.md) e o plano aprovado aí referido;
reconciliar Git, diff local, ledger, processos e dados protegidos antes de testes.
Etapas 1–5 aceites localmente. As correções da etapa 5 estão no commit assinado
`5628d93`, com novos gates e revisão independente concluídos. Em 13 de outubro de 2026, o utilizador autorizou avançar com a etapa 6: páginas
públicas, HTML estático e SEO, conforme o plano aprovado. Etapas 7–10 não iniciadas.
O plano local de dez etapas está aprovado; push, PR, merge, deploy e alterações
cloud continuam a exigir autorização explícita. Este apontador não altera as
regras de colaboração, execução, modelos ou permissões deste ficheiro.

## Colaboração

- Comunicar em português de Portugal, mantendo os termos técnicos no idioma original.
- Explicar decisões e trade-offs antes de implementar. Fazer uma pergunta de descoberta de cada vez quando faltar uma decisão material; não pedir autorização para cada decisão local já abrangida pelo plano aprovado.
- Distinguir decisões confirmadas, propostas, riscos e questões em aberto. Não apresentar pressupostos como requisitos aprovados.
- Não iniciar outra fatia, escolher novas dependências, fazer merge ou push, criar PR, executar deploy, descartar trabalho ou remover dados persistentes sem autorização explícita.
- Preservar alterações do utilizador e ficheiros fora do âmbito. Uma falha ou bloqueio não autoriza limpar a árvore de trabalho nem reverter alterações alheias.
- Avaliar resultados com evidência das verificações e revisão proporcionais ao risco. Relatar limitações e verificações não executadas, sem confundir conclusão do implementador com aceitação da tarefa.

## Arranque e fontes de verdade

1. Ler este ficheiro e as instruções aplicáveis à área de trabalho. Consultar o estado atual e as instruções de arranque, quando existirem.
2. Num repositório Git, confirmar branch, worktrees, alterações locais e relação com o remoto e o CI. Identificar trabalho existente antes de alterar ficheiros.
3. Identificar a tarefa ou fatia ativa, o plano aprovado, o âmbito e os critérios de aceitação. Ler as secções relevantes de produto, arquitetura e especificações.
4. Antes de implementar, delegar ou executar gates, consultar os comandos de desenvolvimento e verificação, os runbooks relevantes e eventuais regras complementares de workflow. Se houver execução em curso, consultar o respetivo ledger ou registo de execução.
5. Tratar resultados, SHAs, PRs e inventários como estado operacional. Histórico não é uma tarefa pendente; consultar arquivos apenas quando forem relevantes.
6. Quando faltar informação, indicar a lacuna e resolver as decisões materiais antes da ação afetada. Não inventar documentos, caminhos, comandos, arquitetura ou aprovações.

Num projeto novo, confirmar primeiro o objetivo, o âmbito, as restrições e as decisões técnicas necessárias ao trabalho. Usar a documentação existente quando possível; não criar uma estrutura documental extensa apenas para cumprir este ficheiro.

## Produto e arquitetura

- Seguir o âmbito e os contratos confirmados. Não acrescentar funcionalidades, generalizações ou refactoring sem relação com a tarefa aprovada.
- Respeitar a arquitetura, a organização do código e as convenções existentes. Não introduzir outra arquitetura ou alterar substancialmente a estratégia sem devolver a decisão ao coordenador e obter as aprovações necessárias.
- Preservar os limites entre componentes. Não introduzir dependências circulares nem acessos que contornem interfaces ou contratos definidos.
- Obter versões e dependências nos manifests, lockfiles e ficheiros de runtime efetivamente usados pelo projeto. Não assumir versões, package managers ou ferramentas de outro repositório.
- Manter contratos de API, schemas e verificações de compatibilidade sincronizados quando existirem. Alterações de dependências e lockfiles devem ser justificadas e revistas.

## Documentação e operação

- Quando uma decisão depender de biblioteca, framework, SDK, API, CLI ou serviço cloud, consultar documentação adequada à versão utilizada. Usar Context7 quando disponível, com `resolve-library-id` antes de `query-docs`, respeitando as suas instruções e exceções; quando indisponível, recorrer à documentação oficial relevante e declarar limitações de acesso.
- Para informação temporalmente instável, incluindo preços, legislação ou obrigações regulatórias, consultar fontes atuais e primárias. Não apresentar informação não verificada como atual ou confirmada.
- Atualizar documentos duráveis quando uma decisão ou estado for confirmado. Guardar logs, prompts e detalhe transitório numa localização temporária ou ignorada pelo Git, segundo as convenções do projeto.
- Antes de operações que afetem containers, bases de dados ou storage locais, ler o runbook aplicável e identificar recursos protegidos, em uso ou reservados.
- Limpeza automática só pode abranger recursos descartáveis da própria execução de testes e exige autorização do projeto para essa operação. Remoção adicional exige aprovação dos recursos concretos; este ficheiro não autoriza apagar volumes ou dados persistentes.
- Seguir os runbooks de desenvolvimento, verificação e release. Um ambiente local funcional ou CI verde não equivale a deployment.

## Segurança, dados e outros invariantes

- Aplicar menor privilégio no ponto de confiança do sistema, nunca apenas na interface. Quando existir servidor, validar aí identidade e permissões.
- Em sistemas multi-tenant, validar o contexto de acesso, o vínculo e as permissões efetivas em cada operação. Identificadores identificam; não autorizam. Links sensíveis devem respeitar os mecanismos de proteção, limitação e expiração definidos pelo projeto.
- Impedir a exposição de dados internos, dados sensíveis e segredos em superfícies públicas, payloads, URLs, logs ou artefactos. Não guardar segredos no repositório ou em imagens de containers, nem os imprimir em falhas de testes.
- Respeitar os contratos de autenticação, sessão e auditoria. Em aplicações web, não guardar tokens de sessão em `localStorage`; respeitar as proteções de cookies e CSRF quando aplicáveis. Operações sensíveis e intervenções administrativas devem ter a auditoria exigida pelo projeto. Respostas ambíguas que afetem autorização ou confidencialidade devem ser tratadas de forma fail-closed.
- Quando houver sessão e dados locais sensíveis, limpar o estado protegido no logout e impedir que respostas tardias ou caches o reconstituam.
- Quando existir sincronização offline com servidor, este mantém-se a fonte de verdade. Comandos devem ser idempotentes, revalidar autorização e ter estados explícitos; conflitos não são aplicados silenciosamente.
- Em ambientes com containers, separar recursos descartáveis de volumes persistentes, não executar a aplicação como root e não expor publicamente serviços de dados que devam permanecer privados.
- Tratar migrações como tarefa explícita de release. Para dados persistentes que exijam recuperação, assegurar backups cifrados e restaurações testadas de acordo com o contrato operacional do projeto.
- Obter políticas de retenção, RPO, RTO e condições de produção nas decisões confirmadas do projeto. Não importar prazos, garantias ou autorizações de outro contexto.

## Execução e delegação

### Modelos fixos do workflow

- **Orchestrator/coordenador: GPT Sol 6.1 High**, com esforço `high`. É responsável por requisitos, investigação, planeamento, delegação, avaliação, revisão, re-planning e escalation. Confirmar na ferramenta o identificador correspondente à versão 6.1 antes do lançamento; não adivinhar esse identificador nem selecionar outra versão por iniciativa própria.
- **Implementador preferencial: Gemini Flash 3.8 High**, com identificador `gemini-3.8-flash-high`, via **Antigravity CLI (`agy`)**. Usar este modelo enquanto estiver disponível.
- **Implementador fallback: GPT Luna 6 High** (`gpt-6-luna`, esforço `high`). Usar por indisponibilidade, quota ou rate limit do Gemini, transmitindo o estado existente para continuar a mesma tarefa sempre que possível.
- **Escalation: GPT-6 Astra Medium** (`gpt-6-astra`, esforço `medium`). Usar quando o Sol não conseguir resolver o problema, segundo as regras de recuperação abaixo. Astra reavalia o problema independentemente e a partir dos fundamentos para definir uma estratégia de recuperação.
- Definir explicitamente o modelo e o esforço ao lançar agentes, através das opções suportadas pela ferramenta. Não depender de defaults nem substituir estes modelos por perfis genéricos. Não usar Astra High ou superior sem nova instrução explícita do utilizador.

### Papéis, isolamento e autonomia

- Executar cada plano aprovado numa branch e worktree isoladas quando o projeto usar Git. Se o ambiente não permitir esse isolamento, explicitar a limitação e acordar a alternativa antes de implementar; não misturar silenciosamente o trabalho com alterações existentes.
- Uma tarefa e um implementador de cada vez. Não ter implementadores concorrentes sobre a mesma árvore nem iniciar outra fatia por iniciativa própria.
- O coordenador é o GPT Sol 6.1 High. Compreende requisitos, investiga o código quando necessário, define o plano, delega, avalia resultados e falhas, revê alterações relevantes e decide re-planning e escalation. Decisões de âmbito, arquitetura e estratégia pertencem ao Sol, dentro das autorizações do utilizador.
- Gemini e Luna têm o papel de implementador, não de orchestrator. Recebem o plano do Sol e devolvem-lhe os resultados; não alteram unilateralmente o âmbito, a arquitetura ou a estratégia.
- Na indisponibilidade, quota ou rate limit do Gemini via `agy`, usar GPT Luna 6 High e transmitir o estado existente para continuar o trabalho. Trocar de provider não é falhar a abordagem, não consome um re-plan e não provoca escalation para Astra por si só.
- Sem delegação disponível ou sem acesso aos modelos definidos para a etapa, declarar a limitação e acordar a alternativa com o utilizador. Não escolher outro modelo silenciosamente, simular subagentes ou apresentar autorrevisão como revisão independente.
- Dar ao implementador objetivo, plano, contratos, critérios de aceitação, âmbito de alteração, verificações e limites. Transmitir contexto suficiente, não o histórico integral.
- Dentro do plano aprovado, Gemini e Luna podem explorar ficheiros relacionados, preparar o ambiente, fazer alterações locais, executar testes, lint, typecheck e outras verificações, diagnosticar falhas locais e corrigir o próprio diff.
- Um erro fundamental no plano, uma limitação arquitetural importante ou uma mudança substancial de âmbito exige devolver o problema ao coordenador antes de alterar a estratégia. A autonomia local não autoriza novas dependências nem operações reservadas ao utilizador.

### Implementação, revisão e recuperação

- Implementar por TDD. Fazer autorrevisão e, em projetos Git, criar commit local com `Signed-off-by`, seguindo a identidade e a política do repositório, sem atribuir o assistente.
- O implementador devolve o diff, as verificações executadas, os resultados e as limitações quando considerar a tarefa concluída. O coordenador confirma se o objetivo original foi cumprido.
- Para alterações triviais e de baixo risco, o coordenador pode aceitar a autorrevisão e as validações do implementador sem revisão profunda do diff. Para alterações substanciais, transversais, arquiteturais, sensíveis à segurança ou com risco elevado de regressão, fazer revisão independente das alterações relevantes e repetir as verificações necessárias.
- Depois de corrigir achados, repetir a verificação e a revisão afetadas. No fim de uma fatia relevante, executar o gate integrado e a revisão global antes de apresentar opções de integração.
- Uma falha da abordagem só conta depois de o implementador ter tido oportunidade razoável de implementar, testar, diagnosticar e corrigir. Erros locais corrigíveis de código, testes, lint ou tipos não consomem re-plans.
- Após a primeira e a segunda falhas reais da abordagem, o Sol analisa a causa e o que foi aprendido, reconsidera pressupostos, produz um novo plano e delega novamente, salvo se a escalation antecipada já se justificar. São permitidos no máximo dois re-plans de recuperação.
- Após a terceira falha real, o Sol deve interromper as tentativas equivalentes e escalar obrigatoriamente para GPT-6 Astra Medium (`gpt-6-astra`, esforço `medium`). Se Astra não estiver disponível, apresentar o bloqueio ao utilizador; não substituir a escalation por uma quarta variação da mesma abordagem.
- Quando o Sol não conseguir resolver o problema, escalar para GPT-6 Astra Medium. A escalation pode ocorrer antes de esgotar os dois re-plans quando complexidade arquitetural, debugging difícil ou não determinístico, concorrência, problemas transversais, repetição do mesmo bloqueio ou risco elevado o justifiquem. Registar a razão no ledger ou registo equivalente.
- Na escalation, o Sol fornece ao Astra objetivo, requisitos, estado relevante do código, plano inicial, re-plans existentes, alterações, testes, erros, hipóteses testadas e causas conhecidas ou suspeitas. Astra deve reavaliar o problema independentemente e a partir dos fundamentos antes de definir uma estratégia de recuperação, não executar simplesmente mais uma tentativa.
- Não usar Astra High ou superior sem nova instrução explícita do utilizador. Não alterar os restantes modelos, esforços ou limites de custo aprovados sem nova autorização explícita.

### Ferramentas de delegação e permissões

- Para o implementador Gemini Flash 3.8 High, usar Antigravity CLI (`agy`) na worktree da tarefa. A indisponibilidade deste caminho ativa o fallback para GPT Luna 6 High, não a escolha de outro modelo por iniciativa própria.
- Seguir as instruções da ferramenta realmente disponível. Flags de CLI, regras de sandbox e permissões concedidas num ambiente não são transferíveis automaticamente para outro.
- Não usar flags de bypass de permissões por defeito. Uma autorização específica de execução não elimina as aprovações do ambiente nem alarga o âmbito da tarefa.
- Iniciar cada tarefa com contexto próprio. Quando a ferramenta suportar sessões, guardar o identificador e reutilizá-lo apenas para correções ou continuação da mesma tarefa.
- Executar no diretório de trabalho correto. Guardar prompts, relatórios e logs completos em ficheiros transitórios; usar quoting seguro ou APIs de subprocessos ao passar argumentos.
- Verificar estado de execução, ações recusadas, ficheiros, diff, testes e, quando aplicável, commit, `Signed-off-by` e parent. Um estado `SUCCESS` isolado não prova conclusão.
- Não usar `chmod`, `sudo` ou configurações globais para contornar a sandbox. Perante uma limitação de permissões, identificar o bloqueio e seguir o mecanismo de aprovação suportado.
- Quando houver agentes em execução assíncrona, aguardar pelo menos 15 minutos antes de consultas ativas de progresso e entre consultas. Notificações automáticas podem ser tratadas imediatamente.

## Verificação e testes

- Usar os comandos e o ambiente reais do projeto. Executar testes focados durante a implementação, verificações afetadas após alterações e o gate integrado final da fatia. Repetir gates já verdes apenas quando alterações, falhas ou dúvidas relevantes o exigirem.
- Executar cedo os novos cenários; não deixar a primeira execução real para o gate final. Manter runtime, configuração e artefactos de que os testes dependem estáveis durante E2E.
- Quando houver i18n, atualizar e verificar os catálogos ao alterar texto visível, respeitando os idiomas suportados, os comandos e a política de ficheiros gerados do projeto.
- Tornar explícitas as precondições dos testes. Normalizar preferências e dados necessários pelos mecanismos aprovados; não depender acidentalmente de idioma, viewport, ordem de execução ou histórico vazio.
- Gerir caches e sessões de teste segundo o seu ciclo de vida. Não contornar guardas de segurança nem aumentar limites para ocultar falhas de setup ou seletores.
- Provas de segurança devem falhar quando a guarda correspondente é removida. Provas de confidencialidade devem abranger as superfícies relevantes, incluindo URLs, storage, histórico, logs e artefactos, sem expor segredos nos resultados.
- Esperar pela conclusão real de pedidos e callbacks. Uma cache vazia ou um consumidor abortado não demonstram que a operação terminou nem que os seus efeitos no transporte, cookies ou servidor foram impedidos.
- Em verificações assíncronas, preservar o contexto original e revalidar a sua validade antes de aplicar resultados. Não recapturar autoridade nem repetir escritas automaticamente para ocultar invalidações ou respostas ambíguas.
- Em testes de concorrência, demonstrar o bloqueio ou ordenação reais pelos mecanismos do sistema usado e revalidar autorização após o lock, quando aplicável. Não substituir evidência de concorrência por esperas arbitrárias.

## Debugging e integração proporcionais

- Priorizar impacto no utilizador. Distinguir defeito demonstrado da aplicação, defeito do teste, falha de infraestrutura e causa desconhecida. Um timeout não demonstra por si só um bug da aplicação; uma repetição verde não demonstra correção causal.
- Limitar o diagnóstico inicial a 45–60 minutos. Ao chegar a cerca de duas horas de investigação ativa do mesmo bloqueio sem causa ou solução demonstrada, interromper a investigação autónoma e apresentar evidência, risco, custo e opções.
- Identificar esperas de build e CI separadamente; não as usar para justificar novas rondas sem evidência. Não prolongar automaticamente a investigação pela noite. Continuar para além dos limites exige decisão explícita sobre o caso concreto.
- O limite de investigação não autoriza merge com testes vermelhos. Manter os checks obrigatórios e as asserções dos contratos. Corrigir a aplicação se houver regressão; corrigir o teste se o seu defeito estiver demonstrado; repetir uma falha de infraestrutura apenas com evidência e preservando o resultado anterior.
- Falhas sem causa conhecida continuam pendentes. Segurança, isolamento entre contextos de acesso, perda de dados, migrações e fluxos essenciais não são dispensados por pressão de tempo.
- Se necessário, propor reduzir ou reverter apenas as alterações da fatia, com autorização, ou manter a integração bloqueada. Não descartar trabalho do utilizador.
- Quarentena é exceção para um teste específico: exige evidência de intermitência, risco avaliado, cobertura alternativa relevante, registo de acompanhamento, responsável e condição de reativação. Requer aprovação explícita do utilizador para esse caso.
- Não alterar skips, retries, timeouts ou requisitos apenas para obter verde. Tornar o restante CI verde não recupera a cobertura retirada. Quarentena não autoriza merge, bypass de checks ou deploy.

## Entrega e integração

- Apresentar o que foi alterado, o cumprimento do objetivo, as verificações executadas e respetivos resultados, os riscos e as limitações ou falhas ainda pendentes.
- Atualizar o estado e a documentação durável afetados por decisões confirmadas. Referenciar a evidência relevante sem transportar todos os logs para a conversa.
- Distinguir implementação concluída, verificação concluída, integração aprovada e deployment realizado. Não afirmar etapas que não ocorreram.
- Apresentar opções de integração apenas depois da revisão e dos gates aplicáveis. Merge, push, criação de PR e deploy continuam a exigir autorização explícita.

## Configuração a confirmar por projeto

Usar a documentação e configuração existentes para localizar as decisões abaixo. Num projeto novo, registar apenas o que se aplicar e for necessário à tarefa; uma decisão em falta não é uma autorização implícita.

- **Produto e âmbito:** objetivo, critérios de aceitação, exclusões e restrições relevantes.
- **Fontes de verdade:** estado atual, plano ativo, arquitetura, especificações, runbooks e localização dos registos de execução.
- **Stack e verificação:** versões, manifests, lockfiles, comandos de desenvolvimento, testes, lint, typecheck, build e gates obrigatórios.
- **Agentes:** confirmar acesso ao GPT Sol 6.1 High, ao Gemini Flash 3.8 High via `agy`, ao GPT Luna 6 High e ao GPT-6 Astra Medium; verificar os identificadores suportados pelas ferramentas, os esforços definidos acima, os limites de custo e as permissões de execução. Esta confirmação não autoriza alterar os modelos ou os seus papéis.
- **Operação e dados:** ambientes, recursos protegidos, limpeza permitida, migrações, backups, retenção, recuperação e condições de release.

Não é necessário criar um ficheiro por item nem definir configurações para capacidades que o projeto não utiliza.
