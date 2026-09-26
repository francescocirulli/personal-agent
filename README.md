# Personal Agent

PWA personale con chat persistenti, Claude Code/Codex tramite subscription e voce in italiano. Il backend esegue i task anche quando il telefono si disconnette. Il progetto è nella fase di prima versione funzionante: la verifica sul dispositivo fisico e il deploy cloud sono passi successivi.

## Avvio

Richiede Node.js 22.13+ oppure Docker. Le CLI reali devono essere autenticate con le rispettive subscription. Nessuna API key per il modello che esegue i task.

```sh
npm ci
cp .env.example .env # solo se .env non esiste già
# Compila le credenziali senza condividerle in chat o commetterle in Git.
npm run dev
```

Vite serve la PWA su `http://localhost:5173`; il bridge ascolta su `127.0.0.1:4310`. Per la versione compilata: `npm run build && npm start`, poi `http://localhost:4310`. Imposta `APP_ORIGIN` all'origine esatta utilizzata (schema, host e porta). Per provare il flusso senza eseguire CLI: `DEMO_MODE=true npm run dev`. La modalità dimostrazione è indicata nell'interfaccia e non simula risultati reali.

## Docker e telefono

Imposta in `.env` una `APP_PASSWORD` di almeno 24 caratteri e l'`APP_ORIGIN` HTTPS. Quindi:

```sh
docker compose up -d --build
docker compose logs --tail 30 app
```

Compose interpreta le virgolette dotenv; non sostituirlo con `docker run --env-file .env`, che tratta le virgolette letteralmente. Il volume `personal-agent-data` contiene database, checkout, audio e login delle CLI. L'app gira come utente non root. La porta viene pubblicata solo su loopback; davanti serve un proxy HTTPS o un accesso privato come BB Connect.

In questa sessione di sviluppo l'anteprima è esposta tramite BB Connect. Il link richiede la sessione del proprietario su BB; il computer e Docker devono restare accesi. Non è ancora un deploy cloud indipendente.

Su iPhone 16, apri l'indirizzo HTTPS in Safari e usa **Condividi → Aggiungi alla schermata Home**. Accedi con la password, crea una chat e scegli agente e repository facoltativo. Apri **Voce** per conversare oppure usa **Ascolta** su qualunque risposta precedente. Pausa e ripresa non avviano il microfono. Nella schermata voce il pulsante **Disattiva microfono / Riattiva microfono** permette di conversare anche in ambienti rumorosi: quando è disattivato puoi continuare ad ascoltare, senza inviare audio; una registrazione in corso viene scartata. Il mute resta attivo fino alla riattivazione esplicita nella stessa sessione vocale.

## Credenziali

- `CLAUDE_CODE_OAUTH_TOKEN`: token ottenuto con `claude setup-token`. Il bridge invoca il binario ufficiale e non chiama l'API Anthropic.
- Codex: esegui `docker compose exec app codex login --device-auth` e completa l'accesso nel browser. È possibile inizializzare il volume con il proprio `auth.json`; successivamente il container mantiene la sua copia. Non montare tutta la home del computer. Il runner richiede `forced_login_method="chatgpt"`.
- `OPENROUTER_API_KEY`: usata soltanto dal servizio audio. Il TTS predefinito è `google/gemini-3.8-flash-lite-tts`, voce `Kore`; STT `openai/gpt-4o-transcribe`. Il modello TTS originariamente previsto nel documento non era disponibile alla verifica del catalogo e delle API del 26 settembre 2026.
- GitHub: autentica `gh` nel container (`docker compose exec app gh auth login` seguito da `gh auth setup-git`) oppure aggiungi `GH_TOKEN` con accesso ai repository richiesti. Il login e l’identità Git restano nel volume. Nella creazione chat scegli “Repository GitHub”, poi account personale/organizzazione, cerca il repository scrivendo le prime lettere e tocca il risultato. Il catalogo comprende tutte le pagine dei repository accessibili, inclusi quelli privati; il cambio account azzera la selezione precedente. Resta disponibile l’inserimento manuale del percorso come alternativa. L'entrypoint configura `gh` come credential helper Git. Per commit, configura nome/email nel container con `git config --global user.name` e `user.email`. Nessun push/commit reale viene eseguito dai test automatici.
- Web Push: genera una volta le chiavi con `npm run keys:vapid`, salva `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` e `VAPID_SUBJECT` in `.env`. Nell'app premi **Notifiche**. La consegna su iPhone richiede la verifica sulla PWA installata.

