# PRD — POS Simples Offline-First (PWA)

| Campo | Valor |
|---|---|
| **Produto** | POS Simples (nome provisório) |
| **Versão do documento** | 2.0 — reescrito após decisão de arquitetura 100% local |
| **Data** | 13 de novembro de 2026 |
| **Estado** | Proposto para validação |
| **Mercado** | Moçambique — MZN, IVA 16%, interface em português (pt-MZ) |
| **Arquitetura** | PWA 100% offline-first, sem servidor de dados e sem sincronização |
| **Stack obrigatória** | Next.js 16 (App Router, static export), React 19, TypeScript, Tailwind CSS 4, SQLite WASM + OPFS em Web Worker, `@serwist/next`, Web Crypto API |
| **Autenticação** | 100% local: utilizadores em SQLite + PIN com PBKDF2 via Web Crypto |
| **Instalação** | 1 dispositivo/navegador por base de dados no MVP (sem multi-terminal) |
| **Backup** | Exportação/importação do ficheiro `.db` do OPFS |

---

## 1. Resumo executivo

O POS Simples é uma aplicação de ponto de venda para pequenos retalhistas moçambicanos que precisam de vender rápido, manter o stock minimamente fiável e **funcionar sempre**, mesmo sem internet.

Esta versão do produto é uma **PWA 100% local**:

- a aplicação é servida como site estático e fica instalada no dispositivo;
- todos os dados vivem numa base **SQLite WASM persistida em OPFS**, dentro de um **Web Worker**;
- não existem Server Actions, rotas `/api/*`, base de dados no servidor nem chamadas `fetch()` para persistir dados;
- a autenticação é local: utilizadores numa tabela SQLite e PIN protegido com **PBKDF2-SHA-256** via `crypto.subtle`;
- as vendas, o catálogo, o stock, os clientes e os fornecedores funcionam integralmente offline;
- a proteção dos dados depende de **backups exportados/importados manualmente** e de `navigator.storage.persist()`;
- não há sincronização entre dispositivos no MVP.

O MVP cobre **vendas, catálogo, stock, clientes, fornecedores e autenticação por PIN**, com recibos internos impressos no browser. A gestão é feita no mesmo dispositivo e já não depende de ligação.

> **Nota fiscal:** os recibos do MVP são **documentos internos não fiscais**. A certificação de software de facturação junto da Autoridade Tributária de Moçambique é um requisito legal separado, tratado fora do MVP.

> **Nota de segurança:** como não há servidor, o PIN protege o acesso à aplicação, mas **não encripta a base de dados em repouso**. Quem tiver acesso ao sistema de ficheiros do dispositivo pode copiar o `.db`. Ver secções 11.6 e 14.

---

## 2. Alterações face à versão anterior (1.0)

A decisão de arquitetura 100% local invalida várias decisões anteriores. Esta tabela existe para evitar ambiguidade durante a implementação.

| Tema | Versão 1.0 | Versão 2.0 (atual) | Consequência |
|---|---|---|---|
| Autenticação | better-auth no servidor | Web Crypto + tabela `users` local | better-auth **deixa de ser usado**; auth é código nosso |
| Base de dados | SQLite no servidor (Drizzle) | SQLite WASM + OPFS no browser | Sem Drizzle, sem migrações no servidor |
| Sincronização | Outbox + pull/push + conflitos | **Não existe** | Sem sync, sem resolução de conflitos, sem multi-terminal |
| Server Actions / API | Permitidos | **Proibidos** | Toda a lógica corre no cliente |
| Gestão | Online-only | 100% offline | Catálogo/stock/fornecedores editáveis no dispositivo |
| Nº de terminais | 1 no MVP, arquitetura multi-terminal | 1 instalação = 1 base de dados | Multi-dispositivo fica fora do MVP |
| Backup | SQLite no servidor + cópias | Exportar/importar `.db` do OPFS | Passa a ser o mecanismo crítico de segurança |
| PIN | better-auth + verificador offline | PBKDF2 local | 6 dígitos, lockout, código de recuperação |
| Recibos | Numeração por terminal | Contador local transacional | `installationCode-000001` |
| PWA | Opcional | Obrigatória | `@serwist/next` + cache total |

### 2.1 Decisões de arquitetura (ADR resumido)

| ID | Decisão | Razão |
|---|---|---|
| ADR-01 | Aplicação 100% client-side, com `output: "export"` no Next.js | Cumprir a regra de zero dependência de rede para persistência |
| ADR-02 | SQLite WASM + OPFS dentro de `sqlite.worker.ts` | Persistência relacional local, sem bloquear a UI |
| ADR-03 | Autenticação local com PBKDF2 + tabela `users` | better-auth exige servidor; a regra proíbe servidor |
| ADR-04 | UUID (`crypto.randomUUID()`) em todas as chaves de negócio | Evitar colisões e permitir criação local sem coordenação |
| ADR-05 | Comandos de domínio no worker, com transações ACID | Garantir venda + itens + pagamentos + stock num único commit |
| ADR-06 | Sem sincronização; backup por `.db` | Não há servidor nem resolução de conflitos no MVP |
| ADR-07 | Uma instalação = uma base de dados | Evitar multi-escrita e corrupção no MVP |
| ADR-08 | `@serwist/next` para precache da app shell e rotas | Garantir arranque offline após a primeira visita |
| ADR-09 | `navigator.storage.persist()` + lembretes de backup | Reduzir risco de perda de dados por eviction |
| ADR-10 | Recibos não fiscais no MVP | Certificação AT é um processo externo e mais longo |

---

## 3. Contexto e problema

### 3.1 Contexto

Pequenos estabelecimentos em Moçambique — mercearias, minimercados, lojas de bairro, cafés, papelarias — operam frequentemente com:

- cadernos ou folhas de Excel para stock e vendas;
- cálculo mental ou máquina de calcular para trocos;
- internet instável, cara ou intermitente;
- vários operadores a partilhar o mesmo balcão;
- necessidade de fechar a venda em segundos, mesmo quando a rede falha.

### 3.2 Problema

As soluções existentes falham de três formas:

1. **Dependem da internet** para vender, emitir recibo ou consultar preços.
2. **Não protegem o stock**: vendas e entradas não ficam registadas de forma consistente.
3. **São difíceis de operar**: exigem formação longa, muitos cliques ou equipamento caro.

### 3.3 Oportunidade

Uma PWA instalável, local-first, que:

- arranca e vende sem rede;
- guarda tudo no dispositivo;
- permite login rápido por PIN;
- imprime recibos simples;
- pode ser copiada para outro dispositivo por exportação/importação do `.db`;
- não tem custos de servidor nem de base de dados.

### 3.4 Restrição fundamental

Sem servidor, **não há sincronização, não há backup automático na nuvem e não há recuperação remota**. O produto tem de ser desenhado para tornar esta limitação explícita e segura: backups frequentes, avisos claros e recuperação local.

---

## 4. Objetivos e métricas

### 4.1 Objetivos de produto

| ID | Objetivo | Métrica de sucesso |
|---|---|---|
| OBJ-01 | Fechar uma venda simples em menos de 30 segundos | P95 < 30 s para 3 itens, utilizador treinado |
| OBJ-02 | Funcionar 100% offline após a primeira instalação | Venda + recibo + reload sem rede em 100% dos testes |
| OBJ-03 | Não perder vendas confirmadas | 0 vendas perdidas em testes de falha/crash |
| OBJ-04 | Manter stock coerente | Divergência < 1% após contagem mensal |
| OBJ-05 | Proteger o acesso por PIN | 100% dos acessos exigem PIN; lockout testado |
| OBJ-06 | Garantir recuperação de dados | Exportar/importar `.db` sem perda em 100% dos testes |
| OBJ-07 | Ser operável por um caixa novo | Formação < 15 minutos para venda básica |
| OBJ-08 | Não fazer chamadas de rede para dados | 0 pedidos de dados em testes com interceção de rede |

### 4.2 Métricas de operação

- Vendas por dia por instalação: 50–500 (dimensionamento).
- Produtos: até 20 000.
- Clientes: até 10 000.
- Fornecedores: até 1 000.
- Vendas retidas localmente: 24 meses ou 100 000 vendas, o que ocorrer primeiro.
- Tempo de arranque da app instalada: < 2,5 s em tablet Android médio.
- Pesquisa de produto: P95 < 50 ms com 20 000 produtos.
- Commit de venda: P95 < 300 ms.
- Tamanho típico da base: < 100 MB para 24 meses de operação.

### 4.3 Não-objetivos do MVP

- Sincronização multi-dispositivo.
- Gestão centralizada de várias lojas.
- Faturação certificada pela AT.
- Integração com terminais de cartão, M-Pesa ou e-Mola.
- Compras, contas a pagar, cash sessions, devoluções, vendas a crédito (“fiado”), fidelização.
- Backend, API pública, relatórios remotos ou acesso do proprietário a partir de outro dispositivo.

---

## 5. Personas e trabalhos a realizar

### 5.1 Proprietário (Dona Amélia, 42 anos)

- **Contexto:** mercearia de bairro, 1 balcão, 2–4 funcionários, internet instável.
- **Objetivos:** saber quanto vendeu, controlar stock, impedir descontos abusivos, não perder dados.
- **Dores:** cadernos perdidos, stock que não bate, funcionários a fazer descontos sem autorização, medo de perder tudo se o tablet avariar.
- **Trabalhos:** configurar a loja, criar utilizadores, definir preços, receber stock, consultar resumo do dia, exportar backup.

### 5.2 Gerente (Carlos, 35 anos)

- **Contexto:** abre e fecha a loja, gere reposição e aprova exceções.
- **Objetivos:** resolver rapidamente descontos e anulações, garantir que o stock é reposto.
- **Dores:** ser chamado ao balcão a cada desconto, não saber quem anulou o quê.
- **Trabalhos:** aprovar descontos/anulações com PIN, registar entradas de stock, corrigir stock, consultar histórico.

### 5.3 Operador de caixa (Ana, 22 anos)

- **Contexto:** atende clientes, usa tablet/teclado, faz vendas rápidas.
- **Objetivos:** vender depressa, receber dinheiro/cartão, imprimir recibo, não bloquear a fila.
- **Dores:** apps lentas, erros de troco, produtos difíceis de encontrar, sessões que expiram a meio.
- **Trabalhos:** pesquisar produto, adicionar ao carrinho, aplicar desconto permitido, receber pagamento, entregar troco, imprimir recibo, anular venda com gerente.

### 5.4 Contabilista / apoio administrativo (uso esporádico)

- **Contexto:** recebe exportações para conferir vendas e IVA.
- **Objetivos:** obter dados legíveis e completos.
- **Trabalhos:** exportar CSV (fase 2), consultar totais de IVA, conferir fecho do dia.

---

## 6. Âmbito do MVP

### 6.1 Must (MVP)

| Módulo | Incluído |
|---|---|
| PWA | Instalação, precache, arranque offline, indicador de modo local, atualização controlada |
| Base local | SQLite WASM + OPFS no worker, migrações versionadas, integridade, `storage.persist()` |
| Auth | Setup inicial, PIN 6 dígitos, lockout, lock por inatividade, roles, código de recuperação |
| Utilizadores | Criar/editar/desativar, reset de PIN, forçar alteração |
| Catálogo | Categorias, produtos, SKU, múltiplos códigos de barras, preço com IVA, unidade, stock |
| Stock | Movimentos, entrada com fornecedor/custo/documento, ajuste com motivo, baixa por venda, reposição por anulação |
| Clientes | CRUD, telefone/NIF, pesquisa, associação à venda |
| Fornecedores | CRUD, contactos, associação a entradas de stock |
| Vendas | Carrinho, pesquisa/código de barras, quantidades decimais, descontos, cliente opcional |
| Pagamentos | Dinheiro, cartão, POS, M-Pesa, e-Mola, transferência, pagamento misto, troco |
| Recibos | Impressão 80 mm, reimpressão, marca de anulação, aviso “documento não fiscal” |
| Anulações | Com aprovação de gerente, reposição de stock, auditoria |
| Aprovações | PIN de gerente sem trocar de sessão, limite de valor, registo |
| Relatórios | Resumo do dia, mix de pagamentos, top produtos, stock baixo, IVA |
| Auditoria | Login, vendas, anulações, descontos, stock, utilizadores, backups |
| Backup | Exportar `.db`, importar `.db` com validação, lembrete de backup |
| Qualidade | Testes unitários, E2E offline, teste de impressão, documentação |

### 6.2 Should (MVP se houver tempo)

- Exportação CSV de vendas e stock.
- Backup automático diário para OPFS + download manual.
- Backup para pasta escolhida via File System Access API (Chromium).
- Exportação encriptada com passphrase (AES-GCM).
- Histórico de preços por produto.
- Código de recuperação rotativo.
- Leitor de código de barras com foco automático.
- Atalhos de teclado completos.
- Página de diagnóstico (storage, integridade, versão, último backup).

### 6.3 Could (fase 2)

- Múltiplos dispositivos com sincronização (exige backend ou CRDT).
- Sessões de caixa (abertura/fecho, sangria, fundo de maneio).
- Devoluções e trocas parciais.
- Vendas a crédito (“fiado”) com limite por cliente.
- Compras e contas a pagar.
- Importação CSV de produtos.
- Etiquetas e impressão de códigos de barras.
- Integração com balança.
- Faturação certificada.
- WebAuthn/biometria para desbloqueio.
- Encriptação da base em repouso (SQLCipher ou equivalente, se viável em WASM).

### 6.4 Won't (fora do MVP)

- Server Actions, API routes, backend, base de dados remota.
- Sincronização, multi-loja, multi-terminal.
- Autenticação por email/password, OAuth, better-auth.
- Pagamentos online ou integração com adquirentes.
- Gestão de lotes/validade, números de série, variantes.
- Fatura certificada, assinatura digital, comunicação com AT.
- Analytics de terceiros, telemetria, fontes/CDNs externas.

