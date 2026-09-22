# HANDOFF — estado atual e o que falta

Documento de passagem de bastão. Escrito numa sessão do Claude Code **na nuvem**
(contêiner Linux, sem acesso à máquina do usuário) para ser retomado por uma
sessão **local no VS Code**, que tem acesso aos arquivos reais.

- Repositório: `brunotrolo/OpenCode_Session_Hub`, branch `main`
- Último commit desta rodada: `1ed42b1`
- Testes: 177 passando (`npm test`)
- Data: 2026-09-22

---

## 1. O problema central (e por que demorou a cair a ficha)

A extensão sincroniza sessões do OpenCode CLI para um repositório git privado.
Na máquina do usuário **nenhuma sessão chegava ao GitHub**, e cada push
reportava sucesso.

Ambiente real onde isso acontece — importa para entender tudo abaixo:

| | |
|---|---|
| SO | Windows 11 |
| `opencode.db` | **~6958 MB** (7 GB) |
| `opencode.db-wal` | ~8 MB, OpenCode quase sempre aberto |
| Sessões na máquina | 137 |
| Favoritos | 3 (dois apontam para a mesma sessão) |
| Janelas do VS Code | **várias abertas ao mesmo tempo** |
| Remoto | `https://github.com/brunotrolo/my-opencode-config` |

Caminhos na máquina do usuário:

```
espelho:  C:\Users\bruno\AppData\Roaming\Code\User\globalStorage\opencode-session-hub.opencode-session-hub\sync-repo
banco:    C:\Users\bruno\.local\share\opencode\opencode.db
config:   C:\Users\bruno\.config\opencode
```

O diagnóstico levou várias rodadas porque **o relatório de debug não mostrava o
erro do push**. Isso já foi corrigido (ver §2.8) — hoje o relatório traz commits
não enviados, teste de alcance do remoto e o último erro.

---

## 2. O que foi corrigido nesta rodada

Em ordem cronológica. Cada item tem teste de regressão.

### 2.1 Excluir sessão travava a extensão — `4eff6c8`

`DELETE FROM part/message WHERE session_id = ?` não tem índice nessa coluna na
schema do OpenCode: cada DELETE é uma varredura completa da tabela, três vezes,
de forma síncrona. Num banco de 7 GB isso congela a extension host inteira.

Movido para processo filho (`deleteSessionRows` em `src/dbMaintenance.ts`),
mesma técnica já usada no VACUUM. A cadeia virou assíncrona:
`sessionScanner.deleteSession` → `SyncController.deleteSession` →
`dashboardView.deleteById` / comando da paleta.

### 2.2 Preview não reabria depois de fechar — `4eff6c8`

`loadSqliteMessages` tinha subquery correlacionada por mensagem: uma varredura
da tabela `part` **por mensagem**. Uma sessão de 2000+ mensagens travava. Virou
duas queries planas agrupadas em memória.

> O painel em si já era stateless — o "não abre de novo" era a UI congelada
> durante a query, não um bug de ciclo de vida do webview.

### 2.3 Sessões não chegavam ao GitHub — `c88489e` ← **a correção principal**

Com o banco acima do limite de tamanho, o espelho do banco inteiro é
permanentemente pulado. A exportação por sessão existia, mas **só cobria
favoritos**. Quem não favoritou nada sincronizava config para sempre enquanto
nenhuma sessão saía da máquina — com sucesso reportado.

Agora a exportação individual cobre **todas as sessões** automaticamente quando
a rota do banco inteiro está indisponível. Limite de
`MAX_INDIVIDUAL_SESSION_EXPORTS` (200), mais recentes primeiro, favoritos sempre
incluídos e fora desse limite.

### 2.4 Excluir sessão se desfazia sozinho — `c88489e`

Com cada sessão virando um arquivo no remoto, apagar localmente era revertido no
pull seguinte. Criado `src/deletedSessions.ts` (tombstones). Um tombstone:

- sincroniza junto com a config (`config/opencode-session-hub-deleted-sessions.json`)
- remove o arquivo da sessão do espelho
- exclui a sessão de exportações futuras
- é ignorado no merge de entrada
- **é aplicado localmente no pull** (`applyDeletedSessions`)

O último passo é o que impede a exclusão de ficar quicando entre duas máquinas.

### 2.5 Pull travava com muitos arquivos — `c88489e`

`applyFavoriteSessions` abria e fechava o `opencode.db` **uma vez por arquivo** —
cada fechamento fazendo checkpoint do WAL de um banco de GBs. Criado
`mergeManySessionDatabases` (`src/dbMerge.ts`): uma conexão para todos.

### 2.6 Credenciais MCP vazando — `97ab017`