Le chiavi non entrano nell'immagine né nel frontend. `.env` e `.data` sono esclusi da Git e dal contesto Docker. L'ambiente delle CLI non eredita le chiavi audio, la password dell'app o le API key OpenAI/Anthropic. Il container contiene comunque tutti i dati del singolo utente: i checkout separati evitano interferenze tra task, **non costituiscono sandbox di sicurezza tra chat**.

## Comportamenti implementati

- Tema scuro neutro predefinito, ispirato a ChatGPT: superfici antracite, testi bianchi/grigi, pulsanti principali chiari e tipografia sans-serif. Coerente anche su accesso, impostazioni, modalità voce e icone PWA.
- Storico in SQLite/WAL, scelta fissa dell'agente per chat, progetto opzionale `owner/repository`.
- Storico raggruppato per repository, con una sezione unica per le chat libere. Dal menu ⋯ si può rinominare o eliminare una chat; il titolo manuale resta invariato nei turni successivi. L’eliminazione rimuove messaggi, attività e run, e sincronizza le finestre aperte. I checkout e la cache audio condivisa rimangono sul volume; nessun file Git viene cancellato. I task attivi vanno conclusi o fermati prima.
- **Impostazioni → Voce**: modelli OpenRouter per trascrizione e sintesi, più identificativo della voce. Catalogo aggiornato da OpenRouter, con validazione della modalità del modello; la voce deve essere compatibile con il provider scelto. Le preferenze sono persistite in SQLite, prevalgono sui valori di `.env` e si applicano ai nuovi audio senza riavvio. “Ripristina predefiniti” riprende i valori del server. Le chiavi restano sul server; queste impostazioni non cambiano il modello delle CLI.
- Un run attivo per chat; fino a tre chat lavorano contemporaneamente (configurabile). Quando la capacità è esaurita, il nuovo invio viene rifiutato esplicitamente, senza coda nascosta.
- Clone indipendente per chat con branch iniziale dedicato; directory indipendente per le chat libere. Le istruzioni chiedono alle CLI di rispettare `CLAUDE.md` e `AGENTS.md` applicabili.
- Session ID delle CLI persistiti e riutilizzati per i turni successivi.
- **Modello della chat**: selettore dentro ogni chat Claude Code o Codex, con scelta persistente e ID personalizzato. Vale dal messaggio successivo, anche sui resume, senza interrompere il task attivo. Codex legge i suggerimenti dalla cache locale della CLI; Claude propone gli alias `opus`, `sonnet`, `haiku`. La disponibilità dipende dalla subscription. “Predefinito CLI / sessione” omette l’override: una sessione ripresa può mantenere il proprio modello precedente. Il pannello non modifica il modello audio o l’agente della chat.
- SSE con eventi salvati, replay e ricaricamento dello stato; chiudere lo stream non cancella il task. Gli eventi recuperati non attivano audio retroattivo.
- Arresto del gruppo di processi, con SIGKILL dopo il periodo di grazia. Dopo un riavvio un run incompleto viene marcato interrotto, senza riesecuzione automatica di effetti già compiuti.
- Trascrizione dell'audio, parte parlata `<voce>`, cache TTS per testo/modello/voce, generazione su richiesta anche dei messaggi ricevuti in modalità testo.
- Un player globale: l'ultimo ascolto richiesto sostituisce quello precedente. Le risposte HTTP tardive non cambiano la chat che sta parlando. Gli aggiornamenti tecnici sono solo testuali; in modalità voce viene letta la risposta finale. Il player usa un elemento audio HTML con avvio diretto dal tocco e URL protetto compatibile con richieste HTTP Range, senza attendere un fetch JavaScript prima di play().
- Service worker, manifest e icone; Web Push con apertura della chat senza autoplay.
- Accesso con cookie HttpOnly/SameSite, controllo Host/Origin, limite ai tentativi di login e protezione anche di SSE/audio.

