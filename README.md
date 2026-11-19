# POS Simples

Ponto de venda (POS) **offline-first** para pequenos retalhistas em Moçambique. A aplicação é uma PWA estática: todos os dados vivem numa base SQLite WASM persistida em OPFS, dentro de um Web Worker. Não existe servidor de dados, sincronização, Server Actions nem rotas `/api/*`.

- Interface em português (pt-MZ), valores em MZN, IVA de 16%.
- Vendas, recibos internos (não fiscais), catálogo, stock, clientes, fornecedores, utilizadores com PIN, auditoria, relatórios e backup.
- Autenticação local com PBKDF2-SHA-256 (`crypto.subtle`). O PIN protege o acesso à aplicação, mas **não encripta a base de dados em repouso**.

O documento de produto e arquitetura é o [`PRD.md`](./PRD.md).

## Requisitos

- **Chrome ou Edge actualizado** (Chromium). A base de dados usa OPFS e SharedArrayBuffer, por isso o browser tem de estar em modo cross-origin isolated.
- Node.js 20 ou superior.
- A aplicação tem de ser servida com os cabeçalhos:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
```

## Começar

```bash
npm install
npm run dev
```

Abrir <http://localhost:3000>. Em desenvolvimento o Next usa Turbopack e o service worker está desactivado; os cabeçalhos COOP/COEP são injectados pelo `next.config.ts`.

Na primeira execução:

1. A aplicação abre em `/configuracao/` para criar a loja, o proprietário e o PIN de 6 dígitos.
2. Guarde o **código de recuperação** mostrado no fim da configuração. Sem ele, um PIN de proprietário esquecido não pode ser recuperado.
3. Inicie sessão com o utilizador e o PIN.

> A sessão vive apenas em memória. Recarregar a página ou fechar o separador obriga a introduzir o PIN novamente.

## Build e execução

```bash
npm run typecheck
npm run lint
npm run build
npm start
```

`npm run build` corre, por ordem:

1. `sync:sqlite` — copia `index.mjs`, `sqlite3.wasm` e o proxy OPFS do pacote `@sqlite.org/sqlite-wasm` para `public/sqlite/`.
2. `worker:build` — compila `workers/sqlite.worker.ts` para `public/workers/sqlite.worker.js`.
3. `next build --webpack` — gera o export estático em `out/` e o service worker em `public/sw.js`.
4. `postbuild` — achata os payloads RSC (ver [Notas técnicas](#notas-técnicas)).

`npm start` serve `out/` com `scripts/serve.mjs`, que aplica COOP/COEP. Para usar outra porta:

```powershell
$env:PORT=3100; npm start
```

Em produção, o mesmo resultado pode ser obtido com qualquer servidor estático que envie os três cabeçalhos. O `vercel.json` incluído configura-os para a Vercel.

Depois de abrir a aplicação, confirme `window.crossOriginIsolated === true` na consola do browser.

## Backup e restauro

- **Backup:** `/backup/` exporta o ficheiro `.db` do OPFS. Guarde-o fora do dispositivo (por exemplo, numa pen ou nuvem).
- **Restauro:** `/backup/` importa um `.db` exportado anteriormente. O ficheiro substitui a base activa; a aplicação recarrega os dados.
- A limpeza de dados do browser apaga o OPFS. **Não limpe o armazenamento do site** sem ter um backup.
- A aplicação pede `navigator.storage.persist()` para reduzir a probabilidade de o browser despejar os dados, mas isso não substitui backups.

## Offline e instalação

- Depois da primeira visita, o service worker (Serwist) guarda o shell da aplicação, o worker SQLite, o WASM e os assets. As páginas visitadas ficam na cache `pages`.
- As navegações usam **rede primeiro** com recurso à última página guardada. Se a página nunca foi visitada e não há rede, é mostrado `public/offline.html` com a opção de abrir o POS.
- Instale a aplicação pelo menu do Chrome/Edge ("Instalar aplicação") para ter um ícone próprio e arranque em janela autónoma.
- Actualizações do service worker são detectadas em segundo plano; quando houver uma nova versão, a aplicação mostra um aviso para recarregar.

## Aplicação desktop (Electron)

A mesma exportação estática (`out/`) também corre dentro do Electron. Não é uma PWA
"embebida" a partir da internet: o Electron arranca um servidor local em
`127.0.0.1:37842`, apenas para esta janela, com os cabeçalhos COOP/COEP que o
SQLite WASM exige. O URL é fixo de propósito — OPFS é separado por origem e,
se a porta mudasse, a base pareceria vazia ao abrir a aplicação seguinte.

### Gerar os executáveis (Windows x64)

```powershell
npm install
npm run electron:dist
```

Os ficheiros ficam em `dist-electron/`:

- `POS-Codebaz-Instalador-0.1.0-x64.exe` — instalador NSIS (atalho, desinstalador, pasta escolhida pelo utilizador).
- `POS-Codebaz-Portatil-0.1.0-x64.exe` — executa sem instalar; ideal para pen ou pasta partilhada.

Para testar sem gerar instalador:

```powershell
npm run electron:dir        # pasta unpacked em dist-electron/win-unpacked
.\dist-electron\win-unpacked\POS Codebaz.exe
```

Durante o desenvolvimento:

```powershell
npm run electron:dev         # arranca `next dev` e abre o Electron apontando para ele
```

Se a porta 37842 estiver ocupada por outro processo:

```powershell
$env:POS_ELECTRON_PORT=37843
.\dist-electron\win-unpacked\POS Codebaz.exe
```

### Onde ficam os dados

| Versão | Base OPFS + backups internos | Pasta visível em "Ajuda → Abrir pasta de dados" |
|---|---|---|
| Instalador | Perfil do Chromium do Electron | `%APPDATA%\POS Codebaz` |
| Portátil | Perfil do Chromium do Electron | `POS Codebaz - dados`, ao lado do `.exe` portátil |

Desinstalar a versão instalada **não apaga** `%APPDATA%\POS Codebaz`. Para apagar
tudo, remova essa pasta manualmente depois de confirmar que tem backup.

Ao exportar `.db` em `/backup/`, o Electron abre uma janela "Guardar backup" e
coloca o ficheiro em `Backups`, dentro da pasta de dados.

### Migrar da PWA (Chrome/Edge) para o desktop

O Electron tem um perfil Chromium próprio: **não vê** a base OPFS guardada no
Chrome/Edge. Para aproveitar os dados actuais:

1. Na PWA actual, abra **Backup** e exporte o `.db`.
2. Copie esse ficheiro para o computador onde vai usar o desktop.
3. No desktop, abra **Backup**, escolha o ficheiro, introduza o PIN do
   proprietário, marque a confirmação e importe.
4. Confirme que as vendas, produtos e stock aparecem, e só depois continue a
   usar a versão desktop como principal.

O caminho inverso também funciona: exporte no desktop e importe na PWA.

> O instalador não é assinado com certificado EV. No WindowsSmartScreen pode
> aparecer um aviso na primeira execução; use "Mais informações → Executar
> assim mesmo" apenas se o ficheiro vier de fonte confiável.

## Estrutura

```
app/                 Rotas do App Router, layout, manifesto e service worker (sw.ts)
components/          Ecrãs e componentes de UI
electron/            Processo principal do Electron e servidor HTTP local
lib/app-context.tsx  Arranque, sessão, bloqueio por inactividade, SW e toasts
lib/db/protocol.ts   Contrato e tipos entre a UI e o worker
lib/db/client.ts     Cliente tipado do worker
workers/             Worker SQLite (schema, migrações, vendas, autenticação, backup)
public/sqlite/       Distribuição do sqlite-wasm copiada no build
public/workers/      Worker compilado
build/               Ícone Windows gerado por `npm run electron:icon`
scripts/             Sincronização, servidor estático, ícones, empacotamento Electron, correcção RSC e PM2
out/                 Export estático gerado por `npm run build`
dist-electron/       Instalador, portátil e build unpacked (gerados)
```

Toda a persistência passa pelo worker. As vendas são gravadas numa transacção `BEGIN IMMEDIATE … COMMIT`/`ROLLBACK`; os identificadores de negócio usam `crypto.randomUUID()`.

## Servir com PM2 no Windows

```powershell
npm run build
npm run pm2:startup:windows
```

Isto inicia o servidor de produção na porta 3000 sob PM2 e registra uma tarefa agendada do Windows para o arrancar quando o utilizador inicia sessão. Requer PM2 global (`npm install -g pm2`). Para reiniciar manualmente: `npm run pm2:start`.

## Notas técnicas

- **Next 16 + export estático (Windows):** o `postbuild` (`scripts/fix-rsc-paths.mjs`) achata os payloads RSC gerados em `out/`. Sem isto, o router do Next 16 pode falhar ao navegar entre páginas exportadas neste ambiente (ver [vercel/next.js#85374](https://github.com/vercel/next.js/issues/85374)).
- **Proxy OPFS e service worker:** o sqlite-wasm pede `sqlite3-opfs-async-proxy.js?vfs=opfs` (ou `?vfs=opfs-wl`). Essas duas variantes são acrescentadas ao manifesto de precache em `next.config.ts`; sem elas, a base de dados não abre offline.
- **Não usar `additionalPrecacheEntries`:** no `@serwist/next` essa opção substitui os ficheiros de `public/` em vez de os acrescentar. O projecto acrescenta as variantes do proxy dentro de `manifestTransforms`.
- **Caminhos no Windows:** o plugin gera entradas de `public/` com `\`. O browser e a Cache API normalizam-nas para `/`; a verificação offline confirma que o worker, o WASM e o proxy ficam em cache.
- **Desenvolvimento:** o Serwist só é gerado em produção. Para testar offline/PWA, use `npm run build && npm start`.
- **Testes:** `npm run typecheck` e `npm run lint`. A verificação offline deve ser feita com o servidor parado, não apenas com o modo offline do DevTools (que não afecta de forma fiável os pedidos do service worker).
