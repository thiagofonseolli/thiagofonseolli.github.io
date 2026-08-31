# JIM 2026 — Painel de Gestão (Torneio NAC)

Documento de contexto pra quem (humano ou Claude) for continuar este projeto
sem ter acompanhado o desenvolvimento até aqui. Se você é uma instância do
Claude começando agora: leia este arquivo inteiro antes de mexer em qualquer
coisa — ele existe justamente pra evitar reintroduzir bugs que já foram
encontrados e corrigidos, alguns deles mais de uma vez.

## O que é

App de gestão de torneio esportivo escolar (Colégio Marista São José, Montes
Claros) — usado ao vivo durante o evento por um administrador e, mais
recentemente, também por representantes de Equipe com acesso restrito.
Cobre: cadastro de Equipes e Inscritos, geração automática de tabela de
jogos, súmulas com placar e cartões, classificação geral com critérios de
desempate, controle de alimentação/restrições, desfile de abertura avaliado
por múltiplos jurados, e o regulamento completo (Edital).

- **Repositório**: `thiagofonseolli/thiagofonseolli.github.io`
- **Ao vivo em**: https://thiagofonseolli.github.io/
- **Arquivo principal**: `index.html` — um único arquivo HTML+CSS+JS
  (~9300 linhas), sem build step, sem framework. GitHub Pages serve
  exatamente esse arquivo, direto.

## Arquitetura em uma imagem

```
Navegador de qualquer visitante
  ↕ (fetch direto, sem backend próprio)
Supabase (plano gratuito)
  ├─ tabela "jim_sync": todos os dados do app, como linhas genéricas
  │  {tabela, registro_id, dados (JSON), deletado, atualizado_em, dispositivo}
  └─ Storage: fotos de inscritos e logos (arquivos reais, não em JSON)
```

Não existe servidor/backend próprio — o `index.html` fala direto com a API
REST do Supabase. A URL do projeto e a chave pública (anon key) ficam
embutidas no próprio arquivo (isso é esperado e normal: são credenciais
públicas por design, protegidas por Row Level Security do lado do Supabase,
não por segredo). **Nenhuma chave privada/service-role deveria estar no
código** — se você encontrar uma, é bug.