In Docker `AGENT_UNRESTRICTED=true` abilita l'autonomia richiesta dentro il container. Per sviluppo diretto sul computer il valore predefinito è `false`: Codex usa workspace-write senza prompt, Claude `dontAsk`. Le azioni che richiedono permessi aggiuntivi possono quindi essere negate in questa modalità locale.

## Collegamenti MCP dal telefono

Nella chat puoi chiedere «Collega questo MCP: https://…/mcp» oppure aprire **Impostazioni → MCP** e inserire nome e indirizzo. Il pannello è accessibile anche senza aprire una chat; il collegamento rapido nella chat porta alla stessa sezione globale. Claude Code e Codex ricevono un helper per aggiungere il servizio senza avviare terminali interattivi. La scheda **Accedi al servizio** apre il browser sul telefono; l’app riceve il callback, verifica l’accesso al server MCP e aggiorna lo stato. Gli strumenti sono caricati **dal messaggio successivo in tutte le chat**, nuove ed esistenti, sia Claude Code sia Codex. Un turno già in esecuzione non viene interrotto o rieseguito.

Il ritorno automatico usa `APP_ORIGIN/api/mcp/callback`: il dominio deve essere raggiungibile dal browser. Con BB Connect privato può essere necessario essere autenticati anche nel browser esterno alla PWA. Tornando alla PWA, il collegamento viene riletto dal server.

Se il sito non torna all’app, apri **Usa copia e incolla** e incolla l’URL completo della pagina finale nel campo dedicato. Se il servizio rifiuta il dominio di ritorno, **Avvia login manuale** registra un nuovo flusso con `http://localhost:4319/callback`: dopo l’autorizzazione il telefono può mostrare una pagina non raggiungibile; copia comunque l’indirizzo e incollalo nel campo. Non incollare codici o URL di ritorno nella normale conversazione. Il login scade dopo dieci minuti e può essere riavviato.

Supporto attuale: MCP remoti **Streamable HTTP**, senza login oppure con OAuth e registrazione dinamica del client. La compatibilità OAuth dipende dal servizio: provider che richiedono un client pre-registrato, token statici, client metadata document pubblico, trasporti legacy SSE o stdio richiedono configurazione ulteriore e non sono gestiti da questo pannello. Il copia-incolla non aggira queste limitazioni. Eventuali MCP configurati direttamente nelle CLI continuano a essere caricati dalle CLI.

I collegamenti gestiti dall’app sono globali. **Impostazioni → MCP** mostra stato e indirizzo, permette aggiunta, verifica/login e scollegamento con conferma per tutte le chat. Scollegare cancella le credenziali locali e blocca le chiamate successive, senza revocare il consenso sul sito del servizio. Eliminare una chat conserva i collegamenti. I collegamenti precedentemente associati a singole chat vengono migrati automaticamente, conservando ID, credenziali e login in attesa; eventuali nomi duplicati ricevono un suffisso numerico senza unire account diversi. Lo stato privato è in `DATA_DIR/mcp/connections.json` (directory 0700, file 0600), include token OAuth e deve essere trattato come le credenziali delle CLI nei backup. Solo i metadati e il link temporaneo di login raggiungono la UI autenticata; codici, verifier, refresh token e chiavi del gateway non entrano in messaggi o eventi SSE.

Il backend usa l’SDK MCP ufficiale per discovery, registrazione, PKCE e rinnovo token. Le CLI ricevono un endpoint locale per ogni collegamento, con credenziale dedicata tramite variabile d’ambiente; il gateway inoltra soltanto gli header MCP necessari e il token del servizio. Non modifica il redirect URI di un flusso già avviato. Il callback usa stato casuale monouso e PKCE, indipendentemente dal cookie dell’app, per consentire il ritorno da Safari.

## Browser interattivo degli agenti

Claude Code e Codex ricevono automaticamente lo strumento MCP integrato `personal_agent_browser`. Possono aprire siti, leggere la struttura accessibile della pagina, cliccare, compilare campi, selezionare opzioni, usare la tastiera, scorrere, gestire schede/dialoghi JavaScript e salvare screenshot. Per esempio: «Apri il sito, prova il modulo e fammi uno screenshot». Il browser usa JavaScript reale; non è una semplice lettura HTML.