---

## 7. Regras estritas de desenvolvimento e matriz de conformidade

Estas regras são **requisitos de arquitetura**, não sugestões. Qualquer PR que as viole deve ser rejeitado.

| # | Regra | Como o produto garante | Onde é verificada |
|---|---|---|---|
| R1 | **Zero dependência de rede.** Nunca criar Server Actions (`"use server"`), rotas `/api/*` ou `fetch()` para persistir dados. | Next.js com `output: "export"`; nenhuma pasta `app/api`; dados apenas via mensagens ao worker; CSP restritiva; teste que interceta pedidos. | Secções 12, 16, 17 e 18 |
| R2 | **IDs universais.** Usar sempre `crypto.randomUUID()` em chaves primárias de negócio. Nunca `AUTOINCREMENT`. | Todas as tabelas de negócio usam `TEXT PRIMARY KEY` com UUID; contadores usam tabela `counters` com chave textual. | Secção 13 |
| R3 | **Web Worker para SQLite.** Nunca executar SQLite OPFS na thread principal. | UI comunica apenas com `sqlite.worker.ts` por `postMessage`; nenhum import de SQLite em componentes. | Secção 12 |
| R4 | **Transações ACID.** A finalização de venda corre dentro de `BEGIN IMMEDIATE ... COMMIT`, atualizando venda, itens, pagamentos e stock. | Comando `sale.complete` no worker executa tudo numa transação; rollback em qualquer erro. | Secções 10 e 12 |
| R5 | **Persistência segura.** Solicitar `navigator.storage.persist()` no arranque; manter exportar/importar `.db` do OPFS. | Ecrã de backup, lembretes, exportação consistente com `VACUUM INTO`, importação validada. | Secções 12 e 14 |

### 7.1 Regras derivadas

- **R6:** Nenhum segredo ou PIN é escrito em logs, `localStorage` ou `sessionStorage`.
- **R7:** Nenhuma dependência externa em runtime (fontes, ícones, scripts, analytics). Tudo é servido pelo próprio site.
- **R8:** Todo o SQL é parametrizado. Proibida interpolação de strings com input do utilizador.
- **R9:** A UI nunca recebe o handle da base de dados; só recebe resultados de comandos.
- **R10:** A versão do schema (`PRAGMA user_version`) é verificada no arranque e antes de importar.
- **R11:** Uma atualização da app nunca deve apagar dados; migrações são transacionais e precedidas de backup.
- **R12:** Só pode existir um separador com escrita ativa; os restantes ficam em modo leitura ou bloqueados.

---

## 8. Jornadas principais

### 8.1 Primeira execução e setup

1. O utilizador abre a PWA instalada (ou o site) pela primeira vez.
2. A app inicializa o worker, cria o ficheiro `pos.sqlite3` no OPFS e corre as migrações.
3. Pede `navigator.storage.persist()` e mostra o resultado.
4. Mostra o assistente de configuração: nome da loja, NIF, endereço, telefone, nome do proprietário, username, PIN de 6 dígitos e confirmação.
5. Gera um **código de recuperação** e obriga o utilizador a confirmar que o guardou.
6. Cria a instalação (`installationCode`, ex.: `T01`), o utilizador `owner`, as definições e o primeiro registo de auditoria.
7. Sugere exportar o primeiro backup imediatamente.
8. Redireciona para o POS.

**Critério de sucesso:** após o setup, a app funciona offline; o ecrã de setup deixa de estar acessível.

### 8.2 Arranque do dia e login

1. A app abre no ecrã de login (ou no POS, se a sessão ainda estiver desbloqueada).
2. O operador escolhe o seu utilizador e digita o PIN no teclado numérico.
3. O worker valida o PIN com PBKDF2 e verifica lockout.
4. Em caso de sucesso, a sessão fica em memória e o POS abre.
5. Em caso de falha, incrementa tentativas, mostra erro genérico e bloqueia após 5 tentativas.
6. Após 5 minutos de inatividade, a sessão bloqueia e pede PIN novamente.

### 8.3 Venda no balcão

1. O foco está na pesquisa/código de barras.
2. O operador pesquisa por nome/cor/categoria/SKU ou passa o código de barras; a pesquisa combina vários termos entre atributos (ex.: “rose red”).
3. O produto é adicionado ao carrinho com quantidade 1; pode ajustar quantidade (incluindo decimais para kg/l).
4. Pode associar um cliente (opcional), aplicar desconto dentro do limite e adicionar nota.
5. Pressiona “Cobrar”; escolhe dinheiro, cartão/POS, M-Pesa, e-Mola, transferência ou pagamento misto.
6. Introduz o valor recebido; a app calcula o troco.
7. Confirma; o worker executa a transação ACID e devolve o número de recibo.
8. A app mostra o recibo e abre a impressão (80 mm), com opção de reimprimir.

### 8.4 Desconto ou anulação com aprovação

1. O operador tenta aplicar um desconto acima do limite (ou anular uma venda).
2. A app abre o modal de aprovação e pede o PIN de um gerente/proprietário.
3. O worker verifica o PIN e o role, sem trocar a sessão do caixa.
4. Cria um registo de aprovação válido por 2 minutos, associado à ação e ao valor.
5. A ação prossegue; a auditoria regista requerente, aprovador, valor e timestamp.
6. Se o aprovador for o próprio requerente, só o proprietário pode fazê-lo, e fica marcado como autoaprovação.

### 8.5 Entrada de stock

1. O gerente abre “Stock” → “Entrada”.
2. Escolhe produto, quantidade, custo unitário, fornecedor (opcional), documento e nota.
3. Confirma; o worker insere o movimento e atualiza `stock_on_hand_milli` na mesma transação.
4. O histórico do produto mostra o movimento e o custo.
5. Se o stock ficar abaixo do limite, aparece em “Stock baixo”.

### 8.6 Anulação de venda

1. O gerente abre o histórico, escolhe a venda e “Anular”.
2. Indica o motivo e aprova com PIN (se não for ele o requerente).
3. O worker marca a venda como anulada, insere movimentos de reposição de stock e regista auditoria.
4. O recibo original mantém o número e passa a mostrar “ANULADO”; a reimpressão reflete o estado.

### 8.7 Backup e restauro

1. A app mostra “Último backup: há X dias” no cabeçalho.
2. O proprietário abre “Backup” → “Exportar”.
3. O worker executa `VACUUM INTO` para um ficheiro temporário, lê os bytes e inicia o download.
4. O utilizador guarda o ficheiro `.db` num local seguro (pen, disco externo, nuvem pessoal).
5. Para restaurar, escolhe “Importar”, seleciona o `.db`, confirma o resumo e introduz o PIN de proprietário.
6. A app valida o ficheiro, faz backup do atual, substitui a base e recarrega.

### 8.8 Atualização da app

1. O Serwist deteta uma nova versão e mostra “Nova versão disponível”.
2. A app não recarrega enquanto houver carrinho com itens ou venda em curso.
3. Ao atualizar, o worker faz backup automático, corre migrações e só depois a UI recarrega.
4. Se a migração falhar, a app mantém a versão anterior e mostra o erro com instruções de restauro.

---

## 9. Requisitos funcionais

Legenda de prioridade: **M** = Must, **S** = Should, **C** = Could, **W** = Won't (MVP).

### 9.1 Aplicação, PWA e base local

| ID | Requisito | Prioridade |
|---|---|---|
| RF-APP-01 | A aplicação é exportada estaticamente (`output: "export"`) e não contém Server Actions nem rotas `/api/*`. | M |
| RF-APP-02 | O Serwist pré-cacheia a app shell, rotas, fontes, ícones e assets; a app abre offline após a primeira visita. | M |
| RF-APP-03 | Existe manifest, ícones 192/512 e instalação em modo standalone. | M |
| RF-APP-04 | Recarregar a página sem rede mantém a app funcional e os dados intactos. | M |
| RF-APP-05 | Atualizações são apresentadas ao utilizador e nunca recarregam a app com uma venda em curso. | M |
| RF-APP-06 | `navigator.storage.persist()` é solicitado no arranque; o resultado é mostrado nas definições. | M |
| RF-APP-07 | A app mostra uso e quota de armazenamento via `navigator.storage.estimate()`. | S |
| RF-APP-08 | Apenas um separador pode escrever na base; os restantes ficam bloqueados ou em leitura. | M |
| RF-APP-09 | No arranque corre `PRAGMA quick_check` e `PRAGMA foreign_key_check`; em falha, sugere restauro. | M |
| RF-APP-10 | O schema é versionado com `PRAGMA user_version`; migrações são transacionais e precedidas de backup. | M |
| RF-APP-11 | A UI mostra o modo “Local” e o estado do último backup, não um estado de sincronização. | M |
| RF-APP-12 | Não existem pedidos de rede em runtime para dados, fontes, ícones, analytics ou telemetria. | M |
| RF-APP-13 | O arranque verifica compatibilidade do browser (OPFS, Web Crypto, Web Locks, Service Worker) e avisa se falhar. | S |
| RF-APP-14 | A app avisa que limpar os dados do site ou desinstalar pode apagar a base local. | S |
| RF-APP-15 | Existe uma página de diagnóstico com versão, schema, tamanho, integridade, persistência e último backup. | S |

### 9.2 Setup e definições

| ID | Requisito | Prioridade |
|---|---|---|
| RF-SET-01 | No primeiro arranque, um assistente cria loja, proprietário, PIN, código de instalação e definições. | M |
| RF-SET-02 | O proprietário edita nome da loja, NIF, endereço, telefone, rodapé do recibo e código de instalação. | M |
| RF-SET-03 | O código de recuperação é gerado no setup, mostrado uma única vez e guardado apenas como hash. | M |
| RF-SET-04 | O setup obriga a confirmar que o código de recuperação foi guardado. | M |
| RF-SET-05 | Definir limite de desconto do caixa, permitir/negar stock negativo, tempo de bloqueio por inatividade e rodapé. | M |
| RF-SET-06 | O setup sugere exportar o primeiro backup imediatamente. | M |
| RF-SET-07 | O ecrã de setup deixa de estar acessível depois de existir proprietário. | M |
| RF-SET-08 | Existe opção de “repor aplicação” (apagar tudo), protegida por PIN de proprietário e backup obrigatório. | S |
| RF-SET-09 | Dados de demonstração opcionais para formação. | C |
| RF-SET-10 | Regra de aprovação de descontos configurável: nunca, acima do limite do caixa ou sempre (qualquer desconto exige gerente/proprietário). | M |

### 9.3 Autenticação, utilizadores e permissões

| ID | Requisito | Prioridade |
|---|---|---|
| RF-AUTH-01 | Login por seleção de utilizador + PIN de 6 dígitos num teclado numérico. | M |
| RF-AUTH-02 | O PIN é derivado com PBKDF2-SHA-256, salt aleatório por utilizador e iterations configuráveis (mínimo 600 000). | M |
| RF-AUTH-03 | Após 5 tentativas falhadas, o utilizador fica bloqueado 60 s; após 10, 15 min; o bloqueio é auditado. | M |
| RF-AUTH-04 | A sessão bloqueia após 5 min de inatividade (configurável) e exige PIN para retomar. | M |
| RF-AUTH-05 | Roles: `owner`, `manager`, `cashier`; permissões verificadas no worker, não apenas na UI. | M |
| RF-AUTH-06 | O proprietário cria, edita, desativa e reativa utilizadores; o username é único. | M |
| RF-AUTH-07 | O proprietário repõe o PIN de um utilizador e pode obrigar a alteração no próximo login. | M |
| RF-AUTH-08 | Cada utilizador altera o seu PIN conhecendo o PIN atual. | M |
| RF-AUTH-09 | O código de recuperação permite repor o PIN do proprietário; após uso, é rotacionado. | M |
| RF-AUTH-10 | Aprovações de gerente/proprietário verificam o PIN sem trocar a sessão do caixa. | M |
| RF-AUTH-11 | A autoaprovação só é permitida ao proprietário e fica marcada na auditoria. | M |
| RF-AUTH-12 | Utilizadores desativados não iniciam sessão nem aprovam ações. | M |
| RF-AUTH-13 | A sessão existe apenas em memória; recarregar a página exige novo PIN. | M |
| RF-AUTH-14 | PINs, hashes e salts nunca aparecem em logs, `localStorage` ou `sessionStorage`. | M |
| RF-AUTH-15 | Todos os eventos de login, falha, lockout, reset e alteração de PIN são auditados. | M |
| RF-AUTH-16 | O utilizador pode consultar o seu perfil e terminar sessão. | S |
| RF-AUTH-17 | O código de recuperação pode ser regenerado pelo proprietário. | S |
| RF-AUTH-18 | Cada utilizador pode ter um atalho numérico (1-9) único, atribuído automaticamente ou pelo proprietário; premi-lo na lista selecciona o utilizador antes do PIN. | M |

### 9.4 Catálogo