O guard cobria `headers` e `oauth.clientSecret`, mas **não `environment`** — que
é exatamente onde um servidor MCP local guarda o token. Um
`environment: { GITHUB_TOKEN: "ghp_..." }` ia literal para o repositório.

Agora vira `{env:VAR}` quando o nome da variável parece credencial ou o valor
casa com formato conhecido. Variáveis não-secretas (`NODE_ENV`, `PORT`) ficam
intactas de propósito — templatizar tudo quebraria o servidor na outra máquina.

### 2.7 Push de 28s → 2s, e fora da thread principal — `7adb682`, `43b25ec`

Exportar uma sessão por vez custava uma varredura completa de `message`/`part`
**por sessão**. Medido: 28,0 s para 150 sessões. `exportSessionFilesBatched` abre
o banco uma vez e varre cada tabela uma vez por lote de 25 → 2,1 s.

Como `node:sqlite` é síncrono, mesmo 2 s congelariam a janela. `exportSessionFilesOffThread`
roda em processo filho que carrega **este mesmo módulo compilado** (uma só cópia
da lógica). Se o filho não subir, cai para execução inline em vez de sincronizar
nada em silêncio.

### 2.8 Falha de rede/credencial era engolida — `619e92d`

Qualquer erro de `git fetch` era tratado como "o remoto está vazio". Um sync que
nunca falou com o GitHub reportava sucesso e commitava localmente — foi assim que
os commits se acumularam sem ninguém perceber. Hoje só "branch não existe ainda"
é benigno; o resto falha alto com o erro do próprio git.

O relatório de debug ganhou: contagem de commits não enviados, sonda real de
alcance do remoto (`git ls-remote`) e o último erro de sync.

### 2.9 Temporários commitados dentro do repo — `619e92d` ← **o que travava os pushes**

A exportação escrevia `<id>.db.tmp-<pid>-<timestamp>` **dentro da árvore de
trabalho do git** e só depois renomeava. Exportação interrompida = lixo para trás
= `git add -A` commitava. Seis PIDs diferentes deixaram órfãos; **um passou de
100 MB**, e a partir daí todo push era recusado.

Três camadas de correção:
- temporários vão para o diretório temp do SO (com fallback cópia+remoção para
  `EXDEV`, comum no Windows onde TEMP costuma estar em outro volume)
- `removeStrayExportTempFiles` limpa órfãos de versões antigas a cada push
- `*.tmp-*` em `.git/info/exclude` (e **não** num `.gitignore` versionado — um
  `.gitignore` não rastreado bloqueia o primeiro `git checkout -B` de um espelho novo)

### 2.10 Recuperação: "Rebuild Local Mirror" — `619e92d`

Antes, a mensagem mandava o usuário rodar `git filter-repo` na mão. Inaceitável.
Criado o comando `opencodeSessionHub.rebuildMirror` + botão **"Rebuild Mirror…"**
na barra lateral: descarta o histórico local impossível de enviar e reconstrói a
partir do remoto.

Seguro porque o espelho é só cópia de rascunho — nada no GitHub nem nas sessões
do OpenCode é tocado.

### 2.11 Concorrência entre janelas do VS Code — `1ed42b1`

**Correção de um diagnóstico meu que estava errado.** Eu tinha atribuído
`git add -A failed: fatal: confused by unstable object source data` a
antivírus/OneDrive e "resolvido" com retries. O log provou o contrário:

```
git add -A failed: error: open("data/favorite-sessions/ses_f4a55...db.tmp-900-1789991173177"):
  No such file or directory
```

O git estava indexando **o nosso próprio temporário**, que o **nosso próprio
código** apagou no meio.

Segunda causa: a fila do `SyncController` só ordena operações **dentro de uma
extension host**. Cada janela do VS Code tem a sua, e todas compartilham o mesmo
diretório de espelho em `globalStorage`. Com `autoSyncOnFocusLost` ligado,
**trocar de janela é o gatilho** — a janela que você deixa agenda um push
enquanto a outra já está sincronizando.

`withRepoLock` (`src/syncManager.ts`) serializa `push`/`pull`/`resolveConflicts`/
`rebuildMirror` entre processos. Lock criado atomicamente com flag `wx`, **ao
lado** do diretório do repo (dentro de `.git/` obrigaria a criar `.git` antes do
`git init`; na árvore de trabalho poderia ser commitado). O dono renova o lock
enquanto trabalha; lock de janela morta expira em vez de travar a máquina.

---

## 3. O QUE FALTA — ação na máquina do usuário

> **As correções impedem o problema de voltar, mas não apagam os ~21 commits já
> envenenados no espelho local dele.** Isso só sai com o Rebuild Mirror.