Il pulsante **Browser** nella chat apre la vista della pagina corrente, aggiornata circa ogni secondo mentre il pannello è aperto e il telefono è in primo piano. Puoi ingrandire l’immagine, consultare gli screenshot salvati e scaricarli. Questa prima vista è di osservazione: le interazioni si chiedono all’agente in chat, non si clicca direttamente sull’immagine. Non eredita i login del browser del telefono. Aprire la vista senza una navigazione dell’agente non avvia Chromium.

In Docker viene installato solo **Chromium Headless Shell**, con Playwright fissato alla versione `1.63.0`, senza desktop, VNC o porta di debug pubblica. Un processo Chromium parte al primo utilizzo, con contesti separati per chat (cookie/schede distinti). Al massimo `MAX_CONCURRENT_RUNS` contesti e quattro schede per chat; i contesti inattivi vengono chiusi dopo 15 minuti e riaperti su richiesta. Il browser si spegne quando non restano contesti. Le immagini live vengono generate solo se richieste da una vista aperta, condividendo richieste simultanee e una breve cache.

Cookie e local storage sono salvati con permessi 0600 in `DATA_DIR/browser/<chatId>/storage.json`, distinti per chat. Le schede aperte non vengono ripristinate dopo riavvio; alla nuova navigazione vengono riutilizzati i cookie/local storage. Screenshot JPEG e metadati sono nello stesso percorso: si conservano gli ultimi 12 per chat. Eliminare una chat elimina anche questi dati del browser, senza toccare gli MCP globali o il checkout Git. I profili contengono dati di accesso e fanno parte dei dati privati del volume.

Il controllo MCP usa credenziali casuali limitate al turno e alla chat. La visualizzazione e i file passano dagli endpoint autenticati dell’app; non vengono registrati screenshot, valori compilati o token negli eventi SSE. Le azioni da due chat non condividono pagine o cookie. Chromium riceve un ambiente ridotto senza le chiavi API/password dell’app. Sono rifiutati indirizzi non HTTP(S), l’origine dell’app, la porta di controllo e i noti indirizzi metadata; restano raggiungibili le preview dei progetti su altre porte locali. Non è una sandbox di rete completa. Dentro il container dedicato `BROWSER_NO_SANDBOX=true` disabilita la sandbox interna di Chromium, come richiesto dal runtime Docker; il processo resta sotto l’utente non root del container e non espone CDP. Lo stesso flag non va aggiunto al normale sviluppo sul computer.

Per sviluppo locale installare il browser con `npx playwright install --with-deps --only-shell chromium`. Per eseguire la prova completa offline: `npm run test:browser-engine`. Usa un server web locale e il vero protocollo MCP con Chromium, senza chiamate ai modelli né account esterni.

## Verifiche

```sh
npm run check          # TypeScript, build, test backend
npx playwright install chromium webkit
npm run test:e2e       # browser isolato, risposte demo; nessun consumo delle subscription
npm run test:browser-engine # Chromium reale + MCP su un sito locale di prova
node --import tsx scripts/smoke-live.ts # SOLO su richiesta: CLI reali + brevi richieste audio
```

I test backend coprono persistenza, concorrenza, cancellazione, isolamento degli endpoint, autenticazione, replay SSE, parser delle CLI e riuso dell'audio. I test browser coprono chat libera, suggerimenti GitHub, tema scuro, reload durante il lavoro, storico, schermata vocale, avanzamento reale del player audio con pausa/ripresa e assenza di overflow mobile. Le risposte simulate richiedono service worker disabilitato nella suite. Le credenziali non vengono stampate dal test live.

Verifica eseguita il 26 settembre 2026: build riuscita, 10 test backend e 12 test browser su Chromium/WebKit verificati, inclusi gruppi, rinomina, eliminazione sincronizzata e impostazioni voce. Entrambe le CLI hanno completato due turni nella stessa sessione nel container, ricordando il contesto e producendo audio riascoltabile. Verificato anche il percorso completo **file audio → trascrizione → Codex → risposta vocale**. Verificato il collegamento GitHub e l’accesso Git in lettura a un repository privato dal container. I test non includono il microfono fisico dell'iPhone, una consegna push reale o modifiche/push su un repository privato.