| ID | Requisito | Prioridade |
|---|---|---|
| RF-CAT-01 | CRUD de categorias com nome e ordem de apresentação. | M |
| RF-CAT-02 | CRUD de produtos com nome, SKU, categoria, unidade, preço, custo, IVA, stock e limite de stock baixo. | M |
| RF-CAT-03 | Um produto pode ter vários códigos de barras, com um principal. | M |
| RF-CAT-04 | SKU é gerado automaticamente se ficar vazio. | S |
| RF-CAT-05 | Pesquisa por nome, cor, categoria, SKU ou código de barras, insensível a maiúsculas e acentos. Termos separados por espaços combinam-se com AND, cada um podendo corresponder a um atributo diferente (ex.: `rose red` encontra nome "Rose" e cor "Red"). | M |
| RF-CAT-06 | Unidades: unidade, kg, g, l, ml, caixa, pacote; quantidades decimais para unidades fracionáveis. | M |
| RF-CAT-07 | Preços de unidade, meia embalagem e pacote são configurados separadamente; o IVA pode ser acrescentado na venda. | M |
| RF-CAT-08 | Produtos podem ser desativados ou eliminados logicamente, preservando vendas históricas. | M |
| RF-CAT-09 | Limite de stock baixo por produto; alerta quando `stock_on_hand <= limite`. | M |
| RF-CAT-10 | Alterações de preço e custo são auditadas com valor anterior e novo. | M |
| RF-CAT-11 | Histórico de preços por produto. | S |
| RF-CAT-12 | Importação/exportação CSV de produtos. | C |
| RF-CAT-13 | Imagens de produto. | W |
| RF-CAT-14 | Variantes (tamanho/cor) como produtos de stock distintos; o SKU do fornecedor pode repetir, distinguindo variantes por SKU, nome e cor. | M |
| RF-CAT-17 | Todos os produtos novos exigem cor; o POS e o histórico distinguem variantes pela cor mesmo quando o SKU se repete. | M |
| RF-CAT-15 | Ações em massa (ativar/desativar/categoria). | S |
| RF-CAT-16 | Produtos configuráveis para venda por unidade-base, pacote e meia embalagem, com conteúdo por pacote, formatos activáveis e preço próprio para cada formato. As vendas guardam snapshots de formato, quantidade e preço. | M |

### 9.5 Stock

| ID | Requisito | Prioridade |
|---|---|---|
| RF-STK-01 | Todo o stock deriva de um livro de movimentos imutável. | M |
| RF-STK-02 | Entrada de stock com produto, quantidade, custo unitário, fornecedor opcional, documento e nota. | M |
| RF-STK-03 | Ajuste manual positivo/negativo com motivo obrigatório. | M |
| RF-STK-04 | Venda baixa stock; anulação repõe stock, na mesma transação. | M |
| RF-STK-05 | Lista de stock baixo e produtos sem stock. | M |
| RF-STK-06 | Política de stock negativo configurável; se desativada, exige aprovação de gerente. | M |
| RF-STK-07 | Histórico de movimentos por produto com saldo antes/depois. | M |
| RF-STK-08 | Contagem de inventário com ajuste global. | C |
| RF-STK-09 | Rotina de reconciliação: `stock_on_hand` deve ser igual à soma dos movimentos. | M |
| RF-STK-10 | Custo do produto é atualizado para o último custo de entrada; não há FIFO nem custo médio no MVP. | S |
| RF-STK-11 | Stock negativo é mostrado com destaque no catálogo e no POS. | M |
| RF-STK-12 | Entradas de compra podem ser registadas por pacote e convertidas para a unidade-base configurada no produto; o livro de movimentos e os saldos permanecem na unidade-base. | M |
| RF-STK-13 | Importar Excel a partir da linha 6 (B SKU, C nome, E cor, J quantidade, K custo unitário, L valor), rever produtos novos/existentes, preços de venda em falta, conteúdo e preços do pacote/meia embalagem e taxa Rand→MZN; assinalar divergências entre K×J e L e exigir confirmação explícita; manter o stock em unidades-base e activar as formas de venda configuradas; confirmar produtos e movimentos de stock numa operação atómica. | M |
| RF-STK-14 | O número da factura é editável na revisão (pré-preenchido da célula B2) e obrigatório. Facturas repetidas (comparação sem acentos, minúsculas e espaços normalizados) são rejeitadas antes e dentro da transação de importação; o registo da factura, o aumento de stock e os movimentos de compra ficam visíveis no histórico. Produtos existentes inactivos ou sem controlo de stock são reactivados e auditados na importação, sem bloquear a factura; produtos com unidade diferente da unidade-base continuam a bloquear. | M |
| RF-STK-15 | Histórico de movimentos por produto com filtro temporal humanizado e intervalo personalizado no calendário, em hora de Maputo. | S |

### 9.6 Clientes

| ID | Requisito | Prioridade |
|---|---|---|
| RF-CLI-01 | CRUD de clientes com nome, telefone, telefone alternativo, NIF, email, endereço e notas. | M |
| RF-CLI-02 | Telefone normalizado para `+258` quando aplicável e validado; duplicados avisados, não bloqueados. | M |
| RF-CLI-03 | NIF validado como 9 dígitos quando preenchido. | M |
| RF-CLI-04 | Pesquisa por nome, telefone e NIF. | M |
| RF-CLI-05 | Cliente é opcional na venda; se houver NIF no recibo, o cliente é obrigatório. | M |
| RF-CLI-06 | Histórico de compras do cliente. | S |
| RF-CLI-07 | Aviso de possível duplicado por telefone, com opção de usar o existente. | S |
| RF-CLI-08 | Eliminação lógica, preservando vendas. | M |
| RF-CLI-09 | Saldo devedor de vendas a prazo visível no cartão do cliente, com contagem de vendas a prazo. | M |

### 9.7 Fornecedores

| ID | Requisito | Prioridade |
|---|---|---|
| RF-FOR-01 | CRUD de fornecedores com nome, contacto, telefone, NIF, email, endereço e notas. | M |
| RF-FOR-02 | NIF e telefone validados quando preenchidos. | M |
| RF-FOR-03 | Entradas de stock podem referenciar fornecedor e documento. | M |
| RF-FOR-04 | Pesquisa por nome, contacto, telefone e NIF. | M |
| RF-FOR-05 | Eliminação lógica; fornecedor inativo não aparece em novas entradas. | M |

### 9.8 Vendas

| ID | Requisito | Prioridade |
|---|---|---|
| RF-VEN-01 | Carrinho com adicionar, alterar quantidade, remover e limpar. | M |
| RF-VEN-02 | Adicionar por pesquisa ou código de barras (scanner keyboard wedge). | M |
| RF-VEN-03 | Quantidade decimal para produtos fracionáveis, com vírgula ou ponto. | M |
| RF-VEN-04 | Desconto por linha e por venda, em valor ou percentagem. | M |
| RF-VEN-05 | Cliente opcional, pesquisável e criável a partir do POS (com permissão). | M |
| RF-VEN-06 | Totais, IVA opcional, descontos e troco calculados de forma determinística. | M |
| RF-VEN-07 | Finalização da venda é uma transação ACID única (venda + itens + pagamentos + stock + contador + auditoria). | M |
| RF-VEN-08 | Número de recibo gerado por contador transacional, formato `{código}-{sequência}`. | M |
| RF-VEN-09 | Anulação com motivo e aprovação de gerente/proprietário; repõe stock. | M |
| RF-VEN-10 | Histórico com pesquisa por recibo/cliente e filtro temporal humanizado (hoje, ontem, 7/30 dias, semana, mês, todo o período ou intervalo personalizado com calendário); reimpressão. | M |
| RF-VEN-11 | Nota opcional na venda. | S |
| RF-VEN-12 | Vendas em espera (held carts) no dispositivo. | S |
| RF-VEN-13 | Item gratuito (100% desconto) exige aprovação. | S |
| RF-VEN-14 | Devoluções e trocas parciais. | W |
| RF-VEN-15 | Vendas a prazo (“fiado”): cliente obrigatório (existente ou criado no próprio formulário com nome e contacto), valor inicial opcional (inclusive zero) e saldo devedor registado na conclusão da venda. | M |
| RF-VEN-16 | Alteração manual de preço no POS. | W |
| RF-VEN-17 | Recuperação de venda após crash: nunca fica venda sem itens/pagamentos nem stock sem baixa. | M |
| RF-VEN-18 | Rascunho do carrinho sobrevive a recarregamento acidental, sem dados sensíveis. | S |
| RF-VEN-19 | Atalhos de teclado para pesquisa, cobrar, desconto, fechar modal e imprimir. | S |
| RF-VEN-20 | Impressão de recibo no browser, com CSS dedicado a 80 mm. | M |

### 9.9 Pagamentos

| ID | Requisito | Prioridade |
|---|---|---|
| RF-PAG-01 | Pagamento em dinheiro com cálculo de troco. | M |
| RF-PAG-02 | Pagamento em cartão, POS, M-Pesa, e-Mola e transferência, com referência opcional. | M |
| RF-PAG-03 | Pagamento misto com várias linhas; no máximo uma linha de dinheiro. | M |
| RF-PAG-04 | A soma dos pagamentos tem de igualar o total para concluir. | M |
| RF-PAG-05 | Troco calculado apenas sobre a linha de dinheiro. | M |
| RF-PAG-06 | Nenhum dado de cartão (PAN, CVV, banda) é introduzido ou guardado. | M |
| RF-PAG-07 | O recibo mostra o detalhe dos pagamentos e o troco. | M |
| RF-PAG-08 | Em vendas a prazo, a soma dos pagamentos iniciais pode ser inferior ao total; o saldo fica pendente e as regularizações são gravadas numa tabela separada, sem inflacionar o mix de pagamentos. | M |
| RF-PAG-09 | Fluxo de regularização no histórico: valor parcial ou total, método, referência e nota opcionais, com auditoria de cada entrada e actualização do saldo em dívida. | M |

### 9.10 Recibos

| ID | Requisito | Prioridade |
|---|---|---|
| RF-REC-01 | Layout para impressora térmica de 80 mm, com fallback A4/PDF. | M |
| RF-REC-02 | Reimpressão com marca “2.ª via”. | M |
| RF-REC-03 | Recibo de venda anulada mostra “ANULADO” e motivo. | M |
| RF-REC-04 | Rodapé “Documento não fiscal” obrigatório no MVP. | M |
| RF-REC-05 | Conteúdo mínimo: loja, NIF, endereço, telefone, recibo, data/hora, operador, cliente/NIF, itens, quantidades, preços, descontos, IVA, total, pagamentos, troco. | M |
| RF-REC-06 | Impressão não inclui cabeçalhos/rodapés do browser quando possível. | M |
| RF-REC-07 | Exportação do recibo em PDF. | C |
| RF-REC-08 | Envio por email/WhatsApp. | W |

### 9.11 Relatórios

| ID | Requisito | Prioridade |
|---|---|---|
| RF-REL-01 | Resumo do dia: vendas brutas, nº de vendas, ticket médio, IVA e descontos. | M |
| RF-REL-02 | Mix por método de pagamento. | M |
| RF-REL-03 | Top produtos por quantidade e valor. | S |
| RF-REL-04 | Stock baixo e esgotados. | M |
| RF-REL-05 | Intervalo de datas humanizado (hoje, ontem, 7/30 dias, semana, mês, todo o período) com intervalo personalizado no calendário, em hora de Maputo. | S |
| RF-REL-11 | Gráficos no relatório: evolução diária/semanal/mensal das vendas, meios de pagamento e produtos mais vendidos, mantendo as tabelas detalhadas. | S |
| RF-REL-12 | Indicadores de vendas a prazo e crédito em aberto no período. | M |
| RF-REL-06 | Total de IVA por período. | M |
| RF-REL-07 | Vendas por operador. | S |
| RF-REL-08 | Exportação CSV de vendas/stock. | C |
| RF-REL-09 | Relatório de lucro/margem (custo incompleto no MVP). | W |
| RF-REL-10 | Todos os relatórios são calculados localmente, sem chamadas de rede. | M |

### 9.12 Auditoria

| ID | Requisito | Prioridade |
|---|---|---|
| RF-AUD-01 | Registo de auditoria local com ator, ação, entidade, antes/depois, timestamp e dispositivo. | M |
| RF-AUD-02 | Auditar login/falha/lockout, vendas, anulações, descontos acima do limite, alterações de preço, stock, utilizadores, definições e backups. | M |
| RF-AUD-03 | Ecrã de consulta com pesquisa por ator/ação/entidade e filtro temporal humanizado com calendário. | S |
| RF-AUD-04 | Retenção mínima de 24 meses; exportação/arquivo. | S |
| RF-AUD-05 | Nenhum PIN, hash ou salt é registado. | M |
| RF-AUD-06 | A UI não permite editar/apagar eventos de auditoria. | M |
| RF-AUD-07 | A app avisa que a auditoria local não é à prova de adulteração por quem controla o dispositivo. | S |

### 9.13 Backup, exportação e importação

| ID | Requisito | Prioridade |
|---|---|---|
| RF-BKP-01 | Exportar a base para um ficheiro `.db` consistente, com nome legível. | M |
| RF-BKP-02 | Importar um `.db` com confirmação, resumo e PIN de proprietário. | M |
| RF-BKP-03 | Validar cabeçalho SQLite, `integrity_check`, versão de schema e tabelas obrigatórias. | M |
| RF-BKP-04 | Antes de importar, criar backup automático da base atual. | M |
| RF-BKP-05 | Lembrar o utilizador se o último backup tiver mais de 24 h ou 50 vendas. | M |
| RF-BKP-06 | Mostrar “último backup” no cabeçalho e nas definições. | M |
| RF-BKP-07 | Backup automático a cada 6 horas, enquanto a app estiver aberta, para uma pasta OPFS `backups/`; verificar e criar ao reabrir se estiver vencido. | S |
| RF-BKP-08 | Backup para pasta escolhida pelo utilizador via File System Access API (Chromium). | S |
| RF-BKP-09 | Exportação opcional encriptada com passphrase (AES-GCM + PBKDF2). | S |
| RF-BKP-10 | Importação nunca corre com uma venda em curso. | M |
| RF-BKP-11 | Após importar, recarregar a app e validar a integridade. | M |
| RF-BKP-12 | A app mostra o resultado de `storage.persist()` e avisa se foi negado. | M |

---

## 10. Regras de negócio

### 10.1 Dinheiro, quantidades e arredondamento