### Ordem obrigatória

1. **Instalar o `.vsix` novo** (o último gerado, com `withRepoLock`)
2. **Fechar todas as janelas do VS Code menos uma** — a concorrência entre
   janelas era uma das causas
3. **"OpenCode Sync: Rebuild Local Mirror"** (paleta) ou botão **"Rebuild Mirror…"**
4. **"Push Now"**

### Diagnóstico antes de mexer (só leitura)

No diretório do `sync-repo`:

```powershell
git status
git log --oneline -5
git rev-list --count origin/main..HEAD          # commits não enviados
git ls-remote --heads origin main               # remoto acessível? credencial válida?
dir /s data\favorite-sessions\*.tmp-*           # temporários órfãos
```

Blobs grandes no histórico não enviado:

```powershell
git rev-list origin/main..HEAD
# para cada revisão: git ls-tree -r -l <rev>   → procurar tamanhos > 94371840 (90 MB)
```

### Verificação depois do rebuild

- `git rev-list --count origin/main..HEAD` → **0**
- nenhum arquivo `*.tmp-*`
- nenhum blob acima de 90 MB
- depois do Push Now:
  `git ls-tree -r --name-only origin/main | findstr favorite-sessions` → deve
  listar ~136 arquivos `.db`

### Confirmar que a versão instalada é a certa

Procure `withRepoLock` em `out/syncManager.js` no diretório da extensão
instalada. Se não achar, é versão antiga — reinstale o `.vsix` antes de
qualquer coisa.

---

## 4. Limitação conhecida (não é bug)

A sessão `ses_f4a55ea3effeDnzTiAaKbI0X92` ("Bot WhatsApp" / "Salesforce_BotLike_WhatsApp",
~2175 mensagens) gera um export **acima de 100 MB sozinha**. O GitHub rejeita
qualquer arquivo acima disso.

**Compactar o banco não resolve** — a sessão é genuinamente grande. Ela fica só
na máquina local; as outras ~136 sincronizam normalmente. A extensão hoje reporta
isso nomeando a sessão, em vez de repetir o conselho errado de compactar.

Os dois favoritos "Bot WhatsApp" e "Salesforce_BotLike_WhatsApp" apontam para
**o mesmo `sessionId`** — inofensivo (os alvos são deduplicados por id), mas pode
confundir na leitura do relatório.

---

## 5. Mapa do código

| Arquivo | Responsabilidade |
|---|---|
| `syncManager.ts` | Motor do sync: plano, espelho, git, lock entre processos, rebuild |
| `syncController.ts` | Estado + fila dentro de uma janela; ponte para a UI |
| `sessionScanner.ts` | Lê/apaga sessões nas 3 gerações de storage do OpenCode |
| `favoriteSessionExport.ts` | Exportação por sessão (em lote e fora da thread) |
| `dbMerge.ts` | Merge linha a linha de bancos SQLite (evita conflito binário) |
| `deletedSessions.ts` | Tombstones de exclusão |
| `dbMaintenance.ts` | VACUUM e DELETE em processo filho |
| `mcpSecretGuard.ts` | Troca credenciais MCP por `{env:VAR}` no push |
| `debugInfo.ts` | Relatório de diagnóstico |
| `dashboardView.ts` | Webview da barra lateral |

`TECHNICAL.md` tem o detalhamento das decisões de arquitetura.

---

## 6. Como trabalhar neste repositório

```bash
npm install
npx tsc --noEmit -p .     # checagem de tipos
npm test                  # 177 testes
npm run compile
npx vsce package          # gera o .vsix
```

**Padrão de teste usado aqui:** os testes dirigem o pipeline real contra
repositórios git de verdade (`git init --bare` em diretório temporário) e afirmam
sobre **o que realmente foi commitado no remoto**, não sobre estado interno. A
razão: todo bug real desta rodada foi o pipeline recusando-se a sincronizar algo
**enquanto reportava sucesso** — asserção sobre estado interno não pega isso.

**Verificação de teste:** cada correção nova foi validada desativando-a e
confirmando que o teste realmente falha. Isso pegou dois testes meus que passavam
dos dois jeitos:

- um teste de "não congela" medindo o event loop passava mesmo com a correção
  desligada (o caminho inline cede entre sessões) → trocado por asserção sobre o
  mecanismo (processo filho é realmente criado)
- um teste de remoto inacessível passava porque o erro do `git push` casava com o
  regex → trocado por asserção sobre o sintoma real (commits não podem se
  acumular)

Se for mexer aqui: **um teste que passa com e sem a correção não prova nada.**
Desative a correção e confirme que ele falha.
