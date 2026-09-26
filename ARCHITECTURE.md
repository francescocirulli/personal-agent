# Personal Agent — Architettura

> Documento di handoff. Riassume l'idea, le decisioni prese e l'architettura definita durante la fase di design.
> Chi apre una nuova sessione per lo sviluppo deve partire da qui. Le sezioni marcate **[DA DECIDERE]** o **[DA VERIFICARE]** non sono ancora chiuse.

Ultimo aggiornamento: 2026-09-26

**Stato sviluppo:** prima implementazione presente nel workspace. Vedi `README.md` per avvio, configurazione e limiti verificabili. Stack adottato: React/Vite, TypeScript/Node/Express e SQLite. Docker Compose avvia un container non root con volume persistente. L'hosting cloud definitivo e la verifica sul dispositivo fisico restano aperti.

---

## 1. Idea del progetto

Un **agente di coding personale che gira nel cloud** (Claude Code o Codex), con accesso ai miei repository GitHub e ad altri tool, con cui interagisco **dal telefono, principalmente a voce**.

- Il client è una **web app installabile (PWA)** aggiunta alla home screen del telefono.
- L'esperienza d'uso di riferimento è **ChatGPT Voice**: parlo, l'agente mi risponde a voce.
- Input a voce, output a voce. L'output deve poter passare a **testo** con un toggle.
- L'agente fa lavoro reale (legge e modifica repo, apre PR, usa tool) e mi riferisce a voce cosa ha fatto.

### Esperienza desiderata e perimetro

- L'obiettivo è poter fare dal telefono **tutto ciò che faccio con Claude Code o Codex sul computer**, usando la voce sia in ingresso sia in uscita. Il prodotto non è limitato all'assegnazione di task o all'apertura di PR.
- Nella stessa conversazione alterno **discussione** (domande, ragionamento, chiarimenti, con i normali tempi di risposta della CLI) ed **esecuzione di task**, anche lunghi e asincroni. Non serve un secondo modello per conversare nell'MVP.
- Quando lancio un task posso lasciare l'app; il lavoro continua sul server. Al termine voglio una risposta nella stessa chat, disponibile anche a voce. Se l'app non può riprodurla in background, ricevo una notifica e la ascolto alla riapertura.
- L'agente ha **autonomia operativa completa nel rispetto delle mie istruzioni e delle regole del repository**, comprese quelle in `CLAUDE.md` e `AGENTS.md`. Non è previsto un passaggio obbligatorio di approvazione per ogni azione.
- Nessun repository specifico è un prerequisito per definire il prodotto. La scelta del repo, gli strumenti e l'ambiente di esecuzione devono permettere usi diversi; la parità con l'esperienza desktop è l'obiettivo finale, anche se implementata per fasi.

### Scelte di prodotto confermate

- PWA con storico delle chat e conversazione testuale leggibile, oltre alla modalità vocale in ingresso e in uscita.
- **Modalità voce a mani libere dalla prima versione**: la attivo, parlo, il sistema rileva la fine del mio intervento, risponde e torna ad ascoltare. Non devo premere un pulsante per ogni messaggio.
- **Durante un task, nella prima versione attendo il risultato**: non è necessario poter fare domande o correggere l'agente mentre lavora. Un eventuale comando esplicito di arresto è distinto dai messaggi di conversazione.
- **Alla creazione di ogni chat scelgo l'agente** (Claude Code oppure Codex) e, facoltativamente, un progetto. **Un progetto coincide con un repository**; posso scegliere **nessun progetto** e conversare con l'agente senza un repository associato. Il cambio di agente nella stessa chat non fa parte della prima versione.
- **Brevi aggiornamenti vocali durante i task**, oltre alla risposta finale, quando la modalità voce è attiva. Devono riferire progressi effettivi senza leggere ogni evento tecnico.
- **Più chat possono eseguire task contemporaneamente**, anche mentre ne consulto o ne uso un'altra. Resta il limite di un run attivo per singola chat.
- **Schermata vocale dedicata, sul modello di ChatGPT Voice**, con possibilità di tornare alla conversazione testuale della stessa chat.
- **Dispositivo di riferimento: iPhone 16**, con PWA installata. Versione iOS da rilevare durante le verifiche sul dispositivo.
- **Una sola chat parla alla volta**: voce e aggiornamenti automatici appartengono alla chat aperta in modalità voce; le altre notificano la fine del task senza interrompere l'audio.
- **Ascolto su richiesta di ogni messaggio dell'agente**, compresi quelli precedenti: apro la chat, anche da una notifica, e premo “Ascolta” sul messaggio desiderato. Aprire la notifica non avvia automaticamente la riproduzione.

## 2. Requisiti e vincoli

| # | Requisito | Note |
|---|---|---|
| R1 | **Claude Code e Codex devono usare le mie subscription** (Claude Pro/Max, ChatGPT plan). **Niente API pay-per-use per il "cervello".** | Vincolo non negoziabile. |
| R2 | Chat testuale sempre consultabile e modalità voce a mani libere (input + output) | Toggle voce+testo / solo testo nella PWA |
| R3 | L'agente ha accesso a GitHub e ad altri tool | Via CLI (`gh`, `git`) e server MCP |
| R4 | Deploy portabile: il provider cloud si sceglie dopo | Da qui la scelta di Docker |
| R5 | Costi contenuti per la parte voce | Stima: ~$8–12/mese con l'uso previsto |
| R6 | Uso personale, singolo utente | Niente multi-tenancy |
| R7 | Discussione e task asincroni nella stessa chat, con input e risposta vocali | La durata dei task della CLI è accettata; chiudere il client non deve interrompere il lavoro |
| R8 | Autonomia completa secondo istruzioni dell'utente e del repository | Include commit e push; niente vincolo generale “solo PR, mai merge” |
| R9 | Parità funzionale con l'uso di Claude Code/Codex da computer come obiettivo finale | Non limitare il prodotto a un repository o a un solo tipo di task |

### Vincoli di policy (importanti)