- Todos os valores monetários são **inteiros em centavos** (`INTEGER`, MZN × 100). Nunca usar `float` para dinheiro.
- Quantidades são **inteiros em milésimos** (`qty_milli`): 1 unidade = 1000; 0,5 kg = 500.
- Cada formato de venda tem preço próprio (unidade-base, pacote e meia embalagem). A quantidade vendida e o preço usado são snapshots; a quantidade convertida para unidade-base é usada para movimentar stock.
- A quantidade de pacotes/meias embalagens vendida é inteira. Para unidades discretas, a meia embalagem tem de corresponder a um número inteiro de unidades-base.
- Percentagens são **basis points** (`bp`): 16% = 1600; 5% = 500.
- Arredondamento comercial: **half-up** ao centavo, por linha. A soma das linhas é o total.
- Formatação: `pt-MZ`, duas casas decimais, separador de milhares e vírgula decimal, sufixo `MZN` (ex.: `1 250,00 MZN`).
- Datas são guardadas em ISO 8601 UTC (`created_at`) e apresentadas em `Africa/Maputo` (UTC+2, sem horário de verão).

### 10.2 IVA opcional

Os preços de produto são registados sem IVA. Cada venda pode activar o IVA através do switch, desligado por omissão. Com o switch activo, a taxa configurada em cada produto (16% por omissão, 0% para isentos) é acrescentada ao preço após os descontos.

Por linha:

```text
gross_i        = round(sale_unit_price_cents * sale_qty_milli / 1000)
line_discount_i = desconto da linha (valor ou %), limitado a gross_i
net_before_i   = gross_i - line_discount_i
order_discount_i = maior-resto( net_before_i / Σ net_before * order_discount )
base_i         = net_before_i - order_discount_i
tax_i          = apply_tax ? round(base_i * tax_rate_bp / 10000) : 0
total_i        = base_i + tax_i
```

- `base_i + tax_i = total_i` sempre.
- O total da venda é `Σ total_i`.
- O IVA total é `Σ tax_i`.
- O desconto de venda é distribuído proporcionalmente pelas linhas com o método do maior resto, para que a soma dos descontos seja exatamente o valor introduzido.
- Descontos nunca tornam uma linha negativa.
- A escolha do switch e o IVA calculado ficam guardados no registo da venda.

**Exemplo:** linha de 500,00 MZN com IVA 16% activo: `IVA = round(50000 × 1600 / 10000) = 8000`; total 580,00 MZN. Com IVA desligado, total 500,00 MZN.

### 10.3 Descontos

- O caixa pode aplicar até **5%** por venda (configurável).
- A aprovação é configurável em `Definições`: `never` (nunca exige), `above_limit` (acima do limite do caixa) ou `always` (qualquer desconto exige PIN de gerente/proprietário).
- O desconto é registado com requerente, aprovador, valor, motivo (opcional) e timestamp.
- O proprietário pode autoaprovar; gerente não pode aprovar a própria ação.
- Não há cupões nem descontos automáticos no MVP.

### 10.4 Pagamentos

- A venda só conclui quando `Σ payments.amount_cents = total_cents`.
- No máximo uma linha de dinheiro; os métodos incluem cartão, POS, M-Pesa, e-Mola e transferência.
- Para dinheiro: `tendered_cents >= amount_cents`; `change = Σ(tendered − amount)`.
- Métodos não monetários: `amount_cents` é o valor aplicado; não há troco.
- Não se guardam dados de cartão; apenas método, valor e referência opcional.
- O troco é calculado e mostrado antes de confirmar; a confirmação é explícita.

### 10.5 Stock

- O livro de movimentos é a fonte de verdade; `products.stock_on_hand_milli` é uma cache transacional.
- Tipos de movimento: `initial`, `purchase_in`, `adjustment_in`, `adjustment_out`, `sale`, `sale_void`.
- Se `track_stock = false`, o produto não gera movimentos nem alertas de stock; a venda não baixa stock.
- Venda: movimento negativo por linha; anulação: movimento positivo.
- O stock é contado na unidade-base do produto. Vender um pacote ou meia embalagem converte a quantidade pela configuração do produto; entradas também aceitam pacotes e convertem custo e quantidade para a unidade-base.
- O custo informado numa entrada por pacote é convertido para custo por unidade-base. A unidade-base não pode ser alterada após existirem movimentos de stock ou vendas.
- Se `allow_negative_stock = false`, a venda de produto sem stock exige aprovação de gerente; a aprovação fica registada.
- Se `allow_negative_stock = true` (predefinição), a venda prossegue com aviso visual e stock negativo.
- A entrada de stock atualiza o custo para o último custo, sem FIFO/médio no MVP.
- A reconciliação deve reportar qualquer produto cujo `stock_on_hand` difira da soma dos movimentos.

### 10.6 Números de recibo

- Formato: `{installation_code}-{sequência com 6 dígitos}`, ex.: `T01-000042`.
- A sequência vem da tabela `counters` (`receipt_seq`) e é incrementada **na mesma transação** da venda.
- Anulação não reutiliza o número; o recibo mantém o número e passa a “ANULADO”.
- Importar uma base restaura o contador; não há renumeração.
- O contador é global por instalação, não por operador.

### 10.7 Aprovações

- Aprovações aplicam-se a ações pedidas por um caixa: desconto acima do limite, item gratuito, anulação e venda com stock negativo quando bloqueada.
- Ações de gestão (alterar preço/custo, ajustar stock, repor PIN, importar base) exigem role adequada e, quando aplicável, confirmação do PIN do proprietário; não usam o fluxo de aprovação do caixa.
- O aprovador tem de estar ativo e ter role `manager` ou `owner`.
- A aprovação é um registo com validade de 2 minutos, uso único, vinculada à ação e ao valor.
- A aprovação não cria sessão nem troca o utilizador atual.
- A autoaprovação só é permitida ao `owner` e é marcada como `self_approved = 1`.

### 10.8 Clientes e fornecedores

- Cliente é opcional na venda; se o recibo levar NIF, o cliente é obrigatório.
- Telefone normalizado para `+258XXXXXXXXX` quando começa por 8 ou 2; aceitar formato local e internacional.
- NIF: 9 dígitos; não há validação de checksum no MVP.
- Duplicados de telefone são avisados, mas não bloqueados (famílias partilham telefone).
- Eliminação é lógica (`deleted_at`); vendas históricas mantêm o nome snapshot.
- Fornecedor inativo não aparece em novas entradas de stock, mas o histórico mantém a referência.

### 10.9 Anulações

- Só vendas concluídas podem ser anuladas.
- A anulação exige motivo e aprovação.
- A venda original nunca é apagada; `status = 'voided'`, `voided_at`, `voided_by`, `void_reason`.
- Os movimentos de stock de reposição são inseridos na mesma transação.
- A auditoria regista a aprovação e o motivo.
- Não há devoluções parciais no MVP.

### 10.10 Tempo e fuso horário

- `created_at` em UTC; apresentação em `Africa/Maputo`.
- A hora do dispositivo é usada para a venda; se estiver errada, os relatórios ficam errados.
- A página de diagnóstico mostra a hora local e o offset; não há correção automática sem rede.
- A sequência de recibos não depende da hora.

### 10.11 Eliminação e retenção

- Produtos, clientes, fornecedores e utilizadores usam eliminação lógica.
- Vendas, itens, pagamentos, movimentos de stock e auditoria são imutáveis pela UI.
- Retenção local: 24 meses ou 100 000 vendas; depois, exportar e arquivar (fase 2).
- O utilizador pode exportar a base completa a qualquer momento.

---

## 11. Autenticação, utilizadores e permissões

### 11.1 Matriz de permissões

| Ação | Owner | Manager | Cashier |
|---|---|---|---|
| Vender, consultar catálogo, criar cliente | Sim | Sim | Sim |
| Desconto até ao limite | Sim | Sim | Sim |
| Desconto acima do limite / item gratuito | Sim | Sim | Conforme regra configurável em Definições |
| Anular venda | Sim | Sim | Não (requer aprovação) |
| Criar/editar produtos e categorias | Sim | Sim | Não |
| Alterar preço/custo | Sim | Sim | Não |
| Entrada/ajuste de stock | Sim | Sim | Não |
| Gerir clientes | Sim | Sim | Criar e editar |
| Gerir fornecedores | Sim | Sim | Não |
| Ver relatórios | Sim | Sim | Resumo do dia |
| Gerir utilizadores e PINs | Sim | Não | Não |
| Alterar definições da loja | Sim | Não | Não |
| Exportar backup | Sim | Sim | Não |
| Importar/repor base | Sim | Não | Não |
| Ver auditoria | Sim | Sim | Não |
| Autoaprovar | Sim | Não | Não |

### 11.2 Política de PIN

- PIN numérico de **6 dígitos**; rejeitar sequências óbvias (`000000`, `123456`) e PINs iguais ao username.
- Hash: PBKDF2-SHA-256, salt aleatório de 16 bytes, 600 000 iterations (calibrar para 300–500 ms no dispositivo alvo), chave de 32 bytes.
- Guardar `pin_hash`, `pin_salt`, `pin_iterations` e `pin_algo`; permitir migração futura de parâmetros.
- Comparação em tempo constante.
- Lockout: 5 falhas → 60 s; 10 falhas → 15 min; 20 falhas → apenas reset por proprietário.
- O lockout é por utilizador, não por dispositivo.
- O PIN nunca é enviado para fora do worker; a UI envia-o uma vez e não o guarda.
- O teclado numérico não mostra o PIN; permitir colar? Não no MVP.
- O reset de PIN pelo proprietário define `must_change_pin = 1`.
- O código de recuperação do proprietário é gerado no setup, mostrado uma vez, guardado como PBKDF2, e rotacionado após uso.

### 11.3 Sessão

- A sessão é criada pelo worker após login e devolvida como token opaco em memória.
- A UI guarda o token apenas em memória (Zustand); recarregar a página perde a sessão.
- O worker mantém `user_id`, `role`, `created_at`, `last_activity_at` e valida cada comando.
- Bloqueio automático após 5 min de inatividade (configurável entre 1 e 30 min).
- “Trocar utilizador” invalida a sessão e volta ao ecrã de login.
- Logout explícito invalida a sessão e limpa o carrinho (com confirmação se houver itens).
- Não há “manter sessão iniciada” persistente.

### 11.4 Aprovações sem troca de sessão

Fluxo:

1. A UI pede `approval.request` com `action`, `entity_id`, `amount`, `username`, `pin`.
2. O worker verifica se o aprovador está ativo, tem role adequado e o PIN está correto.
3. O worker verifica limites (ex.: desconto acima do limite, anulação).
4. Cria `approvals` com token opaco, `expires_at = now + 2 min`, `used_at = NULL`.
5. Devolve o token à UI.
6. A ação seguinte (`sale.complete`, `sale.void`, etc.) inclui o token; o worker valida, marca `used_at` e regista auditoria.

Isto evita o problema de trocar a sessão do caixa por um login de gerente e é mais rápido no balcão.

### 11.5 Provisionamento e recuperação

- O primeiro utilizador é criado no setup e tem role `owner`.
- O proprietário cria os restantes utilizadores; não há registo público.
- Não há email, password, OAuth ou better-auth.
- Se o proprietário perder o PIN, usa o código de recuperação.
- Se perder o PIN e o código, não há recuperação pela UI; um técnico pode copiar o `.db` do OPFS, mas os PINs não são reversíveis.
- O reset de PIN de outro utilizador é feito pelo proprietário; não há recuperação por SMS/email.
- O código de recuperação deve ser guardado fora do dispositivo.

### 11.6 Modelo de ameaças (local)

| Ameaça | Impacto | Mitigação no MVP | Risco residual |
|---|---|---|---|
| Dispositivo roubado | Acesso a vendas/dados | PIN, lock por inatividade, encriptação de disco do SO recomendada | Médio |
| Cópia do ficheiro `.db` | Leitura de todos os dados | PIN não encripta a base; backups encriptados opcionais | Alto |
| Força bruta ao PIN | Acesso à app | PBKDF2 600k, lockout, 6 dígitos | Médio (6 dígitos = 1M combinações) |
| XSS | Execução no contexto da app | Sem conteúdo externo, CSP, sem `dangerouslySetInnerHTML` | Baixo/médio |
| Importação de `.db` malicioso | Corrupção/execução | Validar cabeçalho, integridade, schema; nunca executar SQL do ficheiro | Baixo |
| Dois separadores a escrever | Corrupção/duplicados | Web Locks + separador único | Baixo |
| Eviction do browser | Perda de dados | `storage.persist()`, backups, avisos | Alto se não houver backup |
| Service Worker obsoleto | App antiga | Versionamento, prompt de atualização, migrações | Baixo |
| Auditoria adulterada | Perda de prova | Registo local; não é à prova de adulteração | Alto (aceite) |
| Ombro a ombro | PIN observado | Teclado sem feedback do valor, lock rápido | Médio |

> **Nota:** a autorização no cliente não é à prova de um atacante com controlo total do dispositivo. O objetivo é controlo operacional e redução de erro, não DRM.

---

## 12. Arquitetura técnica

### 12.1 Visão geral

```text
┌──────────────────────────────────────────────────────────────┐
│  Browser / PWA instalada (Chromium recomendado)              │
│                                                              │
│  ┌─────────────────────────────┐      postMessage            │
│  │  UI (React 19, Next.js)     │ ◄────────────────────────┐  │
│  │  - páginas client-side      │                          │  │
│  │  - Zustand (sessão/carrinho)│                          │  │
│  │  - Tailwind                 │                          │  │
│  └─────────────────────────────┘                          │  │
│                                                           │  │
│  ┌─────────────────────────────┐      ┌───────────────────┴┐ │
│  │  Service Worker (Serwist)   │      │ sqlite.worker.ts   │ │
│  │  - precache app shell       │      │ - SQLite WASM      │ │
│  │  - offline fallback         │      │ - OPFS VFS         │ │
│  │  - updates                  │      │ - comandos/ACID    │ │
│  └─────────────────────────────┘      │ - auth/PIN         │ │
│                                       │ - backup/export    │ │
│  ┌─────────────────────────────┐      └─────────┬──────────┘ │
│  │  OPFS (origem)              │                │            │
│  │  /pos.sqlite3               │ ◄──────────────┘            │
│  │  /backups/*.db              │                             │
│  └─────────────────────────────┘                             │
└──────────────────────────────────────────────────────────────┘

Sem servidor de dados. Sem API. Sem sync. Sem chamadas de rede em runtime.
```