Per ripetere solo la prova di ingresso audio: `SMOKE_AGENTS='' SMOKE_AUDIO_INPUT=true node --import tsx scripts/smoke-live.ts`. Questa prova usa la subscription e brevi chiamate audio a pagamento.

## Limiti della prima versione

- Il rilevamento delle pause usa un VAD energetico adattivo: va tarato sul microfono dell'iPhone e in ambienti rumorosi. Non è ancora Silero. Durante lavoro e riproduzione il microfono non invia turni; niente interruzione parlata.
- Uscire dalla schermata voce o portare l'app in background termina l'ascolto. I task proseguono; l'audio si riascolta dalla chat. La sospensione di Safari/PWA e la consegna push non si possono certificare con un browser desktop simulato.
- Ambienti specifici dei repository, preview dei progetti, allegati, selezione dell’effort e gestione completa dei file non hanno ancora un'interfaccia dedicata. La parità completa con le CLI desktop resta l'obiettivo, non un risultato già raggiunto.
- Il riassunto parlato è quello generato dall'agente; in assenza del tag si usa prosa ripulita dal markdown. Lo storico conserva la risposta testuale completa. Gli audio restano sul volume: manca ancora una politica automatica di pulizia.
- Un solo backend per volume/database. Nessuna alta disponibilità o ripresa automatica dopo crash.

## Riferimenti verificati

