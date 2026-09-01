/* Service Worker do app -- cacheia só o "esqueleto" (o próprio index.html), pra ele
   carregar rápido e continuar abrindo mesmo com rede instável ou momentaneamente fora
   do ar. NÃO guarda nada de STATE/dados do torneio (isso ficou de fora de propósito --
   ver PROJETO.md e a conversa que decidiu não mexer na decisão de "sem armazenamento
   local" pros dados). Só os arquivos do app em si, análogo a um app nativo que abre
   mesmo sem internet, mas sem dado nenhum carregado ainda.

   Nunca intercepta nada que não seja a navegação da própria página (GET, mode
   'navigate') -- em especial, nunca toca nas chamadas ao Supabase nem aos Google Fonts,
   que continuam indo direto pra rede como sempre foram, sem passar por aqui. */

const CACHE_NAME = 'jim2026-app-shell-v1'; // troque o "-v1" pra "-v2" (e por diante) sempre que quiser forçar todo mundo a descartar o cache antigo
const REDE_TIMEOUT_MS = 4000; // acima disso, considera a rede "lenta demais" e usa o cache -- não significa que a rede falhou de verdade, só que está mais devagar que vale a pena esperar

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(CACHE_NAME);
      // cache:'reload' força buscar da rede (não do cache HTTP do navegador), pra
      // garantir que o que vai pro cache do Service Worker é sempre a versão mais
      // recente publicada, não uma cópia intermediária velha.
      const resposta = await fetch('./index.html', { cache: 'reload' });
      if (resposta && resposta.ok) {
        // Guarda sob as duas chaves possíveis (alguém pode chegar pela raiz do site ou
        // por um link direto a index.html) -- as duas apontam pro mesmo conteúdo.
        await cache.put('./index.html', resposta.clone());
        await cache.put('./', resposta.clone());
      }
    } catch (e) {
      // Instalação sem rede nenhuma -- sem problema, tenta de novo na próxima vez que o
      // navegador ativar este Service Worker (ele confere por uma versão nova a cada
      // navegação).
    }
  })());
  self.skipWaiting(); // ativa esta versão nova assim que instalada, sem esperar todas as abas antigas fecharem
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Apaga caches de versões antigas do Service Worker (nome diferente do atual) --
    // sem isso, cada nova versão ficaria acumulando junto com as anteriores para sempre.
    const nomes = await caches.keys();
    await Promise.all(nomes.filter((nome) => nome !== CACHE_NAME).map((nome) => caches.delete(nome)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Só a navegação da própria página passa por aqui -- qualquer outra coisa (chamadas
  // à API do Supabase, upload de imagem, fontes do Google, POST/PUT/PATCH/DELETE etc.)
  // segue directo pra rede, sem este Service Worker interferir em nada.
  if (req.method !== 'GET' || req.mode !== 'navigate') return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);

    // Sempre tenta a rede (pra pegar a versão mais recente do app -- este projeto
    // recebe correções com frequência, então nunca serve o cache como primeira opção
    // só por ser "mais rápido"), mas corre em paralelo com um tempo limite: se a rede
    // não responder dentro dele, usa o cache imediatamente em vez de deixar a pessoa
    // esperando uma conexão ruim. A busca na rede continua rodando em segundo plano
    // mesmo depois disso, e atualiza o cache se/quando terminar.
    const buscaNaRede = fetch(req).then((resposta) => {
      if (resposta && resposta.ok) cache.put(req, resposta.clone());
      return resposta;
    }).catch(() => null);

    const tempoLimite = new Promise((resolve) => setTimeout(() => resolve(null), REDE_TIMEOUT_MS));

    const respostaRapida = await Promise.race([buscaNaRede, tempoLimite]);
    if (respostaRapida && respostaRapida.ok) return respostaRapida;

    // Rede lenta (não respondeu a tempo) ou já confirmadamente falhou -- tenta servir
    // do cache antes de desistir.
    const doCache = (await cache.match(req)) || (await cache.match('./index.html')) || (await cache.match('./'));
    if (doCache) return doCache;

    // Sem cache nenhum ainda (primeira visita) -- espera a busca original terminar de
    // qualquer jeito, por mais lenta que esteja, já que não há outra opção.
    const resultadoFinal = await buscaNaRede;
    return resultadoFinal || Response.error();
  })());
});