### 12.2 Stack e responsabilidades

| Camada | Tecnologia | Responsabilidade |
|---|---|---|
| UI | Next.js 16 App Router, React 19, TypeScript, Tailwind 4 | Ecrãs, carrinho, teclado, impressão |
| Estado | Zustand | Sessão em memória, carrinho, preferências de UI |
| PWA | `@serwist/next` | Precache, offline, atualização |
| Worker | `sqlite.worker.ts` | Toda a persistência, auth, comandos, transações |
| DB | `@sqlite.org/sqlite-wasm` + OPFS | SQLite local persistente |
| Cripto | Web Crypto API | PBKDF2, AES-GCM (backup encriptado), aleatoriedade |
| IDs | `crypto.randomUUID()` | Chaves primárias de negócio |
| Datas | `date-fns`/`Intl` | Formatação pt-MZ e Africa/Maputo |
| Testes | Vitest + Playwright | Lógica pura + E2E com OPFS real |

### 12.3 Next.js estático e regras de cliente

- `next.config.ts`: `output: "export"`, `images.unoptimized: true`, `trailingSlash: true`.
- Não existe `app/api/`, `middleware.ts`/`proxy.ts`, nem ficheiros com `"use server"`.
- Todas as páginas e componentes com dados são `"use client"`.
- O layout raiz pode conter apenas metadata estática e o provider de UI; não executa lógica de negócio.
- O build gera HTML/JS/CSS estáticos; o hosting é um servidor de ficheiros estáticos (local ou remoto).
- O deploy pode ser em Cloudflare Pages, Netlify, Vercel static ou um servidor local; não há funções serverless.
- Não há `fetch()` para dados. O único `fetch` permitido é o interno do Service Worker para pré-cache de assets same-origin.
- Fontes e ícones são locais; nada de Google Fonts/CDN em runtime.
- `NEXT_TELEMETRY_DISABLED=1` no build.

### 12.4 Worker SQLite: protocolo e comandos

A UI nunca importa `@sqlite.org/sqlite-wasm` nem vê o handle da base. Comunica por mensagens.

```ts
// lib/db/protocol.ts
type Request =
  | { id: string; type: "auth.login"; payload: { username: string; pin: string } }
  | { id: string; type: "sale.complete"; payload: CompleteSaleInput; session: string }
  | { id: string; type: "backup.export"; payload: { encrypt?: boolean; passphrase?: string }; session: string }
  | { id: string; type: "backup.import"; payload: { bytes: ArrayBuffer }; session: string };

type Response =
  | { id: string; ok: true; data: unknown }
  | { id: string; ok: false; error: { code: string; message: string } };
```

Comandos mínimos:

- `app.init`, `app.health`, `app.migrate`
- `auth.login`, `auth.logout`, `auth.lock`, `auth.changePin`, `auth.resetPin`, `auth.recoverOwner`
- `user.list`, `user.create`, `user.update`, `user.deactivate`
- `product.list`, `product.get`, `product.upsert`, `product.delete`, `category.upsert`
- `stock.entry`, `stock.adjust`, `stock.history`, `stock.reconcile`
- `customer.upsert`, `customer.list`, `supplier.upsert`, `supplier.list`
- `sale.complete`, `sale.void`, `sale.list`, `sale.get`, `sale.reprint`
- `approval.request`, `approval.consume`
- `report.summary`, `report.range`, `report.lowStock`
- `audit.list`
- `backup.export`, `backup.import`, `backup.auto`, `backup.info`
- `settings.get`, `settings.update`

O worker mantém a sessão e verifica permissões em cada comando. A UI não pode executar SQL arbitrário.

### 12.5 Transação ACID de venda

```sql
BEGIN IMMEDIATE;

INSERT INTO sales (id, receipt_number, status, cashier_id, customer_id,
                   subtotal_cents, discount_cents, tax_cents, total_cents,
                   paid_cents, change_cents, note, created_at)
VALUES (?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);

INSERT INTO sale_items (...) VALUES (...); -- uma por linha
INSERT INTO sale_payments (...) VALUES (...); -- uma ou mais
INSERT INTO stock_movements (...) VALUES (...); -- uma por linha com stock
UPDATE products SET stock_on_hand_milli = stock_on_hand_milli - ? WHERE id = ?;
UPDATE counters SET value = value + 1 WHERE name = 'receipt_seq';
INSERT INTO audit_log (...) VALUES (...);

COMMIT;
```

Regras:

- `BEGIN IMMEDIATE` para reservar a escrita.
- Qualquer erro → `ROLLBACK`; a UI nunca mostra “venda concluída” antes do `COMMIT`.
- O número de recibo é lido e incrementado dentro da transação.
- O worker serializa comandos; não há escritas concorrentes dentro do mesmo worker.
- A venda é validada antes: totais, IVA, pagamentos, stock, aprovações, permissões.

### 12.6 OPFS e SQLite WASM

- Ficheiro: `pos.sqlite3` na raiz do OPFS.
- Inicialização no worker: `sqlite3InitModule()` + `new sqlite3.oo1.OpfsDb("/pos.sqlite3")`.
- PRAGMAs iniciais: `foreign_keys = ON`, `busy_timeout = 5000`, `synchronous = FULL`, `temp_store = MEMORY`.
- Não usar WAL no MVP: o VFS OPFS é single-connection e o WAL pode não ser suportado de forma fiável; usar journal padrão e uma única conexão.
- Toda a escrita passa pelo worker; a UI não abre o ficheiro.
- `PRAGMA user_version` controla o schema; migrações em array versionado.
- Antes de migrar: criar cópia em `backups/pre-migrate-<versao>.db`.
- Após migrar: `PRAGMA foreign_key_check` e `PRAGMA quick_check`.
- Em arranque: `quick_check`; se falhar, bloquear escrita e sugerir importar backup.
- Exportação: `VACUUM INTO '/tmp/export.db'`, ler bytes, transferir para a UI, download.
- Importação: escrever bytes num ficheiro temporário, abrir, validar, fechar, substituir `pos.sqlite3`, reabrir.

### 12.7 Multi-separador e concorrência

- OPFS + SQLite não deve ser escrito por dois separadores em simultâneo.
- Usar **Web Locks API**: o primeiro separador adquire `pos-db-writer` em modo exclusivo e mantém-no enquanto estiver aberto.
- Os restantes separadores mostram “O POS está aberto noutro separador” com opção “Abrir aqui” (que fecha a posse do outro via `BroadcastChannel` e recarrega).
- O worker é por separador; apenas o líder tem worker ativo com escrita.
- `BroadcastChannel` sincroniza logout, bloqueio e atualização de dados entre separadores (quando permitido).
- Testar explicitamente dupla submissão de venda e dois separadores.

### 12.8 Service Worker, cache e atualização

- `@serwist/next` gera o service worker no build.
- Precache: app shell, rotas, JS/CSS, fontes, ícones, manifest.
- Navegação: `NetworkFirst` com timeout curto e fallback para a app shell em cache; assets: `CacheFirst`.
- Nunca cachear respostas de dados (não existem).
- `skipWaiting: false`; a nova versão fica em `waiting` e a UI mostra “Atualizar”.
- A atualização é bloqueada se houver carrinho com itens ou venda em curso.
- Ao ativar: backup automático → migração → reload.
- Limpar caches antigas por versão.
- O Service Worker não deve interferir com OPFS.

### 12.9 Cross-origin isolation e headers

O SQLite WASM pode requerer `SharedArrayBuffer`/cross-origin isolation, dependendo do build. O deployment tem de garantir:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
```

- Se o hosting não permitir estes headers, usar um build de `sqlite-wasm` que não exija `SharedArrayBuffer` ou servir a app a partir de um servidor local que os defina.
- HTTPS é obrigatório para OPFS, Service Worker e Web Crypto em produção (exceto `localhost`).
- Testar o build exato com e sem os headers antes de fechar a arquitetura.

### 12.10 Segurança da aplicação

- CSP baseline: `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`.
- `wasm-unsafe-eval` é necessário para SQLite WASM; documentar e restringir.
- Endurecer CSP com hashes/nonces numa fase de hardening; o Next static export injeta scripts inline.
- Sem `dangerouslySetInnerHTML` com dados de utilizador.
- Sem `eval`, sem scripts de terceiros.
- Todo o SQL parametrizado; comandos de domínio validados com Zod no worker.
- Limitar o tamanho de importação e validar o ficheiro antes de substituir a base.
- Não guardar PIN, hashes ou salts em logs.
- Recomendar encriptação de disco do dispositivo e bloqueio de ecrã do SO.
- A exportação encriptada (AES-GCM + PBKDF2) é recomendada para backups fora do dispositivo.

### 12.11 Estrutura de pastas sugerida

```text
app/
  layout.tsx                 # metadata estática + providers
  page.tsx                   # redireciona para /vendas ou /entrar
  (auth)/entrar/page.tsx
  (app)/vendas/page.tsx
  (app)/historico/page.tsx
  (app)/produtos/page.tsx
  (app)/stock/page.tsx
  (app)/clientes/page.tsx
  (app)/fornecedores/page.tsx
  (app)/relatorios/page.tsx
  (app)/definicoes/page.tsx
  (app)/backup/page.tsx
  (app)/auditoria/page.tsx
  sw.ts                      # Serwist
components/
lib/
  db/protocol.ts
  db/client.ts               # message bus
  db/sqlite.worker.ts
  db/migrations/
  db/commands/
  auth/pin.ts
  auth/session.ts
  domain/money.ts
  domain/tax.ts
  domain/permissions.ts
  domain/validation.ts
  backup/export.ts
  backup/import.ts
public/
  manifest.webmanifest
  icons/