`STATE` (uma variável global em memória) é a fonte de verdade enquanto o app
roda. Não há `localStorage`. Ao abrir a página, o app faz um "pull" completo
do Supabase pra montar `STATE do zero; a cada mudança, agenda um envio
("sync") de volta.

## O modelo de sincronização — leia isto antes de mexer em qualquer coisa relacionada a dados

Esse é o pedaço mais delicado do app, e onde a maioria dos bugs reais
apareceu ao longo do desenvolvimento. Padrões estabelecidos, todos por
motivo concreto (bug real encontrado e corrigido):

1. **Nunca capture uma referência de objeto entre renderizações ou através
   de um `await`/`showConfirm`.** Sempre busque de novo pelo ID no momento
   exato de usar. Motivo: `syncColecaoAplicarLinha()` SUBSTITUI o objeto
   inteiro no array quando aplica uma sincronização (não muda propriedades
   nele) — uma referência capturada antes vira "órfã" se uma sincronização
   concorrente chegar nesse meio-tempo, e uma edição feita nela some
   silenciosamente. Isso já apareceu (e foi corrigido) no painel de jogo,
   nos locais do Gerador de Tabela, e na edição de inscrito do acesso
   restrito de Equipe — inclusive numa variante mais sutil, onde o problema
   só aparecia durante a ESPERA por uma confirmação (`showConfirm`), não
   antes dela.

2. **Nunca atualize `syncUltimoRetrato` de forma otimista, antes de
   confirmar que o envio deu certo.** Se a rede falhar bem nesse momento, a
   mudança fica "esquecida" — o app acha que já foi enviada, mas nunca foi.
   `syncEnviarPendentes()` só atualiza o retrato E limpa a fila de
   pendentes DEPOIS que `syncEnviarLote()` retorna com sucesso.

3. **Antes de aplicar um PULL, sempre confira se há uma edição local ainda
   não confirmada como enviada** (`syncTemEdicaoLocalPendente`) — sem isso,
   uma sincronização em segundo plano pode sobrescrever uma mudança que a
   pessoa acabou de fazer, sem nunca ter sido enviada ainda. Foi assim que
   o bug "troquei a senha e ela voltou sozinha" aconteceu.

4. **IDs gerados localmente (`nextInscritoId()` e similares) usam um salto
   aleatório grande, não `+1` sequencial.** Com múltiplos dispositivos
   podendo cadastrar ao mesmo tempo (ex.: vários representantes de Equipe),
   dois cálculos partindo do mesmo estado dariam o mesmo "próximo" ID, e um
   cadastro sobrescreveria o outro ao sincronizar.

5. **Segredos (senha de admin, código de acesso de Equipe) são guardados
   com hash salgado (`hashSenhaAdmin`/`gerarSaltSenha`), nunca em texto
   puro** — como os dados sincronizam abertamente (até pra visitantes sem
   login, já que Painel/Edital são públicos), qualquer campo em texto puro
   fica visível a quem abrir o DevTools do navegador. O código de acesso de
   Equipe tem 10 caracteres (não 6) especificamente pra resistir a força
   bruta offline, já que o hash usado (SHA-256 simples) não tem
   key-stretching.

6. **Todo texto vindo de input do usuário que vai pra `innerHTML` passa por
   `escPdf()`** (a despeito do nome, é a função de escape de HTML geral do
   app, não só de PDF). Uma varredura de segurança encontrou e corrigiu
   mais de uma dúzia de pontos sem isso — alguns eram XSS persistente de
   verdade (ex.: título de tópico do regulamento, que virava HTML real ao
   ser relido).

7. **Botões que fazem algo irreversível (remover) sempre pedem confirmação**
   via `showConfirm()` — uma varredura já mapeou todos os ~17 botões desse
   tipo no app; se adicionar um novo, siga o mesmo padrão.

8. **Nenhum elemento de interface (botão, seção) que só funciona pra
   admin/representante de Equipe deveria ficar visível pra quem não tem
   esse acesso** — mesmo que o clique já esteja bloqueado internamente, um
   botão visível-mas-morto confunde, e no caso de "Exportar backup" chegou
   a ser um vazamento real de dado sensível (nome, restrição alimentar,
   alergia e foto de cada inscrito, baixável por qualquer visitante sem
   login). Ver `renderHeaderBlock()` pra ver o padrão de toggle usado.

## Três níveis de acesso

- **Visitante comum** (`isAdmin=false`, `accessoEquipeId=null`): só vê
  Painel e Edital, tudo somente-leitura. É o público (pais, alunos).
- **Admin** (`isAdmin=true`, senha com hash): acesso completo a todas as
  abas e edição.
- **Representante de Equipe** (`accessoEquipeId` setado, código de acesso
  com hash específico daquela Equipe): tela dedicada e isolada
  (`renderAcessoEquipeView()`), sem abas nem nenhum outro acesso — só
  cadastra/edita/remove inscritos da própria Equipe, com foto e
  escaneamento de QR Code pra localizar rapidamente alguém já cadastrado.
  Nunca junto com `isAdmin` ao mesmo tempo.

## Metodologia de trabalho usada (recomendado manter)

Todo o desenvolvimento seguiu este ciclo, e vale continuar:

1. Ler o trecho relevante do código antes de editar (`grep`/`view`).
2. Editar com `str_replace` (mudanças cirúrgicas, não reescritas grandes).
3. Extrair só o `<script>` (`sed -n 'INICIO,FIM p' index.html > arquivo.js`)
   e rodar `node --check` pra pegar erro de sintaxe antes de qualquer teste.
4. Escrever um teste específico pro que foi mudado — com `node`, simulando
   `document`/`window` com stubs simples quando dá, ou com `jsdom`
   (`/tmp/xssdomtest/node_modules/jsdom` costumava estar instalado, senão
   `npm install jsdom`) quando o teste precisa de DOM de verdade (parsing de
   HTML, eventos reais). Sempre que possível, reproduzir o bug ANTES da
   correção (contra a versão anterior via `git show HEAD:index.html`) pra
   confirmar que o teste realmente captura o problema.
5. Rodar o teste de `init()` completo (simula a inicialização inteira do
   app) antes de publicar — pega erros de integração que testes isolados
   não veem. Reduzir os tempos de espera do loop de sincronização inicial
   pra esse teste não travar (ver `SYNC_INICIAL_TIMEOUT_MS` e
   `confirmacoesDeVazio` no próprio teste, não no código real).
6. `git add`, `git commit` com mensagem detalhada (`-F arquivo.txt`,
   explicando o quê/por quê/como foi testado — as mensagens de commit deste
   repositório documentam boa parte da história de decisões do projeto,
   vale ler `git log` quando precisar de contexto de algo específico).
7. `git push`, depois checar o status do build via API do GitHub
   (`GET /repos/.../pages/builds/latest`) até aparecer `"status":"built"`
   antes de considerar publicado.

## Pontos que já foram avaliados e não precisam de nova rodada (a menos que algo mude)

- **Capacidade pro plano gratuito do Supabase**: testado com 600, 1000 e até
  5000 inscritos simulados — o volume de dados de texto (~226 KB pra 600
  inscritos) e de fotos (~28 KB cada, comprimidas) fica muito abaixo dos
  limites do plano gratuito (500 MB de banco, 1 GB de armazenamento de
  arquivo). Não é uma preocupação até uma escala bem maior que a de um
  torneio escolar.
- **Performance da sincronização**: havia um problema real de O(n²) na
  função que roda a cada 20s em segundo plano — corrigido, agora escala de
  forma linear (testado até 5000 inscritos, poucos milissegundos).
- **XSS**: varredura completa já feita mais de uma vez, sem achados
  pendentes na última passada.
- **Referência órfã / corrida de sincronização**: varredura sistemática por
  todo o arquivo, sem achados pendentes na última passada.

## O que precisa ser configurado numa conta/ambiente novo

Nada relacionado ao Supabase precisa ser reconfigurado — a URL e a chave
pública já estão no próprio `index.html`. O que muda é só o acesso ao
GitHub:

- Pra publicar mudanças, é preciso um **token de acesso pessoal do GitHub**
  (Settings → Developer settings → Personal access tokens) com permissão de
  escrita no repositório `thiagofonseolli/thiagofonseolli.github.io`, ou
  acesso configurado via Claude Code/SSH local.
- **Nunca reutilizar um token que já apareceu em texto puro numa conversa
  anterior** — revogue e gere um novo.

## Por onde continuar

Pergunte ao dono do projeto o que ele quer fazer a seguir, ou, se for
retomar uma análise, `git log --oneline` mostra o histórico completo de
mudanças — cada mensagem de commit tem uma explicação detalhada do que foi
feito, por quê, e como foi testado.
