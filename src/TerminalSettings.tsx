import { SettingsTabs, type SettingsTab } from './SettingsTabs';
import { TerminalBrowser } from './TerminalBrowser';
import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { X, Play, Square, Copy, Keyboard } from 'lucide-react';
import { api, type Chat } from './api';
import type { TerminalView } from '../server/terminal';

export default function TerminalSettings({
  chats,
  onClose,
  onTab,
}: {
  chats: Chat[];
  onClose(): void;
  onTab(tab: SettingsTab): void;
}) {
  const [browserUrl, setBrowserUrl] = useState<string | null>(null);
  const seenBrowserRequest = useRef(0);
  const seenBrowserSession = useRef<string | null>(null);
  const [view, setView] = useState<TerminalView>();
  const [workspace, setWorkspace] = useState('');
  const [pending, setPending] = useState(false),
    [connected, setConnected] = useState(false);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [line, setLine] = useState(''),
    [secret, setSecret] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const screen = useRef<HTMLDivElement>(null),
    terminal = useRef<Terminal | undefined>(undefined);
  const input = useRef<(data: string) => void>(() => {});
  const lineInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let disposed = false;
    api<TerminalView>('/terminal')
      .then((s) => {
        if (!disposed) setView(s);
      })
      .catch((e) => {
        if (!disposed) setError(e.message);
      });
    return () => {
      disposed = true;
    };
  }, []);
  useEffect(() => {
    if (!view?.enabled) return;
    let disposed = false;
    const timer = setInterval(() => {
      void api<TerminalView>('/terminal')
        .then((current) => {
          if (disposed) return;
          if (seenBrowserSession.current !== current.id) {
            seenBrowserSession.current = current.id;
            seenBrowserRequest.current = 0;
          }
          const requestId = current.browserRequestId || 0;
          if (requestId > seenBrowserRequest.current) {
            seenBrowserRequest.current = requestId;
            setBrowserUrl('');
          }
        })
        .catch(() => {});
    }, 1500);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [view?.enabled]);
  useEffect(() => {
    const id = view?.id;
    if (!id || !screen.current) return;
    let disposed = false,
      sending = false,
      broken = false,
      buffer = '';
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      scrollback: 2000,
      allowProposedApi: false,
      disableStdin: true,
      theme: {
        background: '#171717',
        foreground: '#ececec',
        cursor: '#ececec',
        selectionBackground: '#555555',
      },
    });
    terminal.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(
      new WebLinksAddon((_event, url) => {
        if (/^https?:\/\//i.test(url)) setBrowserUrl(url);
      }),
    );
    term.open(screen.current);
    async function drain() {
      if (sending || disposed || broken) return;
      sending = true;
      try {
        while (buffer && !disposed) {
          const data = buffer.slice(0, 4096);
          buffer = buffer.slice(4096);
          await api(`/terminal/${id}/input`, { data });
        }
      } catch {
        broken = true;
        buffer = '';
        if (!disposed) {
          setConnected(false);
          setError(
            'Invio interrotto. Controlla l’output prima di riprovare; il comando non viene reinviato automaticamente. Riapri il pannello per riconnetterti.',
          );
        }
      } finally {
        sending = false;
      }
    }
    input.current = (data) => {
      if (!broken && !disposed) {
        buffer += data;
        void drain();
      }
    };
    const typing = term.onData((data) => input.current(data));
    let resizeTimer: ReturnType<typeof setTimeout>;
    const resize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (disposed) return;
        fit.fit();
        void api(`/terminal/${id}/resize`, {
          cols: Math.max(20, Math.min(300, term.cols)),
          rows: Math.max(5, Math.min(100, term.rows)),
        }).catch(() => {});
      }, 100);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(screen.current);
    resize();
    const stream = new EventSource(`/api/terminal/${id}/events`);
    stream.onopen = () => {
      if (!disposed && !broken) {
        setConnected(true);
        setError('');
        term.options.disableStdin = false;
      }
    };
    stream.onerror = () => {
      term.options.disableStdin = true;
      if (!disposed) {
        setConnected(false);
        void api<TerminalView>('/terminal')
          .then((current) => {
            if (disposed) return;
            if (current.id !== id) {
              setView(current);
              setNotice('La sessione è cambiata o il server è stato riavviato.');
            } else if (!current.running) {
              stream.close();
              setView(current);
            }
          })
          .catch(() => {});
      }
    };
    stream.addEventListener('reset', () => {
      term.reset();
      if (!disposed) setNotice('Le righe più vecchie non sono più disponibili.');
    });
    stream.onmessage = (event) => {
      if (disposed) return;
      const message = JSON.parse(event.data);
      if (message.type === 'data') term.write(message.data);
      if (message.type === 'exit') {
        term.writeln(`\r\n[Sessione terminata: ${message.exitCode}]`);
        term.options.disableStdin = true;
        stream.close();
        setConnected(false);
        setView((v) => v && { ...v, running: false, exitCode: message.exitCode });
      }
    };
    return () => {
      disposed = true;
      input.current = () => {};
      clearTimeout(resizeTimer);
      stream.close();
      observer.disconnect();
      typing.dispose();
      term.dispose();
      terminal.current = undefined;
    };
  }, [view?.id]);
  async function action(fn: () => Promise<void>) {
    setPending(true);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }
  const canType = connected && view?.running && !pending;
  return (
    <div className="modal-backdrop terminal-backdrop">
      <section
        className="modal terminal-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="terminal-heading"
      >
        <button className="modal-close icon-button" aria-label="Chiudi terminale" onClick={onClose}>
          <X size={20} />
        </button>
        <h2 id="terminal-heading">Terminale</h2>
        {view?.enabled && (
          <button className="soft-button" onClick={() => setBrowserUrl('')}>
            Browser del terminale
          </button>
        )}
        {browserUrl !== null && (
          <TerminalBrowser initialUrl={browserUrl} onClose={() => setBrowserUrl(null)} />
        )}
        <SettingsTabs current="terminal" onTab={onTab} disabled={pending} />
        <p>
          Comandi nell’ambiente degli agenti. Puoi installare CLI, fare login e lavorare sui file.
        </p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="settings-note" role="status">
            {notice}
          </p>
        )}
        {!view && <p>Carico il terminale…</p>}
        {view && !view.enabled && (
          <p>Il terminale interattivo è disponibile nell’ambiente reale con autonomia abilitata.</p>
        )}
        {view?.enabled && (
          <>
            {!view.running && (
              <div className="terminal-start">
                <label>
                  Cartella iniziale
                  <select value={workspace} onChange={(e) => setWorkspace(e.target.value)}>
                    <option value="">Home condivisa · installazione CLI</option>
                    {chats
                      .filter((c) => c.workspace)
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.repo || 'Chat libera'} · {c.title}
                        </option>
                      ))}
                  </select>
                </label>
                <button
                  className="primary"
                  disabled={pending}
                  onClick={() =>
                    void action(async () => {
                      setConnected(false);
                      setView(
                        await api<TerminalView>('/terminal/start', {
                          conversationId: workspace || null,
                          cols: 80,
                          rows: 24,
                        }),
                      );
                    })
                  }
                >
                  <Play size={16} /> {view.id ? 'Nuova sessione' : 'Avvia terminale'}
                </button>
              </div>
            )}
            <div className="terminal-status" role="status">
              {view.running
                ? connected
                  ? 'Connesso'
                  : 'Connessione…'
                : view.id
                  ? 'Sessione terminata'
                  : 'Pronto ad avviare'}
              {view.id && <span> · Avviato in {view.cwd}</span>}
            </div>
            <div
              className="terminal-screen"
              ref={screen}
              aria-label="Output del terminale"
              hidden={!view.id}
            />
            {view.id && (
              <>
                <div className="terminal-keys" aria-label="Tasti terminale">
                  {(
                    [
                      ['Ctrl+C', '\u0003'],
                      ['Tab', '\t'],
                      ['↑', '\u001b[A'],
                      ['↓', '\u001b[B'],
                      ['←', '\u001b[D'],
                      ['→', '\u001b[C'],
                      ['Esc', '\u001b'],
                      ['Ctrl+D', '\u0004'],
                    ] as const
                  ).map(([label, value]) => (
                    <button
                      className="soft-button"
                      key={label}
                      disabled={!canType}
                      onClick={() => input.current(value)}
                    >
                      {label}
                    </button>
                  ))}
                  <button
                    className="soft-button"
                    disabled={!canType}
                    onClick={() => terminal.current?.focus()}
                  >
                    <Keyboard size={15} /> Tastiera
                  </button>
                </div>
                <form
                  className="terminal-line"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (canType) {
                      input.current(line + '\r');
                      setLine('');
                      lineInput.current?.focus();
                    }
                  }}
                >
                  <label htmlFor="terminal-command">Comando o risposta</label>
                  <div>
                    <input
                      ref={lineInput}
                      id="terminal-command"
                      type={secret ? 'password' : 'text'}
                      value={line}
                      onChange={(e) => setLine(e.target.value)}
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      maxLength={8192}
                      disabled={!canType}
                      placeholder="Scrivi qui e premi Invio"
                    />
                    <button className="primary" disabled={!canType}>
                      Invia
                    </button>
                  </div>
                  <label className="terminal-secret">
                    <input
                      type="checkbox"
                      checked={secret}
                      onChange={(e) => setSecret(e.target.checked)}
                    />{' '}
                    Nascondi il testo che scrivi
                  </label>
                </form>
                <div className="terminal-actions">
                  <button
                    className="soft-button"
                    onClick={() =>
                      void action(async () => {
                        const term = terminal.current;
                        if (!term) return;
                        const lines = Array.from(
                          { length: term.buffer.active.length },
                          (_, i) => term.buffer.active.getLine(i)?.translateToString(true) || '',
                        );
                        await navigator.clipboard.writeText(
                          term.getSelection() || lines.join('\n'),
                        );
                        setNotice('Output copiato.');
                      })
                    }
                  >
                    <Copy size={15} /> Copia output
                  </button>
                  {view.running && (
                    <button
                      className="soft-button"
                      disabled={pending}
                      onClick={() => setConfirmStop(true)}
                    >
                      <Square size={15} /> Termina sessione
                    </button>
                  )}
                </div>
                {confirmStop && view.running && (
                  <div className="terminal-confirm">
                    <p>Terminare la shell e interrompere il lavoro in questa sessione?</p>
                    <button
                      className="soft-button"
                      disabled={pending}
                      onClick={() =>
                        void action(async () => {
                          setView(await api(`/terminal/${view.id}/stop`, {}));
                          setConfirmStop(false);
                        })
                      }
                    >
                      Conferma chiusura
                    </button>
                    <button className="text-button" onClick={() => setConfirmStop(false)}>
                      Annulla
                    </button>
                  </div>
                )}
              </>
            )}
            <details className="terminal-help">
              <summary>Installare una CLI</summary>
              <p>Per esempio, Railway:</p>
              <code>npm install -g @railway/cli</code>
              <code>railway --version</code>
              <code>railway login</code>
              <p>
                I link si aprono nel browser integrato. Se la CLI non lo apre automaticamente, tocca
                il link nell’output o incollalo in Browser del terminale. Per il login dal browser
                del telefono usa <code>railway login --browserless</code>.
              </p>
              <p>
                Le installazioni npm globali sono salvate in <code>{view.toolsPrefix}</code> e
                disponibili anche agli agenti. I file nella home e nei progetti persistono. I
                pacchetti di sistema che richiedono root vanno aggiunti all’immagine del server.
              </p>
            </details>
            <p className="settings-note">
              Chiudere questo pannello lascia la sessione in esecuzione. Un riavvio del server
              termina la shell; i file sul volume restano salvati.
            </p>
          </>
        )}
      </section>
    </div>
  );
}