```

### 12.12 Tratamento de erros e recuperação

- Erros do worker têm código estável (`DB_CORRUPT`, `PIN_LOCKED`, `FORBIDDEN`, `APPROVAL_REQUIRED`, `IMPORT_INVALID`, etc.).
- A UI mostra mensagens em português, acionáveis, sem stack traces.
- Erros de transação fazem rollback e mantêm o carrinho intacto.
- Se a base falhar no arranque: modo de recuperação com “Importar backup” e “Exportar base atual”.
- Se o worker falhar: a UI mostra “Reiniciar aplicação” e tenta recriar o worker; nunca apaga a base.
- Logs técnicos ficam num buffer em memória e podem ser exportados pelo utilizador (sem PIN).

---

## 13. Modelo de dados local

### 13.1 Convenções

- Todas as chaves primárias de negócio são `TEXT` com `crypto.randomUUID()`.
- **Nenhuma tabela de negócio usa `AUTOINCREMENT`.** A única sequência é a tabela `counters`, com chave textual.
- Valores monetários: `INTEGER` em centavos.
- Quantidades: `INTEGER` em milésimos.
- Percentagens: `INTEGER` em basis points.
- Datas: `TEXT` ISO 8601 UTC.
- Eliminação lógica: `deleted_at TEXT NULL`; vendas/stock/auditoria são imutáveis.
- `NOT NULL` e `CHECK` para invariantes simples; invariantes entre tabelas são validadas no worker.
- `PRAGMA foreign_keys = ON`.

### 13.2 Tabelas

| Tabela | Campos principais | Notas |
|---|---|---|
| `app_meta` | `key TEXT PK`, `value TEXT` | `installation_id`, `created_at`, `last_backup_at`, `storage_persisted` |
| `users` | `id`, `username UNIQUE`, `display_name`, `role`, `active`, `pin_hash`, `pin_salt`, `pin_iterations`, `pin_algo`, `failed_attempts`, `locked_until`, `must_change_pin`, `last_login_at`, `login_shortcut`, `created_at`, `updated_at` | `role IN ('owner','manager','cashier')`; `login_shortcut BETWEEN 1 AND 9`, único quando preenchido |
| `recovery_codes` | `id`, `user_id`, `hash`, `salt`, `iterations`, `created_at`, `used_at`, `rotated_at` | Apenas para o proprietário |
| `settings` | `id TEXT PK CHECK(id='default')`, `store_name`, `nif`, `address`, `phone`, `currency`, `tax_rate_bp`, `receipt_footer`, `installation_code`, `allow_negative_stock`, `max_cashier_discount_bp`, `discount_approval_mode`, `idle_lock_seconds`, `created_at`, `updated_at` | Uma linha; `discount_approval_mode IN ('never','above_limit','always')` |
| `categories` | `id`, `name`, `sort_order`, `created_at`, `updated_at`, `deleted_at` |  |
| `products` | `id`, `sku`, `name`, `color`, `search_text`, `category_id`, `unit`, `price_cents`, `package_qty_milli`, `package_price_cents`, `half_package_price_cents`, `sell_by_unit`, `sell_by_package`, `sell_by_half_package`, `cost_cents`, `tax_rate_bp`, `track_stock`, `stock_on_hand_milli`, `low_stock_threshold_milli`, `active`, `created_at`, `updated_at`, `deleted_at` | Variantes activas únicas por SKU/nome/cor; stock e custo na unidade-base |
| `product_barcodes` | `id`, `product_id`, `barcode UNIQUE`, `is_primary` | Vários por produto |
| `customers` | `id`, `name`, `phone`, `phone_normalized`, `alt_phone`, `nif`, `email`, `address`, `notes`, `created_at`, `updated_at`, `deleted_at` |  |
| `suppliers` | `id`, `name`, `contact_name`, `phone`, `nif`, `email`, `address`, `notes`, `active`, `created_at`, `updated_at`, `deleted_at` |  |
| `stock_movements` | `id`, `product_id`, `type`, `qty_milli`, `balance_after_milli`, `unit_cost_cents`, `supplier_id`, `supplier_name_snapshot`, `document_ref`, `reason`, `sale_id`, `user_id`, `created_at` | `qty_milli <> 0`; tipos enumerados |
| `sales` | `id`, `receipt_number UNIQUE`, `status`, `cashier_id`, `cashier_name_snapshot`, `customer_id`, `customer_name_snapshot`, `customer_nif_snapshot`, `subtotal_cents`, `discount_cents`, `tax_cents`, `tax_applied`, `total_cents`, `paid_cents`, `change_cents`, `note`, `created_at`, `voided_at`, `voided_by`, `void_reason` | `tax_applied` é snapshot da escolha na venda; `status IN ('completed','voided')` |
| `sale_items` | `id`, `sale_id`, `product_id`, `name_snapshot`, `sku_snapshot`, `barcode_snapshot`, `unit`, `sale_unit`, `unit_price_cents`, `sale_qty_milli`, `qty_milli`, `gross_cents`, `line_discount_cents`, `order_discount_cents`, `tax_rate_bp`, `base_cents`, `tax_cents`, `total_cents` | `sale_unit`, preço e quantidade vendida são snapshots; `qty_milli` é a quantidade na unidade-base retirada do stock |
| `sale_payments` | `id`, `sale_id`, `method`, `amount_cents`, `tendered_cents`, `reference`, `created_at` | `method IN ('cash','card','pos','mpesa','emola','transfer','other')` |
| `approvals` | `id`, `action`, `entity_type`, `entity_id`, `amount_cents`, `requested_by`, `approver_id`, `created_at`, `expires_at`, `used_at`, `metadata_json` | Token opaco devolvido à UI; uso único |
| `audit_log` | `id`, `actor_id`, `action`, `entity_type`, `entity_id`, `before_json`, `after_json`, `created_at`, `device_info` | Sem PIN/hash |
| `counters` | `name TEXT PK`, `value INTEGER NOT NULL` | `receipt_seq` |
| `backup_log` | `id`, `created_at`, `method`, `size_bytes`, `note`, `schema_version` | `method IN ('manual','auto','pre_migrate','pre_import','pre_reset')` |
| `schema_migrations` | `version INTEGER PK`, `applied_at TEXT` | Além de `PRAGMA user_version` |

### 13.3 Índices

```sql
CREATE UNIQUE INDEX idx_users_username ON users(username);
CREATE UNIQUE INDEX idx_products_sku ON products(sku);
CREATE INDEX idx_products_search ON products(search_text);
CREATE INDEX idx_products_category ON products(category_id);
CREATE INDEX idx_products_active ON products(active, deleted_at);
CREATE UNIQUE INDEX idx_barcodes_value ON product_barcodes(barcode);
CREATE INDEX idx_customers_phone ON customers(phone_normalized);
CREATE INDEX idx_customers_name ON customers(name);
CREATE INDEX idx_suppliers_name ON suppliers(name);
CREATE UNIQUE INDEX idx_sales_receipt ON sales(receipt_number);
CREATE INDEX idx_sales_created ON sales(created_at);
CREATE INDEX idx_sales_customer ON sales(customer_id);
CREATE INDEX idx_sales_status ON sales(status);
CREATE INDEX idx_sale_items_sale ON sale_items(sale_id);
CREATE INDEX idx_sale_items_product ON sale_items(product_id);
CREATE INDEX idx_stock_product_date ON stock_movements(product_id, created_at);
CREATE INDEX idx_stock_sale ON stock_movements(sale_id);
CREATE INDEX idx_audit_created ON audit_log(created_at);
CREATE INDEX idx_audit_actor ON audit_log(actor_id);
CREATE INDEX idx_approvals_pending ON approvals(expires_at, used_at);
```

### 13.4 Invariantes

- `sales.total_cents = sales.subtotal_cents - sales.discount_cents`.
- `sales.paid_cents = Σ sale_payments.amount_cents` para vendas concluídas.
- `sales.tax_cents = Σ sale_items.tax_cents`.
- `Σ sale_items.total_cents = sales.total_cents`.
- Alterações posteriores ao catálogo nunca modificam `sale_items.sale_unit`, `sale_qty_milli` ou `unit_price_cents` de vendas existentes.
- `products.stock_on_hand_milli = Σ stock_movements.qty_milli` (reconciliação).
- `sales.receipt_number` único; `counters.receipt_seq` estritamente crescente.
- Venda anulada tem `voided_at`, `voided_by`, `void_reason` e movimentos `sale_void`.
- Nenhuma venda concluída sem pelo menos um pagamento.
- Nenhum pagamento em dinheiro com `tendered_cents < amount_cents`.
- Nenhum produto com `qty_milli <= 0` numa linha de venda.

### 13.5 Validação de comandos

Todos os comandos do worker validam o payload com **Zod** antes de tocar na base. Exemplos:

- `product.upsert`: nome não vazio, preços >= 0, unidade válida, conversão e meia embalagem válidas, IVA 1600, barcode único.
- `sale.complete`: linhas não vazias, quantidades e formatos de venda válidos, descontos dentro dos limites, aprovações válidas, pagamentos = total.
- `stock.entry`: quantidade e formato de entrada válidos, conversão para unidade-base exacta, custo >= 0, motivo/documento conforme tipo.
- `backup.import`: bytes > 0, limite máximo, cabeçalho SQLite válido, schema compatível.

---

## 14. Backup, exportação, importação e recuperação

### 14.1 Porque é crítico

Sem servidor, **o `.db` do OPFS é a única cópia dos dados**. Limpar os dados do site, desinstalar a PWA, uma falha do disco ou uma eviction do browser podem apagar tudo. O backup não é uma funcionalidade secundária; é o mecanismo de continuidade.

### 14.2 Exportação

1. O proprietário abre “Backup” → “Exportar”.
2. O worker executa `VACUUM INTO '/tmp/pos-export.db'` (snapshot consistente).
3. O worker lê o ficheiro, devolve um `ArrayBuffer` transferível e apaga o temporário.
4. A UI gera um `Blob` e descarrega com o nome:
   `{slug-da-loja}-backup-{YYYYMMDD-HHmm}.db`
5. A app atualiza `app_meta.last_backup_at` e insere `backup_log`.
6. Opcionalmente, encripta com passphrase:
   - PBKDF2-SHA-256 (600 000 iterations) → chave AES-256-GCM;
   - salt 16 bytes + IV 12 bytes;
   - ficheiro `.db.enc` com magic `POSENC1`.

**Recomendação operacional:** guardar o backup fora do dispositivo (pen, disco externo, nuvem pessoal) e testar o restauro periodicamente.

### 14.3 Importação

1. O proprietário abre “Backup” → “Importar”.
2. Escolhe o ficheiro `.db` (ou `.db.enc` + passphrase).
3. O worker valida:
   - tamanho máximo (ex.: 512 MB);
   - cabeçalho `SQLite format 3\0`;
   - `PRAGMA integrity_check` = `ok`;
   - `PRAGMA foreign_key_check` sem linhas;
   - `PRAGMA user_version` <= versão da app;
   - tabelas obrigatórias e uma linha em `settings`;
   - pelo menos um utilizador `owner`.
4. A UI mostra um resumo: nome da loja, nº de vendas, nº de produtos, data do último registo.
5. Confirmação com PIN de proprietário.
6. O worker faz `VACUUM INTO` da base atual para `backups/pre-import-...db`.
7. Fecha a base, substitui `pos.sqlite3` pelo ficheiro importado, reabre.
8. Corre migrações se o schema for mais antigo.
9. Valida integridade e recarrega a app.

**Regras:**

- Nunca importar com uma venda em curso.
- Nunca importar um ficheiro de schema mais recente.
- Nunca confiar no conteúdo do ficheiro para executar SQL arbitrário.
- Se a importação falhar, a base atual fica intacta.

### 14.4 Backups automáticos locais

- A cada 6 horas, se a app estiver aberta, o worker cria uma cópia em `backups/auto-*.db`; ao reabrir, cria uma cópia se o intervalo tiver vencido.
- Reter até 28 cópias recentes (7 dias, à cadência de 6 horas) + 4 cópias semanais anteriores.
- Estes backups vivem no mesmo OPFS; **não protegem contra limpeza dos dados do site**. Servem para erros de importação/migração.
- O utilizador deve exportar para fora do dispositivo.

### 14.5 Lembretes

- Banner no cabeçalho: “Último backup: há X dias”.
- Aviso se `last_backup_at` > 24 h ou > 50 vendas desde o último backup.
- Aviso persistente se `navigator.storage.persist()` foi negado.
- No setup, sugerir o primeiro backup.
- Antes de migrar ou importar, backup obrigatório.

### 14.6 Recuperação de acesso

- Código de recuperação do proprietário: 20 bytes aleatórios em base32, mostrado uma vez no setup.
- Guardado como PBKDF2 (salt + iterations), com `used_at`.
- “Esqueci o PIN” → introduzir código → definir novo PIN → rotacionar código e mostrar o novo.
- Após 5 tentativas erradas, bloquear 15 min.
- Se o código também se perder, não há recuperação de acesso; a base pode ser exportada, mas os PINs não são reversíveis.
- O reset de PIN de outro utilizador é feito pelo proprietário, sem código de recuperação.

### 14.7 Cenários de perda e resposta

| Cenário | Efeito | Resposta |
|---|---|---|
| Limpar dados do site | Base apagada | Importar o último `.db` exportado |
| Desinstalar PWA | Pode apagar OPFS | Importar backup |
| Eviction do browser | Base apagada | `persist()` + backups externos |
| Corrupção do SQLite | App não abre | Modo de recuperação + importar backup |
| Importação errada | Dados substituídos | Backup `pre_import` automático |
| Migração falhada | App não abre | Backup `pre_migrate` + rollback |
| Dispositivo perdido | Dados expostos | PIN + encriptação de disco; sem wipe remoto |
| Disco avariado | Tudo perdido | Backup externo |

### 14.8 RPO/RTO

- **RPO:** até 24 h (com backup diário) ou 0 se o utilizador exportar após cada fecho.
- **RTO:** < 15 min (importar `.db` + validar).
- Estes valores dependem do comportamento do utilizador; a app deve tornar o backup fácil e visível.

---

## 15. UX/UI

### 15.1 Princípios

- **Velocidade:** pesquisa → adicionar → cobrar em poucos gestos.
- **Clareza:** totais, troco e estado do stock sempre visíveis.
- **Confiança:** a app nunca mostra “venda concluída” antes do commit; o recibo é a prova.
- **Segurança operacional:** ações destrutivas exigem aprovação e mostram o impacto.
- **Local-first:** a UI fala em “dados neste dispositivo” e “backup”, não em “sincronização”.
- **Teclado e toque:** funciona com scanner, teclado físico e tablet.
- **Português simples:** mensagens curtas, sem jargão técnico.

### 15.2 Ecrãs

| Ecrã | Conteúdo |
|---|---|
| Setup | Loja, proprietário, PIN, código de recuperação, primeiro backup |
| Entrar | Lista de utilizadores + teclado numérico; lockout |
| Vendas (POS) | Pesquisa, grelha/lista de produtos, carrinho, totais, cobrar |
| Pagamento | Métodos, valores, troco, confirmação |
| Recibo | Pré-visualização 80 mm, imprimir, reimprimir, nova venda |
| Histórico | Filtros, detalhe, reimpressão, anulação |
| Produtos | Lista, pesquisa, criar/editar, categorias, códigos de barras |
| Stock | Entrada, ajuste, histórico, stock baixo, reconciliação |
| Clientes | Lista, ficha, histórico de compras |
| Fornecedores | Lista, ficha, entradas associadas |
| Relatórios | Resumo do dia, período, pagamentos, top produtos, IVA |
| Auditoria | Filtros por ator/ação/data |
| Definições | Loja, utilizadores, segurança, impressão, armazenamento |
| Backup | Exportar, importar, último backup, backups automáticos, encriptação |
| Diagnóstico | Versão, schema, integridade, quota, persistência, browser |

### 15.3 Layout do POS

```text
┌──────────────────────────────────────────────────────────────┐
│ Loja · Operador · Local · Último backup há 2 h      [Bloquear]│
├───────────────────────────────┬──────────────────────────────┤
│ [ Pesquisar nome / SKU / EAN ]│  Carrinho                    │
│                               │  ┌────────────────────────┐  │
│  Categorias: [Todos] [Bebidas]│  │ Arroz 5kg     2 x 250  │  │
│                               │  │ Óleo 1L       1 x 180  │  │
│  ┌─────────┐ ┌─────────┐      │  └────────────────────────┘  │
│  │ Produto │ │ Produto │      │  Cliente: [Consumidor final] │
│  │ 250,00  │ │ 180,00  │      │  Subtotal        680,00 MZN  │
│  └─────────┘ └─────────┘      │  Desconto        -20,00 MZN  │
│                               │  IVA (16% incl.)  91,03 MZN  │
│  ...                          │  TOTAL           660,00 MZN  │
│                               │  [ Desconto ] [  COBRAR  ]   │
└───────────────────────────────┴──────────────────────────────┘
```

- Foco automático na pesquisa; scanner adiciona e devolve o foco.
- Produtos esgotados/negativos com badge.
- Total grande, alto contraste.
- Botão “Cobrar” sempre visível; atalho `F4`.
- Modal de pagamento com teclado numérico e sugestões de notas (100, 200, 500, 1000).
- Troco em destaque.
- Aviso se o stock ficar negativo após a venda.

### 15.4 Atalhos de teclado

| Tecla | Ação |
|---|---|
| `F2` / `/` | Focar pesquisa |
| `F4` | Cobrar |
| `F6` | Desconto |
| `F8` | Cliente |
| `Esc` | Fechar modal / limpar pesquisa |
| `Enter` | Confirmar |
| `Ctrl+P` | Imprimir recibo |
| `Ctrl+L` | Bloquear sessão |
| `Delete` | Remover linha selecionada (com confirmação) |

### 15.5 Estados e mensagens

- **Offline:** “Sem ligação — a funcionar localmente.” (não bloqueia nada)
- **Backup atrasado:** banner amarelo com “Exportar agora”.
- **Armazenamento não persistente:** banner vermelho com explicação.
- **PIN errado:** “PIN incorreto. Tentativas restantes: N.”
- **Lockout:** “Demasiadas tentativas. Tente novamente em 60 s.”
- **Stock negativo:** “Atenção: stock negativo. A venda foi registada.”
- **Aprovação necessária:** modal com nome do aprovador e motivo.
- **Erro de transação:** “Não foi possível concluir a venda. Nada foi alterado.”
- **Importação inválida:** “Ficheiro inválido ou incompatível. A base atual não foi alterada.”

### 15.6 Recibo (80 mm)

```text
        NOME DA LOJA
      NIF: 400123456
  Av. Eduardo Mondlane, 123
      Tel: +258 84 000 0000