**Claude Code** ([Legal & compliance](https://code.claude.com/docs/en/legal-and-compliance)):
- È consentito usare **il binario ufficiale e non modificato di Claude Code**, autenticato con la propria subscription, anche quando gira su infrastruttura cloud o di terzi.
- **Non** è consentito usare il token OAuth della subscription fuori dalla CLI ufficiale. Quindi: niente Agent SDK con il token OAuth, niente chiamate dirette all'API Anthropic con quel token, niente uso del token per il layer voce.
- I limiti di Pro/Max presuppongono un "uso individuale ordinario". Va bene per uso personale; va evitata automazione 24/7 intensiva.
- La policy è cambiata più volte nel 2026: va ricontrollata periodicamente.

**Codex**:
- Il login con il piano ChatGPT è supportato su macchine headless: `codex login --device-auth`, oppure copiando `~/.codex/auth.json`.
- OpenAI consiglia le API key per la CI, ma non vieta l'uso con il piano ChatGPT.

## 3. Decisioni prese

| ID | Decisione | Motivazione | Alternative scartate / rimandate |
|---|---|---|---|
| D1 | L'agente è **la CLI ufficiale** (`claude` / `codex`) invocata in modalità headless | Unico modo compatibile con R1 e con la policy Anthropic | Agent SDK (richiede API key); API dirette |
| D2 | Autenticazione con subscription: `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN`; Codex via `codex login --device-auth` / `auth.json` | R1 | API key Anthropic/OpenAI |
| D3 | **Voce: opzione A = catena STT → agente → TTS** | Tutto il "pensiero" resta sulla subscription; costo voce minimo | Opzione B (realtime speech-to-speech): rimandata, vedi §9. Opzione C (solo realtime API): scartata |
| D4 | STT: **`openai/gpt-4o-transcribe`** | Ottimo in italiano, gestisce bene il vocabolario tecnico | Voxtral Realtime, ElevenLabs Scribe v2 (alternative valide); Web Speech API del browser (instabile nelle PWA iOS) |
| D5 | TTS iniziale implementato: **`google/gemini-3.8-flash-lite-tts`**, voce `Kore`, tramite OpenRouter | Prova reale TTS → STT in italiano riuscita il 26 settembre 2026. Lo slug `openai/gpt-4o-mini-tts` originariamente scelto è stato rifiutato dall'API come inesistente | La voce resta configurabile; confronto qualitativo e costi da aggiornare |
| D6 | STT e TTS passano da **OpenRouter** (unica API key), non direttamente da OpenAI | Più comodo; cambiare modello = cambiare uno slug | OpenAI diretto |
| D7 | Provider STT e TTS **dietro un'astrazione** (configurazione) | Per poter cambiare voce e modello senza toccare codice | — |
| D8 | **Runtime in Docker**, provider di hosting da scegliere dopo | Portabilità (R4) | — |
| D9 | DigitalOcean Managed Agents **non è un requisito** | Non è chiaro se accetti il token OAuth della subscription: la documentazione parla solo di API key o della loro inferenza. Resta un'opzione, ma prima va testata | — |
| D10 | Partire con **un solo container** (bridge + CLI dell'agente) | Semplicità | Container separati bridge/worker: si valuta solo se serve |
| D11 | **Un'unica conversazione per discussione e lavoro asincrono**, con risposta vocale | Rispecchia l'uso delle CLI sul computer; i tempi di esecuzione sono accettati | Un front realtime separato non è necessario per l'MVP |
| D12 | **Autonomia completa nel rispetto delle istruzioni dell'utente e del repo** | Commit, push e altre operazioni devono essere possibili come da computer | Nessuna allowlist di prodotto che imponga sempre PR o vieti sempre merge |
| D13 | **Voce a mani libere con rilevamento della fine del parlato nell'MVP** | Esperienza vocale richiesta dall'utente | Push-to-talk come flusso principale superato |
| D14 | **Agente e progetto opzionale scelti alla creazione di ogni chat** | Un progetto = un repository; ammesse chat senza repository | Cambio agente nella stessa chat rimandato |
| D15 | **Durante il task si attende, con brevi aggiornamenti vocali** | Prima versione semplice, con visibilità sul progresso | Conversazione e correzioni durante il run rimandate |
| D16 | **Task simultanei in chat diverse** | Possibilità di avviare un altro lavoro mentre un agente è occupato | Unico run globale non adatto all'esperienza richiesta |
| D17 | **Schermata voce dedicata come ChatGPT Voice** | Esperienza a mani libere con ritorno alla chat testuale | Soli controlli vocali dentro la chat non sufficienti come vista principale della modalità voce |
| D18 | **Pulsante Ascolta per ogni messaggio dell'agente nello storico** | Permette di ascoltare i risultati asincroni e riascoltare risposte precedenti | Nessun autoplay all'apertura di una notifica |
| D19 | **Un solo audio alla volta, con le altre chat che notificano** | I task simultanei non devono produrre conversazioni vocali sovrapposte | — |

## 4. Architettura

```
┌──────────────────────────┐
│   PWA (telefono)         │
│  - voce a mani libere   │
│  - player audio          │
│  - vista testo/markdown  │
│  - toggle voce/testo     │
│  - Web Push              │
└───────────┬──────────────┘
            │ HTTPS (upload audio, SSE per gli eventi)
            ▼
┌────────────────────────────────────────────────────────┐
│  Container Docker                                      │
│                                                        │
│  ┌──────────────────────────────────────────────┐      │
│  │ Bridge (backend)                             │      │   OpenRouter
│  │  - auth utente                               │─────────► /audio/transcriptions (STT)
│  │  - gestione conversazioni/sessioni           │─────────► /audio/speech (TTS)
│  │  - Runner: spawn delle CLI, parsing stream   │      │
│  │  - estrazione <voce> → TTS                   │      │
│  │  - Web Push notifiche                        │      │
│  └──────────────┬───────────────────────────────┘      │
│                 │ child process                        │
│        ┌────────┴─────────┐                            │
│        ▼                  ▼                            │
│   claude -p ...     codex exec ...                     │───► Anthropic / OpenAI
│   (subscription)    (ChatGPT plan)                     │     (via le CLI ufficiali)
│        │                  │                            │
│        └──── git, gh, server MCP ──────────────────────│───► GitHub, altri tool
│                                                        │
│  Volume persistente /data:                             │
│   ~/.claude, ~/.codex, repo clonati, stato del bridge  │
└────────────────────────────────────────────────────────┘
```

### 4.1 PWA (client)

- Installabile sulla home screen: manifest + service worker.
- **Cattura audio**: `MediaRecorder`, con scelta tramite `isTypeSupported` tra MP4 e WebM/Opus sul dispositivo.
  - Fine turno rilevata automaticamente nell'MVP tramite VAD nel browser; libreria e soglie da verificare sul dispositivo di riferimento.
  - Ciclo della modalità voce: ascolto → invio del messaggio → attesa del run con aggiornamenti testuali → riproduzione della risposta → ritorno all'ascolto, finché la modalità resta attiva e l'app è in primo piano.
  - Nell'MVP non inviare nuovi turni durante il run o la riproduzione TTS; evitare che la voce sintetizzata venga catturata come nuovo input. Interruzione vocale e correzioni durante il lavoro sono evoluzioni successive.
- Invia la clip al bridge e riceve gli eventi del turno via **SSE**.
- Riproduce l'audio TTS: MP3 per i provider compatibili; Gemini restituisce PCM e il bridge lo confeziona in WAV (PCM16, mono, 24 kHz). Il player usa HTMLAudioElement con play() direttamente dal tocco dell’utente e URL media protetto che supporta HTTP Range.
- Conserva nella vista chat il testo completo della risposta in markdown: codice, diff, link alle PR. La modalità voce ha una schermata dedicata dalla quale si può tornare alla chat testuale.
- **Toggle output**: voce+testo oppure solo testo (in quel caso il TTS non viene chiamato automaticamente; resta disponibile l'ascolto su richiesta dei singoli messaggi).
- **Ascolta per messaggio**: ogni risposta dell'agente nello storico espone riproduzione e pausa della sua versione vocale, anche se non è l'ultima risposta o è stata ricevuta in modalità solo testo. Il semplice ascolto non attiva il microfono né avvia un nuovo turno dell'agente.
- **Web Push** (VAPID) per notificare quando un task lungo è finito. Su iOS funziona solo con la PWA installata (iOS ≥ 16.4).
- Storico di più conversazioni. Alla creazione di ciascuna chat si scelgono agente (Claude Code o Codex) e progetto/repository opzionale, con scelta esplicita “Nessun progetto”; l'agente resta associato a quella chat.
- Passare a un'altra chat non interrompe i task in corso. Riprodurre automaticamente la risposta solo per la chat in modalità voce attiva; gli aggiornamenti tecnici restano testuali; per le altre mostrare stato e notifiche, senza sovrapporre più conversazioni audio.
- Il tocco su una notifica apre la chat e rende individuabile la risposta relativa al task concluso; l'utente preme “Ascolta” per sentirla. La riproduzione manuale di un messaggio sostituisce qualsiasi altro audio dell'app; il microfono non acquisisce la riproduzione.

**Limiti noti delle PWA su iOS**: con lo schermo bloccato o l'app in background il microfono e l'audio si interrompono. Il flusso previsto è "parlo → l'agente lavora → mi arriva una notifica push → riapro e ascolto". Per conversazioni continue a schermo spento servirebbe un'app nativa (fuori scope).

### 4.2 Bridge (backend)

Responsabilità:

1. **Autenticazione** del singolo utente. Prima implementazione: password personale lunga e sessione con cookie HttpOnly/SameSite, Secure su HTTPS; controllo Host/Origin e limite dei tentativi. Per l'anteprima, anche accesso privato tramite BB Connect. Passkey eventualmente in seguito.
2. **STT**: riceve l'audio e chiama OpenRouter `POST /api/v1/audio/transcriptions` (compatibile con l'SDK OpenAI, `base_url=https://openrouter.ai/api/v1`). Formati accettati: wav, mp3, flac, m4a, ogg, webm, aac. Limiti: 25 MB e ~60 s di elaborazione.
3. **Runner**: interfaccia comune a Claude Code e Codex.
   - `start(conversation, text)` → stream di eventi normalizzati.
   - `resume(conversation, text)` → continua la stessa sessione dell'agente.
   - `cancel(conversation)`.
   - Un solo run attivo per conversazione. Nell'MVP la UI attende il risultato prima di consentire un nuovo messaggio e il backend rifiuta nuovi turni mentre il run è attivo. Non è necessaria una coda di messaggi.
   - Chat diverse possono avere run attivi contemporaneamente, con processi, sessioni ed eventi distinti. **[DA DECIDERE]** Limite di concorrenza operativo e gestione della capacità esaurita, senza imporre un unico run globale.
   - Il run è indipendente dalla connessione SSE e dalla presenza della PWA in primo piano: la disconnessione del client non lo cancella.
   - Correzioni, domande sullo stato e messaggi in coda durante il run sono rimandati. La cancellazione esplicita resta un'operazione separata dall'invio di un turno.
4. **Estrazione della parte parlata** e **TTS**: vedi §5.
   - Associare il testo da pronunciare e l'eventuale audio a un messaggio persistente, non soltanto al run o alla connessione SSE.
   - Per “Ascolta”, riutilizzare l'audio disponibile oppure generarlo su richiesta dal testo vocale salvato. Non rilanciare la CLI per riascoltare un messaggio; un errore TTS deve essere ritentabile senza rieseguire il task.
5. **Eventi verso la PWA** via SSE, con tipi normalizzati:
   - `transcript`: testo trascritto del mio messaggio;
   - `status`: l'agente ha avviato un tool, es. "sto eseguendo i test";
   - `agent_text`: testo/markdown dell'agente;
   - `voice`: URL o chunk dell'audio TTS;
   - `done`, `error`.
6. **Persistenza** su `/data`: conversazioni, mappatura conversazione → session id dell'agente, storico.
   - Salvare stato ed esito dei run e rendere recuperabili testo e risposta vocale alla riapertura della PWA, anche se gli eventi SSE sono stati persi.
   - **[DA DECIDERE]** Recupero dei run dopo un riavvio del backend: conservare una sessione della CLI non equivale a riprendere automaticamente un processo interrotto.
7. **Web Push** a fine run (o in caso di errore / richiesta di input).

**Implementato:** TypeScript/Node con Express, SQLite/WAL per stato e storico. Frontend React/Vite. Un processo backend per volume/database.

### 4.3 Agente (CLI nel container)

**Claude Code** (flag da verificare con `claude --help` sulla versione installata):
```bash
claude -p "<messaggio>" \
  --output-format stream-json --verbose \
  --resume <session_id> \
  --append-system-prompt "<istruzioni voce, vedi §5>" \
  --permission-mode <modalità_da_verificare_per_uso_autonomo>
```
- Il `session_id` restituito nello stream va salvato per poter riprendere la conversazione.
- Autenticazione: variabile `CLAUDE_CODE_OAUTH_TOKEN` (generata con `claude setup-token` su una macchina con browser). Il token è di lunga durata ma scade: serve una procedura di rinnovo documentata. **[DA VERIFICARE]** la durata effettiva.

**Codex** (flag da verificare con `codex exec --help`):
```bash
codex exec --json "<messaggio>"
codex exec resume <session_id|--last> "<messaggio>"
```
- Autenticazione: `~/.codex/auth.json` sul volume. Codex rinnova i token da solo mentre la sessione è attiva.

**Accesso ai tool**:
- GitHub: `git` + `gh` autenticati con un **fine-grained PAT** o una GitHub App, con permessi limitati ai repo necessari. Credenziali passate come secret o env, non nell'immagine.
- Altri tool: server MCP configurati per Claude Code (`.mcp.json` / `claude mcp add`) e per Codex (`~/.codex/config.toml`). **[DA DECIDERE]** quali tool oltre GitHub.

**Autonomia e regole del repository**:
- L'utente richiede autonomia completa: l'agente può modificare file, eseguire comandi e test, creare commit, fare push e svolgere le altre operazioni richieste, nel rispetto delle istruzioni dell'utente e del repository.
- Caricare e rispettare le istruzioni applicabili, incluse `CLAUDE.md` e `AGENTS.md`, secondo il supporto e la precedenza della CLI scelta. **[DA VERIFICARE]** Come assicurare che ogni CLI riceva tutte le regole pertinenti senza assumere che entrambe leggano automaticamente gli stessi file.
- Branch, PR, merge e deploy seguono il flusso del repository e le istruzioni dell'utente: il prodotto non impone “sempre una PR” o “mai merge”.
- Configurare i permessi delle CLI per consentire questo uso autonomo; distinguere le regole impartite all'agente dai limiti effettivi dell'ambiente e delle credenziali.
- Domande e conferme restano possibili quando richieste dalle istruzioni applicabili, quando mancano informazioni o quando un servizio impone un passaggio interattivo. Devono poter essere gestite dal telefono nella stessa conversazione.
- **[DA VERIFICARE]** Modalità headless e meccanismi disponibili nelle due CLI per gestire richieste di input e permessi residui senza lasciare un processo in attesa invisibile.

**Ambiente di lavoro**:
- Ogni chat deve avere uno spazio di lavoro separato, così i task simultanei sullo stesso repository non modificano gli stessi file di lavoro. **[DA DECIDERE]** Worktree o checkout separati, gestione dei branch e coordinamento delle operazioni Git condivise nel rispetto delle regole del repo.
- Le chat senza progetto usano una directory dedicata alla conversazione, senza associarle implicitamente a un repository. **[DA VERIFICARE]** Avvio delle CLI fuori da un repository e relative opzioni.
- Per raggiungere la parità con l'uso desktop, oltre a `git`, `gh` e MCP occorre poter installare dipendenze, eseguire build e test e avviare gli strumenti necessari ai repository.
- **[DA DECIDERE]** Gestione di runtime, servizi di supporto, credenziali dei progetti ed eventuali preview accessibili dal telefono. Il primo repo non è una decisione architetturale obbligatoria.

## 5. Convenzione per l'output vocale

L'output di Claude Code/Codex contiene markdown, codice e diff: leggerlo ad alta voce non ha senso. Convenzione:

- Nelle istruzioni di sistema (`--append-system-prompt` per Claude Code, istruzioni dedicate per Codex senza sovrascrivere le regole del repo) si chiede all'agente di **chiudere ogni risposta con una parte parlata** in italiano, senza codice né URL, dentro un tag. Durante la discussione questa parte deve contenere una risposta sufficiente a proseguire a voce, incluse eventuali domande; al termine di un task è normalmente un riassunto breve di 2–4 frasi, estendibile se necessario:
  ```
  <voce>Ho corretto il parser e aggiunto i test. I test passano e ho aperto la PR numero 42, come previsto dalle regole del repository.</voce>
  ```
- Il bridge estrae `<voce>…</voce>` e manda **solo quello** al TTS. Nella PWA il testo completo (senza il tag) va nella vista testuale.
- Conservare la parte parlata anche quando il TTS automatico è disattivato. Il pulsante “Ascolta” riproduce questa versione vocale del messaggio, secondo la stessa convenzione usata nella conversazione a mani libere.
- Conservare l'audio generato per il riuso, con possibilità di rigenerarlo dal testo persistito se non è più disponibile. **[DA DECIDERE]** Politica di conservazione dei file audio; la disponibilità di “Ascolta” deve durare quanto il messaggio nello storico.
- Fallback se il tag manca: frase fissa ("Ho finito, trovi i dettagli sullo schermo") oppure i primi N caratteri di prosa. **[DA DECIDERE]**
- Dopo la prova su iPhone: gli eventi `status` restano nella UI e non generano annunci vocali automatici. La preparazione del repository viene segnalata solo quando il checkout viene creato, senza ripeterla a ogni turno. La voce automatica è riservata alla risposta dell’agente.

TTS via OpenRouter `POST /api/v1/audio/speech` (compatibile con OpenAI): campi `model`, `input`, `voice`, `response_format` (`mp3`|`pcm`), `speed`.
**Verifica documentale del 26 settembre 2026:** le opzioni specifiche TTS passano da `provider.options`; `prompt` STT multipart è accettato ma ignorato. La prima implementazione non usa questi campi né applica correzioni automatiche alla trascrizione. Il TTS iniziale è Gemini, vedi D5.

## 6. Flusso di un turno

1. Nella chat, già associata a un agente ed eventualmente a un progetto/repository, apro la schermata voce e parlo; la PWA registra il mio intervento.
2. Il rilevamento della fine del parlato chiude la clip e la PWA fa `POST /conversations/{id}/turns` con l'audio, poi passa in attesa.
3. Il bridge chiama l'STT su OpenRouter ed emette l'evento SSE `transcript`.
4. Il bridge lancia (o riprende) la CLI dell'agente con il testo trascritto.
5. Durante il run: gli eventi dello stream JSON diventano `status` e `agent_text`; alcuni progressi producono brevi aggiornamenti vocali. Nella prima versione attendo il risultato senza inviare altri messaggi.
6. A fine run: il bridge estrae `<voce>`, chiama il TTS (se la voce è attiva) ed emette `voice` e `done`.
7. Se la chat non è quella attiva, segnalare la conclusione senza interrompere la voce di un'altra chat; se la PWA non è in primo piano, inviare una notifica Web Push.
8. Alla riapertura, anche tramite notifica, la PWA recupera lo stato del task e la risposta salvata. L'utente può premere “Ascolta” su quella risposta o su un messaggio precedente; la sola apertura della chat non riproduce l'audio.
9. Nella conversazione a mani libere, dopo la risposta, se la modalità voce è ancora attiva e la PWA è in primo piano, riprende automaticamente l'ascolto per il turno successivo. La riproduzione manuale dallo storico non attiva da sola la modalità a mani libere.

Lo stesso flusso vale per un turno di discussione: la CLI può rispondere direttamente senza avviare un lavoro sul repo. Non è necessario cambiare chat o modalità per passare dalla discussione all'esecuzione.

Bozza di API del bridge (indicativa):

| Metodo | Path | Descrizione |
|---|---|---|
| `POST` | `/conversations` | Crea una conversazione (`agent`: `claude` \| `codex`, `repo` opzionale/nullo; un progetto coincide con un repository) |
| `GET` | `/conversations` | Elenco conversazioni |
| `POST` | `/conversations/{id}/turns` | Nuovo turno (audio multipart oppure `text`) |
| `GET` | `/conversations/{id}/events` | Stream SSE degli eventi |
| `POST` | `/conversations/{id}/cancel` | Interrompe il run in corso |
| `POST` | `/conversations/{id}/messages/{message_id}/audio` | Restituisce il riferimento all'audio del messaggio, generandolo se assente; non esegue un nuovo turno dell'agente |
| `GET` | `/conversations/{id}/messages/{message_id}/audio` | URL media stabile: genera o riusa il TTS e serve audio con supporto Range per Safari |
| `GET` | `/github` | Account personale, organizzazioni e catalogo paginato dei repository accessibili tramite gh |
| `GET` | `/audio/{id}` | Audio TTS generato, con supporto Range |
| `POST` | `/push/subscribe` | Registra la subscription Web Push |

## 7. Deploy (Docker)

- **Un'immagine** che contiene: bridge, `claude` (Claude Code CLI), `codex`, `git`, `gh`, runtime per i server MCP (Node, eventualmente Python).
- **Utente non root** nel container: Claude Code limita alcune modalità di permesso quando gira come root.
- **Volume persistente `/data`** (requisito vincolante per la scelta del provider):
  - `~/.claude` e `~/.codex`: credenziali e storico delle sessioni, necessari per `--resume`;
  - repo clonati (workspace);
  - stato del bridge: conversazioni, subscription push.
- **Secret via env** (mai nell'immagine): `CLAUDE_CODE_OAUTH_TOKEN`, `OPENROUTER_API_KEY`, token GitHub, chiavi VAPID, secret di autenticazione della PWA. `auth.json` di Codex va sul volume.
- **HTTPS obbligatorio**: il browser concede il microfono solo su HTTPS. Il TLS lo fornisce il provider, oppure Caddy nel `docker-compose`.
- `docker-compose.yml` per lo sviluppo locale.

**[DA DECIDERE]** Provider di hosting. Criteri: volume persistente, HTTPS, costo; possibilmente sospensione quando inattivo. Candidati emersi:
- VPS/Droplet sempre acceso (~$12–24/mese): la soluzione più semplice e sicuramente compatibile con la subscription.
- Macchine che si sospendono da sole (es. Fly.io Machines con volume).
- DigitalOcean Managed Agents: microVM con pausa automatica e billing per secondo, ma prima va verificato se accetta `CLAUDE_CODE_OAUTH_TOKEN` / `auth.json` (anche tramite template personalizzato, BYOT).

## 8. Stima dei costi

Le cifre seguenti sono stime di design precedenti alla verifica dei provider. **Da ricalcolare** con il TTS implementato e la frequenza reale degli aggiornamenti vocali; non sono misurazioni di questa versione.

| Voce | Stima |
|---|---|
| Claude / Codex | Incluso nelle subscription esistenti |
| STT + TTS (OpenRouter, ~30 min/giorno di interazione) | ~$8–12/mese (con ElevenLabs sarebbe ~$30–40) |
| Hosting | ~$0–24/mese a seconda del provider |

## 9. Roadmap

**Fase 1: MVP (opzione A)**
- Container con Claude Code e Codex autenticati via subscription, bridge e PWA con modalità voce a mani libere e rilevamento automatico della fine del parlato.
- Storico delle chat, scelta dell'agente e del progetto/repository opzionale alla creazione, conversazione testuale e schermata voce dedicata, convenzione `<voce>`.
- Pulsante “Ascolta” su tutte le risposte dell'agente, audio riutilizzabile o generato su richiesta e apertura della chat dalle notifiche senza autoplay; dispositivo di riferimento iPhone 16.
- Un run alla volta per chat, task simultanei fra chat con spazi di lavoro separati, attesa del risultato e brevi aggiornamenti vocali.
- Accesso a GitHub via `gh`.
- Discussione e task nella stessa chat, autonomia secondo le regole del repo, esecuzione indipendente dalla connessione del telefono e recupero della risposta alla riapertura.
- Web Push a fine task o quando serve input, per completare il flusso asincrono dal telefono.

**Fase 2**
- Correzioni e domande durante il lavoro, con eventuale coda dei messaggi e interruzione vocale.
- Server MCP aggiuntivi.
- Confronto delle voci TTS (gpt-4o-mini-tts vs ElevenLabs vs Voxtral vs Cartesia).

**Fase 3: opzione B (eventuale)**
- Modalità "conversazione" con un front speech-to-speech realtime (es. OpenAI `gpt-realtime` via WebRTC direttamente dal browser, con token effimero emesso dal bridge).
- Il front conversa in tempo reale e usa dei tool (`avvia_task`, `stato_task`, `invia_followup`) che chiamano il Runner. **Il lavoro resta sulla subscription**; solo la conversazione passa per le API (~$0.06–0.10/min).
- Bridge e Runner restano invariati: cambia solo lo strato voce nella PWA.

## 10. Questioni aperte (riepilogo)

- [x] Linguaggio/framework: TypeScript/Node/Express, React/Vite e SQLite
- [x] Prima autenticazione: password personale e sessione cookie, con controlli Host/Origin
- [ ] Provider di hosting
- [ ] Tool/MCP da collegare oltre GitHub
- [ ] Configurazione dell'autonomia nelle CLI e gestione da telefono delle richieste residue di input/permesso
- [ ] Caricamento delle regole del repository (`CLAUDE.md`, `AGENTS.md`) per ciascuna CLI
- [x] Prima gestione della concorrenza: clone indipendente per chat, branch iniziale dedicato e limite configurabile (default 3); verifiche ulteriori su repository reali ancora necessarie
- [x] Avvio reale di entrambe le CLI senza repository, due turni con contesto conservato e riascolto TTS verificati nel container
- [ ] Verifica dell'esperienza sulla PWA installata su iPhone 16, registrando la versione iOS utilizzata
- [ ] Politica di conservazione dei file audio, mantenendo l'ascolto su richiesta dei messaggi nello storico
- [x] Comando Ferma task nella UI e terminazione del gruppo di processi; correzioni e coda rimandate
- [x] Riavvio: run incompleti marcati interrotti, nessuna riesecuzione automatica; storico e sessioni conservati
- [ ] Runtime, dipendenze e servizi dei repository; preview e strumenti necessari alla parità desktop
- [x] Fallback TTS: prosa ripulita da blocchi di codice, URL e markdown
- [x] Verifica documentale OpenRouter dei parametri audio; vedi §5
- [ ] Verificare la durata di `CLAUDE_CODE_OAUTH_TOKEN` e definire la procedura di rinnovo
- [x] Flag confrontati con Claude Code 2.1.280 e Codex 0.156.1; invocazione e resume verificati dal bridge

## 11. Riferimenti

- Claude Code — [Legal & compliance / autenticazione](https://code.claude.com/docs/en/legal-and-compliance)
- Codex — [Authentication (headless, device auth)](https://learn.chatgpt.com/docs/auth)
- OpenRouter — [Audio APIs](https://openrouter.ai/blog/announcements/announcing-audio-apis/) · [Transcription](https://openrouter.ai/blog/tutorials/transcription-on-openrouter/) · [TTS docs](https://openrouter.ai/docs/guides/overview/multimodal/tts)
- DigitalOcean Managed Agents — [Docs](https://docs.digitalocean.com/products/managed-agents/) · [Pricing](https://docs.digitalocean.com/products/managed-agents/agent-harness-runtime/details/pricing/) · [Limits](https://docs.digitalocean.com/products/managed-agents/agent-harness-runtime/details/limits/)
- Headless auth — [Claude Code e Codex su VPS](https://codeongrass.com/blog/how-to-run-claude-code-on-a-remote-server/)


## Aggiornamento prodotto: gestione storico e preferenze voce

- Storico raggruppato per repository (senza distinzione maiuscole/minuscole), sezioni richiudibili; tutte le chat senza repository sono sotto “Chat libere”. Ricerca per titolo e repository.
- Menu ⋯ in ogni riga e nella chat attiva: rinomina persistente, eliminazione con conferma. Le chat con task attivi non sono eliminabili. Nessuna rimozione dei checkout Git o della cache audio condivisa.
- La cancellazione dei record è transazionale; gli eventi SSE della chat vengono sostituiti da tombstone senza contenuto, mantenendo progressivi validi per riconnessione. Le altre finestre tornano alla home quando la chat aperta viene eliminata.
- Impostazioni voce persistite in SQLite: modello STT, modello TTS e voce. Catalogo OpenRouter filtrato per output `transcription` e `speech`, cache di cinque minuti; salvataggio con validazione e ripristino dei valori configurati sul server. Un audio già in generazione mantiene la propria configurazione.
- Endpoint autenticati aggiunti: `POST /api/conversations/:id/rename`, `POST /api/conversations/:id/delete`, `GET/POST /api/settings/audio`, `GET /api/settings/audio/models`. Nessuna chiave API viene esposta.

### Selezione guidata del repository

La nuova chat propone “Chat libera” oppure “Repository GitHub”. Per un progetto si sceglie prima l’account/organizzazione, poi si filtra l’elenco dei repository digitando parte del nome e si seleziona una riga. Il nome completo è costruito dal risultato GitHub; cambiare account rimuove la selezione precedente. Il pulsante Crea chat resta disabilitato finché non è scelto un repository. Il percorso manuale è un’alternativa esplicita.

`GET /api/github` comprende `owners` (account personale, organizzazioni e proprietari dei repository accessibili) e `repositories`. Il backend usa `gh api --paginate` per superare il limite della prima pagina, conserva in cache per un minuto i risultati riusciti e raggruppa le richieste simultanee. L’elenco non richiede nuovi permessi GitHub rispetto alle credenziali già presenti; un’organizzazione può avere zero repository visibili con quelle credenziali.

### Microfono in modalità voce

Il comando esplicito Disattiva/Riattiva microfono mostra lo stato anche durante un run o la riproduzione TTS. Disattiva le tracce audio, azzera il rilevamento vocale e scarta la clip eventualmente in corso. Lo stato mute è applicato anche se il permesso del microfono arriva in ritardo, ed è mantenuto alla fine della risposta; riattivarlo durante un run abilita l’acquisizione soltanto quando il run e l’audio sono conclusi. Le prove browser usano un ingresso simulato, senza registrare dal dispositivo fisico.


### MCP: autorizzazione dal telefono (26 settembre 2026)

Implementati `server/mcp.ts`, `server/mcp-request.mjs` e la scheda `src/McpConnections.tsx`. Il flusso può partire dalla richiesta in chat o da Impostazioni → MCP, disponibile anche senza una chat aperta. L’helper riceve un’autorizzazione limitata al turno corrente e restituisce solo stato e nome, senza codici o link OAuth nel contesto dell’agente.

L’app è il client OAuth del servizio remoto, usando l’SDK MCP ufficiale: discovery, registrazione dinamica, PKCE, stato monouso con scadenza di dieci minuti, callback pubblico sotto `/api/mcp/callback` e rinnovo dei token. Il callback non dipende dal cookie SameSite della PWA; valida invece stato, destinazione esatta e PKCE. Alternativa manuale: incollare il callback nel campo dedicato oppure avviare una nuova registrazione per `http://localhost:4319/callback` se il servizio rifiuta il dominio pubblico. Non vengono alterati i redirect di richieste OAuth già firmate/avviate.

I token sono conservati atomicamente in `DATA_DIR/mcp/connections.json` con permessi 0600 (directory 0700), separati da messaggi/eventi e da credenziali native delle CLI. I collegamenti sono globali per tutte le chat e per entrambi gli agenti, persistono ai riavvii e sopravvivono all’eliminazione delle chat. La rimozione è locale: il consenso presso il provider non viene revocato automaticamente.

A ogni turno il runner inietta gli MCP con stato collegato: `--mcp-config` per Claude, override `mcp_servers` per Codex. Entrambi usano un gateway HTTP locale autenticato con una credenziale dedicata via ambiente. Il gateway conserva semantica HTTP, sessioni MCP e streaming SSE della risposta; usa il token upstream e non inoltra cookie, header arbitrari o la credenziale locale. Gli strumenti sono disponibili dal messaggio successivo, senza riavviare o ripetere task in corso.

Supportati MCP remoti Streamable HTTP senza autenticazione o con OAuth/DCR. Non ancora gestiti nel pannello: client pre-registrati, CIMD, bearer token manuali, stdio o trasporto SSE legacy. La prova automatizzata usa un provider OAuth/MCP locale che verifica realmente PKCE e redirect URI; test UI su Chromium/WebKit. La verifica account/provider reale e la prova sul telefono fisico restano distinte dai test automatici.


### MCP globali e impostazioni

La scheda MCP è accanto a Voce nelle Impostazioni e mostra tutti i collegamenti gestiti dall’app: aggiunta, stato, verifica/login e scollegamento con conferma per tutte le chat. Il collegamento rapido nella chat apre lo stesso pannello. Le modifiche sono diffuse con un evento SSE globale; le altre finestre rileggono lo stato anche al ritorno in primo piano.

Gli endpoint autenticati di gestione sono ora `GET/POST /api/mcp` e `POST /api/mcp/:connectionId/{login,complete,delete}`. Gli URL precedenti sotto le chat restano alias per finestre PWA non ancora aggiornate. Il runner carica tutti gli MCP collegati a ogni turno, indipendentemente dalla chat o dall’agente. Eliminare una chat non elimina credenziali MCP; scollegare dal pannello impedisce le chiamate successive da qualunque chat, mentre una chiamata già in corso può terminare.

Migrazione automatica del file esistente: il vecchio `conversationId` diventa soltanto un suggerimento di navigazione `returnToChat`, senza definire lo scope. I nomi duplicati vengono distinti con suffissi evitando collisioni, mantenendo separati account, ID, token e login pendenti. Il callback torna alla chat di origine se esiste, altrimenti a `/?settings=mcp`. Non serve un nuovo login per i collegamenti già funzionanti.


### Browser condiviso come capacità, sessioni separate per chat

`server/browser.ts` gestisce Chromium Headless Shell tramite Playwright e un server MCP HTTP stateless integrato. Il runner inietta `personal_agent_browser` in entrambe le CLI a ogni turno, con token effimero associato alla chat e al segnale di cancellazione. Claude usa `--system-prompt-snapshot off` affinché anche i resume ricevano le istruzioni aggiornate. Non richiede un MCP esterno o account browser cloud.

Le operazioni usano snapshot di accessibilità compatte e selettori role/name o CSS, anziché screenshot continui nel contesto del modello. Gli screenshot richiesti vengono salvati come JPEG e restituiti anche al modello se sotto il limite per eventi CLI; i file più grandi restano disponibili come artifact e nel pannello. Supportati navigazione/indietro, click, fill, select, tastiera, scroll, attesa mirata, schede, dialoghi JavaScript e lettura errori pagina. I dialoghi non bloccano il comando MCP: lo strumento restituisce lo stato e un comando successivo può rispondere.

Il processo browser è avviato su richiesta e condiviso; i BrowserContext sono separati per chat. Allocazione serializzata, limite pari a maxRuns, massimo quattro schede, azioni seriali per chat. Chiusura dopo 15 minuti senza azioni o sotto pressione del limite; contesti impegnati non vengono espulsi. Cookie/local storage persistono su file privati; al riavvio le pagine sono nuove. Lo shutdown chiude i contesti e Chromium, la cancellazione interrompe l’azione e chiude il contesto interessato. Eliminare una chat elimina i suoi cookie e screenshot, indipendentemente dagli MCP globali.

La PWA mostra il pulsante Browser con indicatore di attività. `GET /api/conversations/:id/browser` restituisce stato e screenshot; `/frame` restituisce il JPEG della scheda attiva; `/screenshots/:shotId` serve artifact verificandone l’appartenenza alla chat. Tutti richiedono la sessione dell’app. Il controllo `/api/browser/mcp` richiede invece il token effimero del turno. Gli eventi SSE notificano solo che lo stato è cambiato. Il viewer richiede frame ogni 1,2 secondi, solo quando aperto/visibile; niente VNC, WebSocket di debug o iframe di siti non attendibili nella PWA.

Docker installa solo `playwright install --with-deps --only-shell chromium`, browser Playwright allineato alla dipendenza runtime fissata, shm 256 MB e utente node. L’ambiente del processo Chromium esclude credenziali app/CLI; la sandbox interna Chromium è disabilitata solo nel container. I controlli sugli URL non sono una sandbox di rete completa. Le restrizioni dei siti (CAPTCHA, anti-automazione, login interattivi) possono richiedere interventi ulteriori: la prima UI permette osservazione e download, non controllo manuale del browser remoto.

Verifica del 26 settembre 2026: build TypeScript/Vite, 12 test backend e 20 test UI su Chromium/WebKit superati. La prova `test:browser-engine` passa sia sul Mac sia nell’immagine Docker, con sito locale offline, protocollo MCP reale, navigazione/interazioni/dialoghi, isolamento cookie, persistenza al riavvio, screenshot e cancellazione. Dopo l’aggiornamento del container, entrambe le CLI reali (Claude Code e Codex) hanno completato una navigazione su example.com, letto il titolo e prodotto uno screenshot recuperabile dall’endpoint autenticato. Chat temporanee eliminate al termine. La prova UI automatica non sostituisce una verifica sul dispositivo iPhone fisico.

### Gestione delle skill nell’app

`server/skills.ts` conserva le globali come impostazione SQLite, con contenuto Markdown e lista esplicita degli agenti assegnati. Le API autenticate `/api/skills` e `/api/skills/:id` permettono elenco, lettura, creazione, aggiornamento e rimozione; gli eventi `skills_changed` contengono solo l’invalidazione. `src/SkillsSettings.tsx` aggiunge la scheda Skill accanto a Voce/MCP. L’import accetta solo un Markdown con frontmatter YAML valido, massimo 64 KB; non installa archivi né esegue script.

Le API `/api/conversations/:id/skills` e `/skills/file?path=...` elencano e leggono le skill della copia di progetto esistente. I percorsi riconosciuti sono `.agents/skills`, `.claude/skills`, `.codex/skills` anche nei sottoprogetti; i file di progetto sono per entrambi gli agenti. La scansione esclude directory di dipendenze/build e link simbolici, con limiti di 100 skill, 6000 directory e profondità 12. Un file si legge dal pannello solo se appartiene alla scansione e il percorso reale rimane nella repo. Skill non valide o escluse generano avvisi; la UI non modifica i file Git.

Prima di ogni `runAgent`, `SkillService.access` genera snapshot privati delle globali selezionate e un catalogo con riferimenti alle skill del progetto. Il catalogo è anteposto all’input stdin del turno Claude/Codex, anche nei resume, con lettura progressiva dei SKILL.md e riferimenti relativi alla cartella originale. Le istruzioni generali indicano che questo catalogo sostituisce quelli precedenti. Non si usa soltanto developer_instructions per gli aggiornamenti: la prova reale ha rilevato che Codex può conservare il catalogo iniziale nei resume. Oltre 48 KB di metadati si usa un file catalogo per contenere la dimensione del messaggio. Il finally elimina gli snapshot del turno. Modificare un’assegnazione non cambia i run già partiti. Non si pretende di rimuovere skill native installate esternamente né di rendere i file inaccessibili ad agenti con autonomia completa.

Verifica del 26 settembre 2026: build e 14 test backend superati; 20 test UI esistenti superati e i due nuovi test Skill passati su Chromium/WebKit dopo la correzione dello scorrimento mobile. Prova reale sulle CLI: Claude legge skill da `.agents/skills`, Codex legge skill da `.claude/skills`; la globale assegnata solo a Claude è esclusa da Codex e diventa utilizzabile nel suo stesso resume dopo l’abilitazione di entrambi. La correzione consiste nell’inviare il catalogo a ogni turno via stdin. Fixture e database di prova temporanei rimossi al termine; nessuna repository utente modificata.

### Terminale interattivo nelle impostazioni

`server/terminal.ts` gestisce una singola sessione Bash tramite `node-pty`. Gli endpoint autenticati `/api/terminal`, `/start`, `/:id/{events,input,resize,stop}` espongono stato, avvio esplicito, output SSE con sequenze, input e controllo. Le mutazioni applicano i controlli Origin dell’app. La cartella iniziale deriva solo dalla home o dal workspace registrato della chat; non si ricevono comandi di avvio arbitrari dalle API. La shell viene eseguita solo fuori dalla demo e con autonomia abilitata, con i privilegi dell’utente del server.

`src/TerminalSettings.tsx` carica xterm.js solo quando si apre la scheda. Input serializzato senza reinvio automatico in caso di esito incerto, ridimensionamento PTY, tasti speciali e campo riga per il telefono. Chiudere la UI disconnette soltanto lo stream. Il backend conserva circa 256 KiB di output recente, massimo sei viste, heartbeat e riconnessione con Last-Event-ID; l’output non è scritto negli eventi SQLite. Non è prevista la persistenza dei processi dopo riavvio. Lo shutdown e la chiusura esplicita inviano SIGHUP, con SIGKILL di riserva alla shell.

`server/tool-environment.ts` e l’entrypoint Docker condividono `NPM_CONFIG_PREFIX=/data/tools` e PATH con gli agenti. Home `/data/home`, tool e workspace rimangono sul volume. Le installazioni npm globali non richiedono root; make/g++ sono inclusi per moduli nativi. Il processo shell riceve l’ambiente CLI filtrato, senza ereditare le chiavi audio o la password dell’app. Il terminale ha comunque accesso ai file del proprio utente, coerentemente con l’autonomia completa. Bash legge la propria configurazione e mantiene la cronologia nella home persistente; login e segreti delle CLI restano responsabilità dei rispettivi strumenti.

Le prove backend usano un vero PTY e una CLI npm locale offline per verificare autenticazione, Origin, input interattivo, dimensioni, Ctrl+C, riconnessione, chiusura dei job, persistenza e disponibilità nel runner. Le prove UI su Chromium/WebKit simulano il trasporto terminale e verificano input, controlli, riapertura senza duplicare la shell, conferma di chiusura e layout mobile.

Verifica terminale del 26 settembre 2026: build TypeScript/Vite riuscita, 16 test backend e 24 test UI su Chromium/WebKit superati. Anche i due test terminale con PTY reale passano nell’immagine Docker finale senza rete esterna, inclusa installazione npm della CLI fixture e utilizzo dal runner. Nessuna CLI o credenziale Railway è stata installata durante le prove.