- [Claude Code in modalità headless](https://code.claude.com/docs/en/headless); opzioni confrontate con CLI 2.1.280.
- Codex: opzioni confrontate con `codex exec --help` e `codex exec resume --help`, versione 0.156.1; login e invocazione reale verificati nel container.
- [OpenRouter STT](https://openrouter.ai/docs/guides/overview/multimodal/stt) e [TTS](https://openrouter.ai/docs/guides/overview/multimodal/tts): audio API separate. Gemini TTS richiede PCM; il bridge aggiunge un header WAV (24 kHz, mono, PCM16) per la riproduzione. `prompt` STT multipart è accettato ma ignorato; non viene usato.

Le ipotesi legali e le stime economiche nel documento di architettura non sono state ricertificate da questa implementazione.

Verifica MCP del 26 settembre 2026: 12 test backend e 18 test browser Chromium/WebKit passati. Un provider OAuth/MCP locale verifica registrazione, PKCE, redirect esatto, callback senza cookie, rifiuto di URL scaduti/riutilizzati/di altri collegamenti, fallback manuale, rinnovo token, inoltro JSON/SSE e persistenza dopo riavvio. Le configurazioni del runner includono entrambi gli agenti; i parametri Codex sono stati anche letti dalla CLI installata. Il login con un account esterno reale deve ancora essere verificato sul servizio scelto dall’utente.

La migrazione globale è verificata anche con nomi duplicati e login pendenti. I test confermano la condivisione tra agenti/chat, la conservazione dopo eliminazione della chat, l’accesso alle impostazioni senza chat e la sincronizzazione dello scollegamento tra finestre.

## Skill globali e del progetto

**Impostazioni → Skill** permette di creare, importare un file `SKILL.md`, modificare ed eliminare le skill globali gestite dall’app. Le caselle **Claude Code** e **Codex** sono una scelta esplicita: selezionarne una oppure entrambe. Servono `name` e `description` nell’intestazione YAML, seguiti dalle istruzioni. Il nome usa minuscole, numeri e trattini. Limite: 64 KB per file, 100 globali. Questa prima gestione importa il solo Markdown; per skill con script, riferimenti o altri allegati usare una cartella completa nella repository.

La sezione **Del progetto** elenca le skill della copia locale usata dalla chat selezionata, dopo il primo task che prepara il clone. Rileva `.agents/skills/<nome>/SKILL.md`, `.claude/skills/<nome>/SKILL.md` e il percorso legacy `.codex/skills/<nome>/SKILL.md`, anche nelle sottocartelle. Le espone a **entrambi gli agenti**, senza un selettore di assegnazione e senza scrivere o duplicare file Git. Il pannello permette di leggerle; per modificarle chiedere all’agente di intervenire nella repo. I percorsi distinguono skill omonime e copie della repo con contenuti diversi. File non validi, link simbolici e limiti della scansione vengono segnalati.

A ogni messaggio il bridge prepara un catalogo aggiornato per l’agente: sole globali assegnate, più tutte le skill del progetto. Il catalogo contiene metadati e percorsi; le istruzioni complete si leggono su richiesta. È anteposto alla richiesta inviata via stdin a ogni turno, anche sui resume, permettendo a ciascun agente di leggere skill dell’altro senza dipendere dal suo menu nativo. Il solo override delle istruzioni nella configurazione della CLI non aggiorna in modo affidabile il catalogo nei resume Codex. A parità di nome si preferisce la skill del progetto pertinente, o si chiede il percorso quando ambiguo. Le CLI continuano a gestire le loro eventuali skill native: il pannello non importa né disattiva quelle installate manualmente nel container o solo sul Mac.

Le globali dell’app sono conservate nel database sul volume persistente. Ogni task riceve una copia immutabile dei Markdown in `DATA_DIR/skill-runs/<runId>`, con file privati eliminati al termine. Salvataggio, cambio assegnazione ed eliminazione valgono dal turno successivo; non interrompono task già in esecuzione. La disponibilità è una regola del catalogo e delle istruzioni, non una sandbox di filesystem tra agenti. Le regole `AGENTS.md`/`CLAUDE.md` restano applicabili.

`tests/skills.test.ts` verifica scope, persistenza, snapshot del turno, interoperabilità dei percorsi, autenticazione e validazione. Il test UI verifica importazione, scelta agenti, modifica, persistenza, lettura delle skill della repo ed eliminazione su Chromium/WebKit. `node --import tsx scripts/smoke-skills.ts` è una prova esplicita sulle subscription reali: usa repository temporanee e controlla i due agenti più un resume con assegnazione aggiornata; non eseguirla come test offline.

## Terminale dal telefono

**Impostazioni → Terminale → Avvia terminale** apre una shell interattiva nell’ambiente degli agenti. La cartella iniziale può essere la home condivisa oppure il workspace di una chat già preparata. Sul telefono puoi usare il campo **Comando o risposta**, la tastiera diretta e i tasti Ctrl+C, Tab, frecce, Esc e Ctrl+D. I link HTTP(S) nell’output aprono **Browser del terminale**, un Chromium interattivo dentro l’app. Il pulsante omonimo permette anche di incollare un indirizzo. Puoi toccare la pagina, ingrandirla, scorrere, cambiare scheda, scrivere nel campo selezionato e inviare i tasti Tab/Invio. Il testo da inviare è mascherato per impostazione iniziale; il sito può comunque mostrarlo nel proprio campo.

Le CLI npm installate con `npm install -g nome-pacchetto` vengono salvate in `DATA_DIR/tools`, sul volume persistente, e diventano disponibili ai successivi task di Claude e Codex. Per esempio:

```sh
npm install -g @railway/cli
railway --version
railway login
```

Anche `~/.local/bin`, `~/.railway/bin`, `~/.cargo/bin` e `~/.bun/bin` sono nel PATH degli agenti. Home, credenziali salvate dalle CLI e workspace persistono nel volume. Il terminale usa l’utente non root del container: pacchetti di sistema che richiedono root vanno aggiunti al Dockerfile. Il login nativo delle CLI è distinto dal pannello OAuth degli MCP. La shell configura `BROWSER`, `xdg-open` e `sensible-browser` per aprire la pagina nel browser integrato; la UI mostra il pannello quando arriva una nuova apertura. Le CLI che ignorano questi meccanismi possono richiedere di toccare o incollare il link. Il browser gira sullo stesso server della shell e raggiunge i callback HTTP su localhost, salvo le porte protette dell’app. I provider che bloccano Chromium automatizzato, richiedono passkey o un browser esterno possono richiedere `railway login --browserless` o l’equivalente del servizio; il link “Apri sul dispositivo” è utile per questi flussi, ma non sposta un callback localhost sul server.

Il browser del terminale ha un profilo persistente condiviso, separato dalle chat, in `DATA_DIR/browser/terminal`. Cookie e local storage rimangono sul volume privato. Le interazioni e il testo dei campi non sono inseriti nella chat o negli eventi globali. L’apertura automatica usa un helper con credenziale valida soltanto per la shell attiva; la vista e i controlli richiedono la sessione autenticata dell’app. Chiudere il pannello non chiude il browser né la CLI. Il browser condivide limiti di risorse e timeout di inattività con i browser delle chat.

C’è una sessione terminale condivisa: chiudere il pannello o perdere la connessione non ferma i comandi, e riaprendolo si recupera l’output recente. **Termina sessione** chiude esplicitamente la shell; un riavvio del server la termina e svuota l’output in memoria, conservando i file sul volume. Il terminale non è disponibile nella demo o con autonomia disabilitata. Comandi e output non vengono inseriti nelle chat; Bash conserva la sua normale cronologia nella home. “Nascondi il testo che scrivi” maschera il campo del telefono, non l’eventuale eco del programma o la cronologia della shell.

## Deploy Railway

Repository privata: `francescocirulli/personal-agent`. Il servizio usa il Dockerfile, una singola replica sempre attiva e un volume montato in `/data`. Nelle impostazioni Railway: Dockerfile `Dockerfile`, healthcheck `/healthz` con timeout 120 secondi, restart `ON_FAILURE` con cinque tentativi, regione Europa e sleep disabilitato. Non si usa il vecchio formato Config as Code, deprecato da Railway. L’endpoint `/healthz` controlla la disponibilità senza esporre dati applicativi. Le API mantengono autenticazione e controllo dell’origine.

Impostare `HOST=0.0.0.0`, `PORT=4310`, `DATA_DIR=/data`, `HOME=/data/home`, `AGENT_CODEX_HOME=/data/home/.codex`, `AGENT_UNRESTRICTED=true`, `DEMO_MODE=false`, `APP_ORIGIN` sul dominio HTTPS effettivo e una `APP_PASSWORD` lunga. Le chiavi audio, Claude e VAPID vanno nelle variabili private del servizio, mai in Git. Per il volume Railway usare `RAILWAY_RUN_UID=0`: l’entrypoint sistema i permessi dei file appartenenti a root e passa subito all’utente `node` prima di avviare app e agenti.

Il volume conserva SQLite, audio, workspace, MCP, skill, accessi delle CLI e installazioni manuali. Non aumentare le repliche con SQLite locale. Per migrare dal container locale, copiare il volume a server fermo, preservando `/data` come percorso; non includere database o credenziali nella repository. Sul nuovo dominio occorre accedere nuovamente alla PWA e riabilitare le notifiche sul telefono. Eventuali provider OAuth che registrano un redirect esatto possono richiedere un nuovo collegamento MCP.

## Immagini nelle chat

Nelle chat Claude Code e Codex il pulsante **Allega immagini** apre il selettore file; è possibile anche incollare un’immagine nel compositore dagli appunti. Sono consentite fino a quattro immagini PNG, JPEG, WebP o GIF, massimo 5 MB ciascuna e 40 megapixel. Prima dell’invio si vedono anteprima e pulsante di rimozione. Il testo è facoltativo: senza testo viene chiesto di descrivere le immagini. Un upload rifiutato conserva la bozza per riprovare; cambiare chat svuota gli allegati non inviati. Le registrazioni vocali si inviano separatamente.

Il server decodifica e normalizza le immagini in JPEG, corregge l’orientamento, elimina i metadati e riduce il lato massimo a 2048 pixel; trasparenze su fondo bianco, GIF limitate al primo fotogramma. Lo storico mostra la copia normalizzata, apribile a dimensione intera. Le immagini sono nel database persistente e accessibili soltanto dagli endpoint autenticati della relativa chat; eliminare la chat elimina anche gli allegati dal database.

Codex riceve file locali attraverso `--image`, anche su `exec resume`. Claude Code riceve blocchi immagine base64 tramite stdin `--input-format stream-json`, secondo il [formato di input multimodale documentato](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode). Il testo semplice mantiene il percorso precedente. I file temporanei del runner hanno permessi privati e sono rimossi al termine del turno, anche in caso di errore o interruzione; un arresto improvviso del processo può lasciarli in `DATA_DIR/image-runs`. Le immagini nei transcript nativi delle CLI seguono la conservazione delle rispettive CLI. Le prove automatiche usano CLI di test: non eseguono richieste sulle subscription reali. La lettura delle immagini richiede un modello con supporto visivo.