--------------------------------
Recibo: T01-000042
Data: 13/11/2026 14:32
Operador: Ana
Cliente: João Silva
NIF: 123456789
--------------------------------
2 x Arroz 5kg
  250,00 x 2          500,00
1 x Óleo 1L
  180,00              180,00
--------------------------------
Subtotal              680,00
Desconto              -20,00
IVA 16% (incl.)        91,03
TOTAL                 660,00 MZN
--------------------------------
Dinheiro              700,00
Troco                  40,00
--------------------------------
Obrigado pela preferência!
Documento não fiscal.
```

- Largura 80 mm; fonte monoespaçada; margens mínimas.
- `@media print` remove navegação, botões e cabeçalhos.
- Reimpressão: “2.ª via”.
- Anulada: marca de água “ANULADO” + motivo.

### 15.7 Acessibilidade

- Alvos de toque >= 44×44 px.
- Contraste WCAG 2.1 AA.
- Navegação por teclado em todos os fluxos.
- Rótulos ARIA em ícones e botões.
- Não depender apenas de cor para stock negativo/erro.
- Foco visível.
- Texto redimensionável sem quebrar o layout.
- Modais com foco preso e `Esc` para fechar.

### 15.8 Onboarding e confiança

- No primeiro arranque, explicar em 3 passos: “Os dados ficam neste dispositivo”, “Exporte backups”, “O PIN protege o acesso, mas não encripta a base”.
- Pedir confirmação explícita antes de começar a vender.
- Mostrar o código de recuperação com botão “Copiar” e “Já guardei”.
- Guia rápido de 1 página no ecrã de ajuda.

---

## 16. Requisitos não-funcionais

### 16.1 Desempenho

| Métrica | Alvo |
|---|---|
| Arranque da app instalada | < 2,5 s em tablet Android médio |
| Pesquisa de produto (20 000) | P95 < 50 ms |
| Adicionar ao carrinho | < 50 ms |
| Commit de venda | P95 < 300 ms |
| Abertura do histórico (100 000 vendas) | < 500 ms com paginação |
| Exportação de 100 MB | < 30 s |
| Importação de 100 MB | < 60 s |
| Bundle inicial JS (gzip) | < 300 kB, excluindo WASM |
| SQLite WASM | Carregar uma vez, em worker, com cache HTTP |

As listas extensas de produtos, vendas, auditoria, movimentos de stock, clientes e
fornecedores devem usar paginação no worker SQLite, com contagem total e filtros
aplicados antes do limite e deslocamento. A interface deve permitir navegar entre
páginas e manter a pesquisa/filtros activos.

### 16.2 Fiabilidade

- Nenhuma venda confirmada pode perder-se.
- Transações ACID para venda, anulação, stock, pagamentos e contador.
- `quick_check` + `foreign_key_check` no arranque e após importação.
- Recuperação de crash via journal do SQLite.
- Se o worker falhar, a UI não apaga a base; oferece reinício e exportação.
- Backup antes de migração/importação.
- Testes de falha injetada (erro no meio da transação).

### 16.3 Segurança

- HTTPS obrigatório em produção.
- PIN com PBKDF2-SHA-256 (>= 600k), salt por utilizador, comparação em tempo constante.
- Lockout e bloqueio por inatividade.
- Sessão apenas em memória.
- Sem PIN/hash/salt em logs ou storage.
- CSP restritiva; sem scripts de terceiros; sem `eval`.
- SQL parametrizado; validação Zod no worker.
- Importação validada e limitada em tamanho.
- Backups externos recomendados; exportação encriptada opcional.
- Encriptação de disco do SO recomendada (não controlada pela app).
- A app deve deixar claro que a base local não é encriptada em repouso.

### 16.4 Privacidade

- Recolher apenas dados necessários: nome, telefone, NIF, email, endereço.
- Sem analytics, telemetria, publicidade ou chamadas externas.
- Dados nunca saem do dispositivo sem ação explícita de exportação.
- Eliminação lógica de clientes; vendas históricas mantêm snapshot.
- O utilizador pode exportar a base completa.
- Não guardar dados de cartão.

### 16.5 Compatibilidade

- **Recomendado:** Chrome/Edge 120+ em desktop/Android; PWA instalada.
- **Mínimo:** Chromium com OPFS, Web Crypto, Web Locks, Service Worker, `crypto.randomUUID`.
- **Safari/iOS:** suporte a OPFS/Web Worker/SQLite WASM é variável; não é alvo oficial do MVP. A app deve bloquear com mensagem clara se faltar uma API.
- Resolução mínima: 1024×600; recomendado 1366×768 ou tablet landscape.
- Impressoras térmicas 58/80 mm via driver do SO + impressão do browser.
- Scanner de código de barras USB/Bluetooth em modo keyboard wedge.
- Sem dependência de rede após a primeira carga/instalação.

### 16.6 Acessibilidade

- WCAG 2.1 AA nos fluxos principais.
- Navegação completa por teclado.
- Foco visível e ordem lógica.
- Rótulos ARIA e mensagens de erro associadas.
- Contraste mínimo 4,5:1 para texto.
- Alvos de toque >= 44 px.
- Suporte a zoom 200%.

### 16.7 Localização

- Interface em português de Moçambique (pt-MZ).
- Moeda MZN, formato `1 250,00 MZN`.
- Fuso `Africa/Maputo`.
- NIF e telefone com formatos locais.
- Datas `dd/mm/aaaa` e horas 24 h.
- Textos centralizados num dicionário para futura tradução.

### 16.8 Armazenamento e retenção

- `navigator.storage.persist()` no arranque; se o browser exigir gesto do utilizador, mostrar o botão “Ativar armazenamento persistente” no setup e nas definições.
- Mostrar quota e uso.
- Alerta quando o uso > 80% da quota.
- Retenção local: 24 meses ou 100 000 vendas.
- Exportação/arquivo antes de purgar (fase 2).
- Backups automáticos limitados a 28 cópias recentes (7 dias, à cadência de 6 horas) + 4 cópias semanais anteriores.

### 16.9 Manutenibilidade

- TypeScript strict.
- ESLint + Prettier.
- Separação clara: UI, domínio, worker, persistência.
- Comandos do worker testáveis sem UI.
- Migrações versionadas e documentadas.
- Sem dependências de servidor.
- Documentação de recuperação e backup no README.

### 16.10 Observabilidade local

- Página de diagnóstico: versão da app, `user_version`, tamanho da base, quota, persistência, último backup, integridade, browser, service worker.
- Buffer de erros em memória, exportável (sem PIN).
- Sem telemetria remota.
- Logs de desenvolvimento no console; em produção, apenas buffer local.

---

## 17. Critérios de aceitação

### CA-01 — Setup inicial

**Dado** que a app é aberta pela primeira vez,  
**quando** o utilizador preenche loja, proprietário, PIN e confirma o código de recuperação,  
**então** a base é criada no OPFS, o utilizador `owner` existe, o código de instalação é gerado, o setup fica inacessível e o POS abre.

### CA-02 — Login e lockout

**Dado** um utilizador ativo,  
**quando** introduz o PIN errado 5 vezes,  
**então** fica bloqueado 60 s, vê o tempo restante e o evento é auditado; após o bloqueio, o PIN correto inicia sessão.

### CA-03 — Arranque offline

**Dado** que a app foi instalada e usada pelo menos uma vez,  
**quando** a rede é desligada e a página é recarregada,  
**então** a app abre, o login por PIN funciona e uma venda pode ser concluída sem qualquer pedido de rede para dados.

### CA-04 — Venda ACID

**Dado** um produto com stock 10,  
**quando** ocorre um erro simulado após inserir a venda mas antes do commit,  
**então** a transação faz rollback, a venda não existe, o stock continua 10 e o contador de recibos não avança.

### CA-05 — Venda em dinheiro

**Dado** um produto de 250,00 MZN com stock 10,  
**quando** o caixa vende 2 unidades e recebe 500,00 MZN,  
**então** o total é 500,00 MZN, o troco é 0, o stock fica 8, o recibo é `T01-000001` e a venda aparece no histórico.

### CA-06 — Pagamento misto e troco

**Dado** um total de 660,00 MZN,  
**quando** o caixa aplica 400,00 MZN em dinheiro (tendered 500,00) e 260,00 MZN em cartão,  
**então** a venda conclui, o troco é 100,00 MZN e o recibo detalha os dois métodos.

### CA-07 — Desconto acima do limite

**Dado** um caixa com limite de 5%,  
**quando** tenta aplicar 10% de desconto,  
**então** a app pede PIN de gerente; com PIN válido, o desconto é aplicado e a auditoria regista requerente, aprovador e valor; sem PIN, a venda não conclui.

### CA-08 — Anulação

**Dado** uma venda concluída com 2 unidades,  
**quando** um gerente a anula com motivo e aprovação,  
**então** a venda fica `voided`, o stock é reposto, o recibo mostra “ANULADO” e a auditoria regista o motivo.

### CA-09 — Stock negativo

**Dado** `allow_negative_stock = false` e um produto com stock 0,  
**quando** o caixa tenta vender,  
**então** a venda é bloqueada e é pedida aprovação de gerente; com aprovação, a venda conclui e o stock fica negativo com aviso.

### CA-10 — Exportar/importar

**Dado** uma base com vendas, produtos e clientes,  
**quando** o proprietário exporta o `.db`, repõe a app e importa o ficheiro,  
**então** o resumo confirma os mesmos totais, a integridade é `ok`, o contador de recibos continua e os dados estão disponíveis offline.

### CA-11 — Importação inválida

**Dado** um ficheiro que não é SQLite ou tem schema mais recente,  
**quando** o proprietário tenta importar,  
**então** a app rejeita, mostra o motivo e a base atual permanece inalterada.

### CA-12 — Persistência de armazenamento

**Dado** um browser que suporta `navigator.storage.persist()`,  
**quando** a app arranca,  
**então** solicita persistência, mostra o resultado e, se negado, exibe um aviso persistente para exportar backups.

### CA-13 — Zero rede

**Dado** a app em funcionamento,  
**quando** se intercetam todos os pedidos de rede,  
**então** não há pedidos para persistir dados, autenticar, carregar fontes/ícones ou analisar; apenas assets same-origin do Service Worker.

### CA-14 — Multi-separador

**Dado** o POS aberto no separador A,  
**quando** se abre o separador B,  
**então** B mostra “aberto noutro separador” e não escreve na base; ao assumir, A perde a posse e não ocorrem vendas duplicadas.

### CA-15 — Atualização com migração

**Dado** uma base na versão N e uma app na versão N+1,  
**quando** o utilizador aceita atualizar,  
**então** é criado um backup `pre_migrate`, a migração corre em transação e a app só recarrega após sucesso; em falha, mantém a versão anterior e mostra instruções.

### CA-16 — Recibo

**Dado** uma venda concluída,  
**quando** o utilizador imprime,  
**então** o recibo 80 mm contém todos os campos obrigatórios, o aviso “Documento não fiscal”, o troco e o detalhe de pagamentos; a reimpressão indica “2.ª via”.

### CA-17 — Recuperação de PIN

**Dado** que o proprietário esqueceu o PIN,  
**quando** introduz o código de recuperação correto,  
**então** define um novo PIN, o código é rotacionado e o evento é auditado.

### CA-18 — Desempenho

**Dado** 20 000 produtos e 100 000 vendas,  
**quando** se pesquisa um produto e se conclui uma venda,  
**então** a pesquisa fica abaixo de 50 ms (P95) e o commit abaixo de 300 ms (P95) no dispositivo de referência.

---

## 18. Estratégia de testes

### 18.1 Unitários (Vitest)

- Fórmulas de IVA, descontos, distribuição pelo maior resto e arredondamento.
- Normalização de telefone/NIF, pesquisa sem acentos, formatação MZN.
- Permissões por role e regras de aprovação.
- Validação Zod dos comandos.
- Geração/verificação de PIN com Web Crypto (mock ou ambiente Node com `crypto.subtle`).
- Validação de ficheiros de importação (cabeçalho, schema, tamanho).
- Geração de nomes de backup e rotação do código de recuperação.

### 18.2 Integração do worker (Playwright/Chromium)

- Criar base OPFS, correr migrações, inserir e ler dados.
- Transação de venda com sucesso e com rollback forçado.
- Contador de recibos sob submissão duplicada.
- Anulação com reposição de stock.
- Reconciliação de stock.
- Exportar → apagar → importar → validar.
- Importar ficheiro inválido/mais recente.
- Migração de schema com backup.
- Lockout de PIN e recuperação.
- Multi-separador com Web Locks.

### 18.3 E2E (Playwright)

- Setup completo.
- Login, bloqueio por inatividade, troca de utilizador.
- Venda em dinheiro, cartão e mista.
- Desconto com aprovação.
- Anulação.
- Entrada/ajuste de stock.
- Cliente/fornecedor.
- Relatórios do dia.
- Exportação/importação.
- Recarregar offline.
- Atualização do Service Worker.
- Impressão (verificar conteúdo do recibo no DOM e CSS de impressão).

### 18.4 PWA e offline

- Lighthouse PWA/performance.
- `context.setOffline(true)` + reload.
- Verificar que o Service Worker serve a app shell e as rotas.
- Verificar que não há pedidos de dados (interceção de rede).
- Instalação e arranque em modo standalone.
- Atualização com `skipWaiting: false`.

### 18.5 Carga e volume

- Seed com 20 000 produtos, 10 000 clientes e 100 000 vendas.
- Medir pesquisa, abertura do histórico, relatórios e exportação.
- Testar base perto de 100 MB.
- Testar quota baixa (simular) e aviso.

### 18.6 Segurança

- Tentar aceder a comandos sem sessão/role.
- Tentar autoaprovação como manager.
- Tentar importar ficheiro malicioso/grande.
- Verificar ausência de PIN/hash em logs e storage.
- Verificar CSP e ausência de scripts externos.
- Verificar que a UI não consegue executar SQL arbitrário.

### 18.7 Manual

- Matriz de impressoras 58/80 mm (Chrome/Edge, Windows/Android).
- Scanners USB/Bluetooth.
- Tablets low-end e ecrãs 1024×600.
- Fluxo com luvas/dedo molhado (toque).
- Restauro de backup por utilizador não técnico.

### 18.8 CI

- `lint`, `typecheck`, `test:unit`, `build`.
- E2E em Chromium headless com OPFS.
- Verificação de que não existe `app/api`, `"use server"` ou `fetch` de dados (regra de lint personalizada).
- Build estático publicado num servidor de teste com COOP/COEP.

---

## 19. Roadmap e marcos

> Estimativas para 1 developer full-time, sujeitas a validação. O marco M0 é obrigatório antes de comprometer datas.

### M0 — Spike técnico (3–5 dias)

**Objetivo:** provar a arquitetura antes de construir produto.

- Next.js 16 com `output: "export"` + `@serwist/next`.
- `sqlite.worker.ts` + `@sqlite.org/sqlite-wasm` + OPFS.
- Verificar COOP/COEP/`SharedArrayBuffer` no hosting alvo.
- Criar tabela, inserir, ler, transação com rollback.
- Exportar/importar `.db`.
- Confirmar funcionamento offline após reload.

**Critério de saída:** demo que cria uma venda e um item numa transação, recarrega offline e exporta/importa a base.

### M1 — Fundação (1 semana)

- Schema, migrações, `PRAGMA user_version`.
- Protocolo do worker e cliente de mensagens.
- Setup, auth local, PIN, lockout, recuperação.
- `storage.persist()`, diagnóstico, página de backup.
- Estrutura de UI e design system (Tailwind + componentes).

**Critério de saída:** setup → login → bloqueio → backup export/import.

### M2 — Back-office (1,5 semanas)

- Categorias, produtos, códigos de barras, pesquisa.
- Stock: entrada, ajuste, histórico, reconciliação.
- Clientes e fornecedores.
- Utilizadores, roles, auditoria.
- Relatórios base.

**Critério de saída:** gerir catálogo/stock/clientes/fornecedores e ver auditoria.

### M3 — POS (2 semanas)

- Carrinho, pesquisa/scanner, quantidades decimais.
- Descontos, cliente, notas.
- Pagamentos e troco.
- Venda ACID, contador de recibos.
- Aprovações, anulações.
- Histórico, reimpressão, recibo 80 mm.
- Atalhos e teclado numérico.

**Critério de saída:** venda completa, anulação e recibo; E2E offline.

### M4 — Hardening e lançamento (1 semana)

- Backup automático, lembretes, exportação encriptada.
- Atualização PWA com migração.
- Multi-separador, integridade, recuperação de erros.
- Performance com volume, testes de impressão.
- Acessibilidade, textos, onboarding.
- Documentação de operação e recuperação.
- Release candidate.

**Critério de saída:** checklist de aceitação completo, backups testados, impressão validada.

### Fase 2 (fora do MVP)

- Sincronização multi-dispositivo (exige backend ou CRDT; rever arquitetura).
- Sessões de caixa, devoluções, crédito, compras.
- Faturação certificada.
- Importação CSV, etiquetas, balança.
- Encriptação da base em repouso.
- WebAuthn/biometria.

---

## 20. Riscos e mitigações

| Risco | Prob. | Impacto | Mitigação |
|---|---|---|---|
| Perda de dados por limpar o browser/desinstalar | Alta | Crítico | `storage.persist()`, backups externos, lembretes, onboarding, exportação fácil |
| Utilizador nunca faz backup | Alta | Crítico | Banner persistente, lembrete após 24 h/50 vendas, backup automático local + exportação guiada |
| Base `.db` copiada/exposta | Média | Alto | PIN, encriptação de disco do SO, exportação encriptada, minimização de dados |
| Força bruta ao PIN | Média | Médio | PBKDF2 600k, 6 dígitos, lockout, bloqueio por inatividade |
| Incompatibilidade OPFS/SQLite WASM | Média | Alto | Spike M0, matriz de browsers, mensagem de bloqueio, Chromium como alvo |
| COOP/COEP indisponíveis no hosting | Média | Alto | Testar no M0; alternativa sem `SharedArrayBuffer`; servidor local com headers |
| Corrupção por multi-separador | Média | Alto | Web Locks, separador único, `quick_check`, backups |
| Migração falhada | Média | Alto | Backup `pre_migrate`, transação, rollback, testes de migração |
| Service Worker obsoleto | Média | Médio | Versionamento, prompt, não ativar com venda em curso |
| Performance em tablet low-end | Média | Médio | Worker, índices, paginação, testes de volume |
| Impressão inconsistente | Alta | Médio | CSS 80 mm, matriz de impressoras, fallback PDF/A4 |
| Auditoria local adulterável | Alta | Médio | Aceite no MVP; documentar; exportação para arquivo |
| Autoaprovação de gerente bloqueada | Média | Médio | Rever política; owner pode autoaprovar; open question |
| Scope creep (sync, compras, fiado) | Alta | Alto | Seguir o âmbito Must; fase 2 explícita |
| Remoção do better-auth aumenta risco de auth | Média | Médio | Code review, testes, PBKDF2, lockout, recuperação |
| Sem wipe remoto | Média | Alto | Encriptação de disco, PIN, procedimento de devolução de equipamento |
| Hora do dispositivo errada | Média | Médio | Diagnóstico, aviso, relatórios por data local |
| Dependência de `@serwist/next` com Next 16 | Média | Médio | Spike M0; fallback para SW próprio/Workbox |
| Quota de armazenamento | Baixa | Alto | Monitorizar uso, alertar, arquivar/exportar |

---

## 21. Questões em aberto e registo de decisões

### 21.1 Questões em aberto

1. **better-auth:** confirmar que é definitivamente abandonado. A arquitetura 100% local torna-o inviável; a substituição é auth própria com Web Crypto. (Assumido como decidido nesta versão.)
2. **Multi-dispositivo:** haverá necessidade de dois ou mais terminais? Se sim, a arquitetura tem de mudar (backend ou CRDT) e o MVP atual não serve.
3. **Backup:** qual o destino operacional recomendado (pen, disco externo, nuvem pessoal)? Quem é responsável por verificar?
4. **Hosting:** site estático remoto ou servidor local no estabelecimento? Quem garante HTTPS e COOP/COEP?
5. **Browser/dispositivo alvo:** Chrome Android, Edge desktop, tablet Windows? Safari/iOS fica fora?
6. **PIN:** 6 dígitos é aceitável para o balcão? Alternativa: 4 dígitos com mais lockout (menos seguro).
7. **Encriptação em repouso:** a base plana é aceitável? Se não, avaliar SQLCipher/WASM ou encriptação de campos.
8. **Autoaprovação:** permitir que um gerente aprove as suas próprias anulações/descontos até um limite?
9. **Stock negativo:** predefinição deve ser permitir ou bloquear?
10. **Certificação fiscal:** quando entra? Os recibos internos são aceitáveis para os clientes do MVP?
11. **Sessões de caixa/fiado:** são necessárias no lançamento? Se sim, replanejar o âmbito.
12. **Retenção:** 24 meses é suficiente? Onde arquivar depois?
13. **Código de recuperação:** formato e política de armazenamento (impresso, gestor de passwords, cofre)?
14. **Impressora:** modelo e ligação (USB, Bluetooth, rede) para testar no M0/M3.
15. **Atualizações:** quem aprova e quando? Atualização automática ou manual?

### 21.2 Registo de decisões

| ID | Decisão | Estado | Data |
|---|---|---|---|
| ADR-01 | 100% client-side, `output: "export"` | Aceite | 13/11/2026 |
| ADR-02 | SQLite WASM + OPFS em Web Worker | Aceite | 13/11/2026 |
| ADR-03 | Auth local com PBKDF2; better-auth removido | Aceite | 13/11/2026 |
| ADR-04 | UUID em todas as chaves de negócio; sem AUTOINCREMENT | Aceite | 13/11/2026 |
| ADR-05 | Comandos de domínio + transações ACID no worker | Aceite | 13/11/2026 |
| ADR-06 | Sem sync; backup por exportação/importação `.db` | Aceite | 13/11/2026 |
| ADR-07 | Uma instalação = uma base; sem multi-terminal no MVP | Aceite | 13/11/2026 |
| ADR-08 | Serwist para PWA/offline | Aceite | 13/11/2026 |
| ADR-09 | `storage.persist()` + lembretes de backup | Aceite | 13/11/2026 |
| ADR-10 | Recibos não fiscais no MVP | Aceite | 13/11/2026 |
| ADR-11 | PIN de 6 dígitos | Proposto | 13/11/2026 |
| ADR-12 | Stock negativo permitido por predefinição | Proposto | 13/11/2026 |
| ADR-13 | Autoaprovação só para owner | Proposto | 13/11/2026 |

---

## 22. Glossário e referências

### 22.1 Glossário

| Termo | Significado |
|---|---|
| **POS / PDV** | Ponto de venda; aplicação e balcão onde se registam vendas |
| **PWA** | Progressive Web App; site instalável que funciona offline |
| **OPFS** | Origin Private File System; armazenamento privado da origem no browser |
| **SQLite WASM** | SQLite compilado para WebAssembly, executado no browser |
| **Web Worker** | Thread separada da UI, usada para não bloquear o interface |
| **ACID** | Atomicidade, consistência, isolamento e durabilidade |
| **PBKDF2** | Função de derivação de chave usada para proteger PINs |
| **UUID** | Identificador único universal; `crypto.randomUUID()` |
| **IVA** | Imposto sobre o Valor Acrescentado; 16% em Moçambique |
| **NIF** | Número de Identificação Fiscal (9 dígitos) |
| **MZN** | Metical, moeda de Moçambique |
| **SKU** | Stock Keeping Unit; código interno do produto |
| **EAN** | Código de barras padrão |
| **Basis point (bp)** | Centésimo de percentagem; 1600 bp = 16% |
| **Lockout** | Bloqueio temporário após tentativas falhadas |
| **Web Locks** | API para coordenação de locks entre separadores/workers |
| **Serwist** | Biblioteca de Service Worker para Next.js |
| **COOP/COEP** | Headers de isolamento cross-origin |
| **CSP** | Content Security Policy |
| **RPO/RTO** | Perda máxima de dados aceitável / tempo máximo de recuperação |
| **Ticket médio** | Valor médio por venda |

### 22.2 Referências técnicas

- Next.js — Static Exports: <https://nextjs.org/docs/app/building-your-application/deploying/static-exports>
- Serwist — Next.js: <https://serwist.pages.dev/docs/next/getting-started>
- SQLite WASM: <https://sqlite.org/wasm/doc/trunk/index.md>
- MDN — Origin Private File System: <https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system>
- MDN — Web Crypto API: <https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API>
- MDN — Web Locks API: <https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API>
- MDN — StorageManager.persist(): <https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist>
- W3C — Content Security Policy: <https://www.w3.org/TR/CSP3/>
- OWASP — Password Storage Cheat Sheet: <https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html>

### 22.3 Checklist de conformidade com as regras estritas

- [ ] R1 — Sem `"use server"`, sem `app/api/**`, sem `fetch()` para dados.
- [ ] R2 — Todas as PKs de negócio são UUID; nenhum `AUTOINCREMENT`.
- [ ] R3 — Nenhum import de SQLite fora de `sqlite.worker.ts`.
- [ ] R4 — `sale.complete` usa `BEGIN IMMEDIATE` + `COMMIT`/`ROLLBACK`.
- [ ] R5 — `navigator.storage.persist()` no arranque; exportar/importar `.db` funcional.
- [ ] R6 — PIN/hash/salt nunca em logs ou storage.
- [ ] R7 — Sem fontes/ícones/scripts externos em runtime.
- [ ] R8 — SQL sempre parametrizado.
- [ ] R9 — UI nunca recebe o handle da base.
- [ ] R10 — `PRAGMA user_version` verificado no arranque e na importação.
- [ ] R11 — Migrações transacionais com backup prévio.
- [ ] R12 — Um único separador com escrita ativa.

---

**Fim do documento.**


