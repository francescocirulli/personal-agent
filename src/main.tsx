import { DiffPanel } from './DiffPanel';
import { WorkStatus, StatusBadge, currentWork } from './WorkStatus';
import type { MarkdownDocument } from './markdown';
import { NotificationSettings } from './NotificationSettings';
import { notificationDeviceId, updateAppBadge } from './notifications';
import { BranchPicker } from './BranchPicker';
import { useDraft, deleteDraft } from './useDraft';
import { FileCards } from './FileCards';
import { QueuePanel } from './QueuePanel';
import { SearchResults } from './SearchResults';
import { ImageAttachments } from './ImageAttachments';
import { ModelPicker } from './ModelPicker';
import { AgentLogo } from './AgentLogo';
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatMarkdown } from './ChatMarkdown';
import {
  ArrowUp,
  Paperclip,
  AudioLines,
  Bell,
  Check,
  ChevronLeft,
  FolderGit2,
  FileDiff,
  GitFork,
  Headphones,
  LoaderCircle,
  Menu,
  MessageCircle,
  Mic,
  MicOff,
  Pause,
  Plus,
  Search,
  Volume2,
  X,
  MoreHorizontal,
  Pencil,
  Trash2,
  Settings as SettingsIcon,
} from 'lucide-react';
import {
  api,
  ApiError,
  busy,
  type Chat,
  type Detail,
  type Settings,
  type AudioSettings,
  type AudioCatalog,
} from './api';
import { HandsFree, Speaker, type PlaybackState } from './voice';
import './style.css';
import { RepositoryPicker } from './RepositoryPicker';
import { McpConnections } from './McpConnections';
import { SkillsSettings } from './SkillsSettings';
import { ChatToolsPicker } from './ChatToolsPicker';
import { ChatToolsPanel } from './ChatToolsPanel';
import type { ChatTools } from '../server/chat-tools';
const TerminalSettings = React.lazy(() => import('./TerminalSettings'));
import { BrowserPanel } from './BrowserPanel';

const agentName = (agent?: string) => (agent === 'codex' ? 'Codex' : 'Claude Code');
const MarkdownReader = React.lazy(() => import('./MarkdownReader'));
function App() {
  const [markdownDocument, setMarkdownDocument] = useState<MarkdownDocument>();
  const [activityOpen, setActivityOpen] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const [diffMode, setDiffMode] = useState<'local' | 'branch'>();
  const [workOnly, setWorkOnly] = useState(false);

  const [notificationsOpen, setNotificationsOpen] = useState(
    new URLSearchParams(location.search).get('settings') === 'notifications',
  );
  const [authenticated, setAuthenticated] = useState<boolean | null>(null),
    [password, setPassword] = useState('');
  const [settings, setSettings] = useState<Settings>(),
    [chats, setChats] = useState<Chat[]>([]),
    [detail, setDetail] = useState<Detail>();
  const [selected, setSelected] = useState<string | null>(
    new URLSearchParams(location.search).get('chat'),
  );
  const [sidebar, setSidebar] = useState(false),
    [create, setCreate] = useState(false),
    [agent, setAgent] = useState<'claude' | 'codex'>('claude'),
    [repo, setRepo] = useState('');
  const { draft, setDraft, images, setImages, draftReady, draftError } = useDraft(selected);
  const [targetMessage, setTargetMessage] = useState<string | null>(
    new URLSearchParams(location.search).get('message'),
  );
  const jumpPending = useRef(!!new URLSearchParams(location.search).get('message'));
  const [forking, setForking] = useState<string | null>(null);
  const [sendingNow, setSendingNow] = useState<string | null>(null);
  const sendPending = useRef(false);
  const imageInput = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState(''),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [sending, setSending] = useState(false),
    [creating, setCreating] = useState(false);
  const [repoRequired, setRepoRequired] = useState(false);
  const [chatTools, setChatTools] = useState<ChatTools>({ mcp: null, skills: null });
  useEffect(() => {
    if (create) setChatTools({ mcp: null, skills: null });
  }, [create]);
  const [chatMenu, setChatMenu] = useState<Chat | null>(null),
    [chatAction, setChatAction] = useState<'rename' | 'delete' | null>(null),
    [chatTitle, setChatTitle] = useState(''),
    [actionPending, setActionPending] = useState(false),
    [actionError, setActionError] = useState('');
  const [preferencesTab, setPreferencesTab] = useState<'voice' | 'mcp' | 'skills' | 'terminal'>(
    new URLSearchParams(location.search).get('settings') === 'terminal'
      ? 'terminal'
      : new URLSearchParams(location.search).get('settings') === 'skills'
        ? 'skills'
        : new URLSearchParams(location.search).get('settings') === 'mcp'
          ? 'mcp'
          : 'voice',
  );
  const [preferencesOpen, setPreferencesOpen] = useState(
      ['mcp', 'skills', 'terminal'].includes(
        new URLSearchParams(location.search).get('settings') || '',
      ),
    ),
    [audioPreferences, setAudioPreferences] = useState<AudioSettings>(),
    [audioCatalog, setAudioCatalog] = useState<AudioCatalog>(),
    [preferencesError, setPreferencesError] = useState(''),
    [preferencesPending, setPreferencesPending] = useState(false);
  const [connected, setConnected] = useState(false),
    [preview, setPreview] = useState('');
  const [voiceChat, setVoiceChat] = useState<string | null>(null),
    [muted, setMuted] = useState(false),
    [level, setLevel] = useState(0),
    [speaking, setSpeaking] = useState(false);
  const mutedRef = useRef(false);
  const [microphoneReady, setMicrophoneReady] = useState(false);
  const [playState, setPlayState] = useState<PlaybackState>('idle'),
    [playingId, setPlayingId] = useState<string | null>(null);
  const speaker = useRef<Speaker | null>(null);
  if (!speaker.current) speaker.current = new Speaker(setPlayState);
  const capture = useRef<HandsFree | null>(null),
    selection = useRef(selected),
    voiceSelection = useRef(voiceChat),
    config = useRef(settings),
    detailRef = useRef(detail),
    bottom = useRef<HTMLDivElement>(null);
  selection.current = selected;
  voiceSelection.current = voiceChat;
  config.current = settings;
  detailRef.current = detail;
  useEffect(() => setDiffOpen(false), [selected]);
  const current = detail?.id === selected ? detail : undefined;
  const run = current ? currentWork(current.runs) : undefined,
    working = busy(run?.status) || sending;
  const workingRef = useRef(working);
  workingRef.current = working;
  const refreshSequence = useRef(0);
  const clientId = useRef(crypto.randomUUID());
  async function refresh(id = selection.current) {
    if (document.hidden) return;
    const sequence = ++refreshSequence.current;
    const list = await api<Chat[]>('/conversations');
    if (document.hidden) return;
    const exists = id && list.some((c) => c.id === id);
    const chat = exists
      ? await api<Detail>(`/conversations/${id}`).catch((e) => {
          // A deletion from another device can race the list request.
          if (e instanceof ApiError && e.status === 404) return undefined;
          throw e;
        })
      : undefined;
    if (sequence !== refreshSequence.current) return;
    setChats(list);
    if (id === selection.current) {
      setDetail(chat);
      if (id && !chat) clearSelection();
    }
  }
  function clearSelection() {
    stopVoice();
    selection.current = null;
    setSelected(null);
    setDetail(undefined);
    setTargetMessage(null);
    setPreview('');
    history.replaceState({}, '', '/');
  }
  function openChatMenu(chat: Chat) {
    setChatMenu(chat);
    setChatAction(null);
    setChatTitle(chat.title);
    setActionError('');
  }
  async function manageChat(e: React.FormEvent) {
    e.preventDefault();
    if (!chatMenu || !chatAction || actionPending) return;
    setActionPending(true);
    setActionError('');
    try {
      await api(
        `/conversations/${chatMenu.id}/${chatAction}`,
        chatAction === 'rename' ? { title: chatTitle } : {},
      );
      if (chatAction === 'delete') {
        await deleteDraft(chatMenu.id).catch(() => {});
        if (selection.current === chatMenu.id) clearSelection();
      }
      setChatMenu(null);
      await refresh();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setActionPending(false);
    }
  }
  async function openPreferences(tab: 'voice' | 'mcp' | 'skills' | 'terminal' = 'voice') {
    stopVoice();
    setSidebar(false);
    setPreferencesOpen(true);
    setPreferencesTab(tab);
    if (tab !== 'voice') return;
    setPreferencesError('');
    setAudioPreferences(undefined);
    setAudioCatalog(undefined);
    try {
      setAudioPreferences(await api<AudioSettings>('/settings/audio'));
    } catch (e) {
      setPreferencesError((e as Error).message);
      return;
    }
    try {
      setAudioCatalog(await api<AudioCatalog>('/settings/audio/models'));
    } catch {
      setPreferencesError(
        'Catalogo non disponibile. Puoi modificare la voce del modello attuale o riprovare riaprendo le impostazioni.',
      );
    }
  }
  async function savePreferences(e: React.FormEvent) {
    e.preventDefault();
    if (!audioPreferences || preferencesPending) return;
    setPreferencesPending(true);
    setPreferencesError('');
    try {
      const { sttModel, ttsModel, voice } = audioPreferences;
      await api('/settings/audio', { sttModel, ttsModel, voice });
      setPreferencesOpen(false);
      setNotice('Impostazioni voce salvate. Si applicano ai prossimi ascolti e messaggi vocali.');
    } catch (e) {
      setPreferencesError((e as Error).message);
    } finally {
      setPreferencesPending(false);
    }
  }
  function stopVoice() {
    setMicrophoneReady(false);
    voiceSelection.current = null;
    setVoiceChat(null);
    capture.current?.stop();
    capture.current = null;
    speaker.current?.stop();
    setLevel(0);
    setSpeaking(false);
  }
  function choose(id: string) {
    stopVoice();
    selection.current = id;
    setSelected(id);
    setSidebar(false);
    setPreview('');
    setTargetMessage(null);
    jumpPending.current = false;
    setError('');
    history.replaceState({}, '', `/?chat=${id}`);
  }
  async function playMessage(chatId: string, messageId: string, automatic = false) {
    if (!automatic) {
      if (playingId === messageId && playState === 'playing') {
        await speaker.current!.pause();
        return;
      }
      if (playingId === messageId && playState === 'paused') {
        try {
          await speaker.current!.resume();
        } catch (e) {
          setError((e as Error).message);
        }
        return;
      }
      if (playingId === messageId && playState === 'loading') {
        speaker.current!.stop();
        setPlayingId(null);
        return;
      }
      stopVoice();
    }
    setPlayingId(messageId);
    try {
      if (!config.current?.voiceAvailable)
        throw new Error('Voce non configurata: aggiungi la chiave OpenRouter sul server.');
      await speaker.current!.play(`/api/conversations/${chatId}/messages/${messageId}/audio`);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    api<{ authenticated: boolean }>('/auth')
      .then((r) => setAuthenticated(r.authenticated))
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (!authenticated || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
    let disposed = false;
    void navigator.serviceWorker.ready
      .then(async (registration) => {
        const subscription = await registration.pushManager.getSubscription();
        if (!disposed && subscription)
          await api('/push/device', {
            endpoint: subscription.endpoint,
            deviceId: notificationDeviceId(),
          });
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [authenticated]);
  useEffect(() => {
    if (!authenticated) return;
    api<Settings>('/config')
      .then(setSettings)
      .catch((e) => setError(e.message));
    const stream = new EventSource('/api/events');
    stream.onopen = () => setConnected(true);
    stream.onerror = () => setConnected(false);
    stream.addEventListener('sync', () => {
      void refresh().catch((e) => setError(e.message));
      window.dispatchEvent(new Event('chat-tools-change'));
    });
    stream.onmessage = (event) => {
      const e = JSON.parse(event.data);
      if (
        e.conversationId === selection.current &&
        ['changed', 'done', 'run_error', 'started'].includes(e.type)
      ) {
        window.dispatchEvent(new Event('git-change'));
        window.dispatchEvent(new Event('chat-tools-change'));
      }
      if (e.type === 'browser_changed') {
        window.dispatchEvent(new Event('browser-change'));
        return;
      }
      if (e.type === 'mcp_changed') {
        window.dispatchEvent(new Event('mcp-change'));
        return;
      }
      if (e.type === 'skills_changed') {
        window.dispatchEvent(new Event('skills-change'));
        return;
      }
      if (e.type === 'deleted') {
        if (e.conversationId === selection.current) clearSelection();
        setChatMenu((menu) => (menu?.id === e.conversationId ? null : menu));
      }
      if (e.type === 'agent_text') {
        if (e.conversationId === selection.current) setPreview(e.text);
        return;
      }
      void refresh().catch((err) => setError(err.message));
      if (e.type === 'done' || e.type === 'run_error') {
        if (e.conversationId === selection.current) setPreview('');
        if (e.conversationId !== selection.current && !e.cancelled && !e.replayed)
          setNotice(
            e.type === 'done'
              ? 'Una chat ha una nuova risposta. La trovi nello storico.'
              : 'Un lavoro non è stato completato. Apri la chat per i dettagli.',
          );
      }
      if (
        e.replayed ||
        e.conversationId !== voiceSelection.current ||
        document.hidden ||
        !config.current?.voiceAvailable
      )
        return;
      if (e.type === 'done') {
        void playMessage(e.conversationId, e.messageId, true);
      }
      // Tool/preparation status is text-only: avoid narrating routine machinery.
    };
    return () => stream.close();
  }, [authenticated]);
  useEffect(() => {
    if (!create) {
      setRepo('');
      setRepoRequired(false);
    }
  }, [create]);
  useEffect(() => {
    if (authenticated) void refresh(selected).catch((e) => setError(e.message));
  }, [selected, authenticated]);
  useEffect(() => {
    if (!authenticated) return;
    const report = () => {
      void api(
        '/presence',
        {
          clientId: clientId.current,
          deviceId: notificationDeviceId(),
          conversationId: selected,
          visible:
            !document.hidden &&
            document.hasFocus() &&
            !notificationsOpen &&
            !preferencesOpen &&
            !sidebar &&
            !markdownDocument &&
            !create &&
            !chatMenu,
        },
        true,
      ).catch(() => {});
    };
    report();
    const timer = setInterval(report, 15000);
    document.addEventListener('visibilitychange', report);
    window.addEventListener('focus', report);
    window.addEventListener('blur', report);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', report);
      window.removeEventListener('focus', report);
      window.removeEventListener('blur', report);
    };
  }, [
    selected,
    authenticated,
    notificationsOpen,
    preferencesOpen,
    sidebar,
    create,
    chatMenu,
    markdownDocument,
  ]);
  const lastResponseId = current?.messages
    .filter((message) => message.role === 'assistant')
    .at(-1)?.id;
  useEffect(() => {
    const markRead = () => {
      if (
        !current ||
        !lastResponseId ||
        document.hidden ||
        !document.hasFocus() ||
        notificationsOpen ||
        preferencesOpen ||
        sidebar ||
        markdownDocument ||
        create ||
        chatMenu
      )
        return;
      void api<{ unreadCount: number }>(`/conversations/${current.id}/read`, {
        messageId: lastResponseId,
      })
        .then(({ unreadCount }) => updateAppBadge(unreadCount))
        .catch(() => {});
    };
    markRead();
    window.addEventListener('focus', markRead);
    document.addEventListener('visibilitychange', markRead);
    return () => {
      window.removeEventListener('focus', markRead);
      document.removeEventListener('visibilitychange', markRead);
    };
  }, [
    current?.id,
    lastResponseId,
    markdownDocument,
    notificationsOpen,
    preferencesOpen,
    sidebar,
    connected,
    create,
    chatMenu,
  ]);
  useEffect(() => {
    updateAppBadge(chats.reduce((sum, chat) => sum + (chat.unread_count || 0), 0));
  }, [chats]);
  useEffect(() => {
    setActivityOpen(false);
  }, [selected]);
  useEffect(() => {
    if (!jumpPending.current && !markdownDocument && !activityOpen)
      bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [current?.messages.length, preview]);
  useEffect(() => {
    if (
      !jumpPending.current ||
      !targetMessage ||
      !current?.messages.some((m) => m.id === targetMessage)
    )
      return;
    const timer = setTimeout(() => {
      document
        .getElementById(`message-${targetMessage}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      jumpPending.current = false;
    }, 100);
    return () => clearTimeout(timer);
  }, [targetMessage, current?.id, current?.messages.length]);
  useEffect(() => {
    const visibility = () => {
      if (document.hidden) stopVoice();
      else if (authenticated) void refresh().catch((e) => setError(e.message));
    };
    document.addEventListener('visibilitychange', visibility);
    return () => document.removeEventListener('visibilitychange', visibility);
  }, [authenticated]);
  useEffect(() => {
    capture.current?.setEnabled(!!voiceChat && !muted && !working && playState === 'idle');
  }, [voiceChat, muted, working, playState]);
  useEffect(() => {
    if (notice) {
      const timer = setTimeout(() => setNotice(''), 6000);
      return () => clearTimeout(timer);
    }
  }, [notice]);
  async function newChat(event: React.FormEvent) {
    event.preventDefault();
    if (repoRequired && !repo.trim()) return;
    setError('');
    setCreating(true);
    try {
      const chat = await api<Chat>('/conversations', {
        agent,
        repo: repo.trim() || null,
        tools: chatTools,
      });
      setCreate(false);
      setRepo('');
      choose(chat.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  }
  function openMarkdown(document: MarkdownDocument) {
    stopVoice();
    setMarkdownDocument(document);
  }
  async function askAboutMarkdown(content: string) {
    const doc = markdownDocument;
    if (!doc || !current || !draftReady || sendPending.current)
      throw new Error('Attendi che la chat sia pronta e riprova.');
    if (doc.chatId && doc.chatId !== current.id)
      throw new Error('Riapri il documento dalla sua chat.');
    if (!doc.attachmentId) {
      if (images.length >= 4)
        throw new Error(
          'La bozza contiene già 4 allegati. Rimuovine uno prima di aggiungere questo file.',
        );
      setImages((previous) => [
        ...previous,
        new File([content], doc.name, { type: 'text/markdown' }),
      ]);
    }
    const reference = doc.attachmentId
      ? `Riferimento: file "${doc.name}" (allegato ${doc.attachmentId}).`
      : `Riferimento: file allegato "${doc.name}".`;
    setDraft(draft ? `${draft}\n\n${reference}\n` : `${reference}\n\n`);
    setPreferencesOpen(false);
    setMarkdownDocument(undefined);
    const url = new URL(location.href);
    url.searchParams.delete('settings');
    history.replaceState({}, '', url.pathname + url.search);
    requestAnimationFrame(() =>
      window.document
        .querySelector<HTMLTextAreaElement>('textarea[aria-label="Messaggio"]')
        ?.focus(),
    );
  }
  function addImages(files: File[]) {
    if (sendPending.current) return;
    if (
      files.some((file) => {
        const isImage = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type);
        return isImage
          ? file.size > 5 * 1024 * 1024
          : !/\.(pdf|docx|xlsx|csv|txt|md|json)$/i.test(file.name) || file.size > 20 * 1024 * 1024;
      })
    ) {
      setError(
        'Usa immagini fino a 5 MB o PDF, DOCX, XLSX, CSV, TXT, Markdown e JSON fino a 20 MB.',
      );
      return;
    }
    if (images.length + files.length > 4) {
      setError('Puoi allegare al massimo 4 file.');
      return;
    }
    setImages((previous) => [...previous, ...files]);
    setError('');
  }
  async function send(text?: string, blob?: Blob, chatId = selection.current) {
    if (!chatId || sendPending.current || (!blob && !draftReady) || (blob && workingRef.current))
      return;
    sendPending.current = true;
    setSending(true);
    workingRef.current = true;
    capture.current?.setEnabled(false);
    setError('');
    try {
      let body: unknown = { text };
      if (blob) {
        const form = new FormData();
        form.append('audio', blob, blob.type.includes('mp4') ? 'speech.m4a' : 'speech.webm');
        body = form;
      }
      if (!blob && images.length) {
        const form = new FormData();
        form.append('text', text || '');
        for (const image of images)
          form.append(image.type.startsWith('image/') ? 'images' : 'files', image, image.name);
        body = form;
      }
      await api(`/conversations/${chatId}/turns`, body);
      if (!blob)
        await deleteDraft(chatId).catch(() =>
          setError('Messaggio inviato, ma non è stato possibile eliminare la bozza locale.'),
        );
      if (!blob && selection.current === chatId) {
        setDraft('');
        setImages([]);
      }
      await refresh(chatId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      sendPending.current = false;
      setSending(false);
    }
  }
  async function sendNow(runId: string) {
    if (!selected || sendingNow) return;
    const chatId = selected;
    setSendingNow(runId);
    setError('');
    try {
      await api(`/conversations/${chatId}/queue/${runId}/send-now`, {});
      await refresh(chatId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSendingNow(null);
    }
  }
  async function forkChat(messageId: string) {
    if (!selected || forking) return;
    setForking(messageId);
    setError('');
    try {
      const chat = await api<Chat>(`/conversations/${selected}/messages/${messageId}/fork`, {});
      choose(chat.id);
      await refresh(chat.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setForking(null);
    }
  }
  async function startVoice() {
    if (!selected) return;
    setError('');
    setMuted(false);
    mutedRef.current = false;
    setMicrophoneReady(false);
    setVoiceChat(selected);
    voiceSelection.current = selected;
    if (!settings?.voiceAvailable) return;
    const id = selected;
    const mic = new HandsFree(
      (blob) => {
        if (voiceSelection.current === id && !mutedRef.current) void send(undefined, blob, id);
      },
      (value, active) => {
        setLevel(value);
        setSpeaking(active);
      },
      (message) => {
        setError(message);
        stopVoice();
      },
    );
    capture.current = mic;
    try {
      // Both calls begin in the tap handler. Playback priming is best-effort:
      // a blocked or pending play() must not prevent microphone permission.
      void speaker.current!.unlock().catch((e) => console.warn('Audio priming failed', e));
      await mic.start();
      if (capture.current !== mic || voiceSelection.current !== id) {
        mic.stop();
        return;
      }
      mic.setEnabled(!mutedRef.current && !workingRef.current && speaker.current!.state === 'idle');
      setMicrophoneReady(true);
    } catch (e) {
      if (capture.current !== mic) return;
      console.warn('Voice initialization failed', e);
      setError((e as Error).message || 'Non riesco ad avviare la voce. Chiudi e riapri l’app.');
      stopVoice();
    }
  }
  function toggleMicrophone() {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    capture.current?.setEnabled(!next && !workingRef.current && speaker.current!.state === 'idle');
    if (next) {
      setLevel(0);
      setSpeaking(false);
    }
  }
  function openNotifications() {
    stopVoice();
    setSidebar(false);
    setPreferencesOpen(false);
    setNotificationsOpen(true);
  }
  const activeCount = chats.filter((c) => busy(c.status)).length;
  const chatGroups = new Map<string, Chat[]>();
  for (const chat of chats.filter(
    (c) =>
      `${c.title} ${c.repo || ''}`.toLowerCase().includes(search.toLowerCase()) &&
      (!workOnly ||
        (!!c.status &&
          ['running', 'transcribing', 'queued', 'awaiting_input', 'error', 'interrupted'].includes(
            c.status,
          ))),
  )) {
    const key = chat.repo?.toLowerCase() || '';
    chatGroups.set(key, [...(chatGroups.get(key) || []), chat]);
  }
  if (authenticated === null)
    return (
      <main className="login">
        <AudioLines size={40} />
        <p>{error || 'Apro il tuo spazio…'}</p>
      </main>
    );
  if (!authenticated)
    return (
      <main className="login">
        <div className="brand-icon">
          <AudioLines />
        </div>
        <h1>Il tuo spazio, ovunque.</h1>
        <p>Accedi a Personal Agent per continuare.</p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api('/login', { password });
              setPassword('');
              setAuthenticated(true);
              setError('');
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          <label htmlFor="password">Password personale</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
          <button className="primary">Accedi</button>
        </form>
        {error && <p role="alert">{error}</p>}
      </main>
    );
  return (
    <div className="app-shell">
      {sidebar && (
        <button className="scrim" aria-label="Chiudi menu" onClick={() => setSidebar(false)} />
      )}
      <aside
        id="chat-sidebar"
        className={`sidebar ${sidebar ? 'open' : ''}`}
        aria-label="Conversazioni"
      >
        <button
          className="icon-button sidebar-close"
          aria-label="Chiudi storico"
          onClick={() => setSidebar(false)}
        >
          <X size={20} />
        </button>
        <a
          className="brand"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            stopVoice();
            setSelected(null);
            selection.current = null;
            history.replaceState({}, '', '/');
            setSidebar(false);
          }}
        >
          <span className="brand-icon">
            <AudioLines size={22} />
          </span>
          <span>
            personal<span className="brand-light">agent</span>
          </span>
        </a>
        <button
          className="new-chat"
          onClick={() => {
            setCreate(true);
            setSidebar(false);
          }}
        >
          <Plus size={18} /> Nuova chat
        </button>
        <label className="search">
          <Search size={15} />
          <input
            aria-label="Cerca nelle chat"
            placeholder="Cerca chat o messaggi"
            maxLength={200}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="work-filter"
          aria-pressed={workOnly}
          onClick={() => setWorkOnly(!workOnly)}
        >
          {workOnly ? 'Mostra tutte le chat' : 'Lavori in corso e da seguire'}
        </button>
        <div className="section-label">
          CONVERSAZIONI <span>{chats.length}</span>
        </div>
        <nav className="chat-list" aria-label="Storico chat">
          {!!search.trim() && (
            <SearchResults
              query={search}
              onSelect={(chatId, messageId) => {
                choose(chatId);
                setTargetMessage(messageId);
                jumpPending.current = true;
                history.replaceState({}, '', `/?chat=${chatId}&message=${messageId}`);
              }}
            />
          )}
          {[...chatGroups.entries()].map(([project, items]) => (
            <details className="chat-group" key={project} open>
              <summary title={project || 'Chat libere'}>
                {project ? <FolderGit2 size={15} /> : <MessageCircle size={15} />}
                <span>{project || 'Chat libere'}</span>
                <small>{items.length}</small>
              </summary>
              <section aria-label={project || 'Chat libere'}>
                {items.map((c) => (
                  <div className={`chat-row ${selected === c.id ? 'active' : ''}`} key={c.id}>
                    <button
                      className={`chat-link ${selected === c.id ? 'active' : ''}`}
                      aria-current={selected === c.id ? 'page' : undefined}
                      aria-label={`${c.title} ${agentName(c.agent)}`}
                      aria-describedby={c.status ? `work-${c.id}` : undefined}
                      onClick={() => choose(c.id)}
                    >
                      <span>
                        <strong>{c.title}</strong>
                        <small>{agentName(c.agent)}</small>
                        <StatusBadge
                          id={`work-${c.id}`}
                          status={c.status}
                          paused={!!c.queue_paused}
                        />
                      </span>
                      {!!c.unread_count && (
                        <span
                          className="unread-dot"
                          role="img"
                          aria-label={
                            c.unread_count === 1
                              ? 'Una risposta non letta'
                              : `${c.unread_count} risposte non lette`
                          }
                        />
                      )}
                    </button>
                    <button
                      className="icon-button chat-menu-button"
                      aria-label={`Menu chat: ${c.title}`}
                      onClick={() => openChatMenu(c)}
                    >
                      <MoreHorizontal size={18} />
                    </button>
                  </div>
                ))}
              </section>
            </details>
          ))}
          {!!chats.length && !chatGroups.size && (
            <p className="sidebar-empty">Nessuna chat trovata.</p>
          )}
          {!chats.length && (
            <p className="sidebar-empty">
              Le tue conversazioni saranno qui.
              <br />
              Riprendile quando vuoi.
            </p>
          )}
        </nav>
        <div className="sidebar-footer">
          <div className="connection">
            <span className={`status-dot ${connected ? '' : 'offline'}`} />
            {connected
              ? activeCount
                ? `${activeCount} task in corso`
                : 'Connesso'
              : 'Riconnessione in corso…'}
          </div>
          <button className="quiet" onClick={openNotifications}>
            <Bell size={16} /> Notifiche
          </button>
          <button className="quiet" onClick={() => void openPreferences()}>
            <SettingsIcon size={16} /> Impostazioni
          </button>
          <div className="profile">
            <span className="avatar">TU</span>
            <span>
              Spazio personale<small>Claude Code · Codex</small>
            </span>
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <button
            className="icon-button mobile-menu"
            aria-label="Apri menu"
            aria-expanded={sidebar}
            aria-controls="chat-sidebar"
            onClick={() => setSidebar(true)}
          >
            <Menu size={21} />
          </button>
          <div className="breadcrumb">
            <span>Personal Agent</span>
            {current && (
              <>
                <span className="slash">/</span>
                <strong>{current.repo?.split('/')[1] || 'Chat libera'}</strong>
              </>
            )}
          </div>
          <div className="top-actions">
            {current && (
              <BrowserPanel key={current.id} conversationId={current.id} beforeOpen={stopVoice} />
            )}
            {current && (
              <button
                className="icon-button"
                aria-label="Menu della chat"
                onClick={() => openChatMenu(current)}
              >
                <MoreHorizontal size={20} />
              </button>
            )}
            {settings?.demo && <span className="demo-label">Dimostrazione</span>}
            <span className="private-label">
              <span className="status-dot" /> Personale
            </span>
            <button className="icon-button" aria-label="Nuova chat" onClick={() => setCreate(true)}>
              <Plus size={20} />
            </button>
          </div>
        </header>
        {error && (
          <div className="banner error" role="alert">
            <span>{error}</span>
            <button aria-label="Chiudi errore" onClick={() => setError('')}>
              <X size={16} />
            </button>
          </div>
        )}
        {notice && (
          <div className="banner notice" role="status">
            <span>{notice}</span>
            <button aria-label="Chiudi avviso" onClick={() => setNotice('')}>
              <X size={16} />
            </button>
          </div>
        )}
        <McpConnections
          showSummary={!selected}
          open={preferencesOpen && preferencesTab === 'mcp'}
          onOpen={() => void openPreferences('mcp')}
          onClose={() => setPreferencesOpen(false)}
          onVoiceSettings={() => void openPreferences('voice')}
          onSkillsSettings={() => void openPreferences('skills')}
          onTerminalSettings={() => void openPreferences('terminal')}
          beforeOpen={stopVoice}
        />
        {current && !preferencesOpen && (
          <ChatToolsPanel
            key={current.id}
            chat={current}
            beforeOpen={stopVoice}
            onGlobalSettings={(tab) => void openPreferences(tab)}
          />
        )}
        {!selected ? (
          <section className="welcome">
            <div className="eyebrow">
              <span className="little-line" /> PERSONAL AGENT
            </div>
            <h1>Su cosa lavoriamo?</h1>
            <p>Scegli Claude Code o Codex. Scrivi, parla o apri un repository.</p>
            <button className="primary start-button" onClick={() => setCreate(true)}>
              <Plus size={18} /> Inizia una conversazione
            </button>
            <div className="welcome-cards">
              <div>
                <MessageCircle size={22} />
                <h3>Chat libera</h3>
                <p>Domande, ricerche e appunti, senza un repository.</p>
              </div>
              <div>
                <FolderGit2 size={22} />
                <h3>Repository</h3>
                <p>Lavora sui tuoi progetti GitHub direttamente dalla chat.</p>
              </div>
              <div>
                <Headphones size={22} />
                <h3>Voce</h3>
                <p>Detta un messaggio e ascolta le risposte.</p>
              </div>
            </div>
            <div className="welcome-note">
              <AudioLines size={16} /> Il lavoro continua anche quando chiudi l’app.
            </div>
          </section>
        ) : !current ? (
          <section className="loading">
            <LoaderCircle className="spin" /> Apro la conversazione…
          </section>
        ) : (
          <>
            <div className="chat-toolbar">
              <h1 className="chat-title" title={current.title}>
                {current.title === 'Nuova conversazione' ? 'Da dove cominciamo?' : current.title}
              </h1>
              <ModelPicker key={current.id} chat={current} onSaved={() => refresh(current.id)} />
            </div>
            <div className="messages" aria-live="polite">
              {!current.messages.length && !working && (
                <div className="empty-chat">
                  <div className="empty-orb">
                    <AudioLines size={34} />
                  </div>
                  <h2>Scrivi il primo messaggio</h2>
                  <p>Puoi allegare file o usare la voce.</p>
                  <button className="soft-button" disabled={!settings} onClick={startVoice}>
                    <AudioLines size={17} /> Usa la voce
                  </button>
                </div>
              )}
              {current.messages.map((message) => (
                <article
                  id={`message-${message.id}`}
                  className={`message ${message.role} ${targetMessage === message.id ? 'search-highlight' : ''}`}
                  key={message.id}
                >
                  <div className="message-author">
                    {message.role === 'user' ? (
                      <span className="mini-avatar">TU</span>
                    ) : (
                      <AgentLogo agent={current.agent} />
                    )}
                    <strong>{message.role === 'user' ? 'Tu' : agentName(current.agent)}</strong>
                    <time>
                      {new Date(message.created_at).toLocaleTimeString('it-IT', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </time>
                  </div>
                  {!!message.attachments?.length && (
                    <div className="image-attachments">
                      {message.attachments
                        .filter((file) => file.mime === 'image/jpeg')
                        .map((image) => (
                          <a
                            key={image.id}
                            href={`/api/conversations/${current.id}/images/${image.id}`}
                            target="_blank"
                            rel="noreferrer"
                            aria-label={`Apri immagine ${image.name}`}
                          >
                            <img
                              src={`/api/conversations/${current.id}/images/${image.id}`}
                              alt={image.name}
                              loading="lazy"
                            />
                          </a>
                        ))}
                    </div>
                  )}
                  <FileCards
                    chatId={current.id}
                    onRead={openMarkdown}
                    files={(message.attachments || []).filter((file) => file.mime !== 'image/jpeg')}
                  />
                  <div className="message-body">
                    <ChatMarkdown text={message.text} />
                  </div>
                  {message.role === 'assistant' && (
                    <div className="message-actions">
                      <button
                        className={`listen ${playingId === message.id && playState !== 'idle' ? 'listening' : ''}`}
                        onClick={() => void playMessage(current.id, message.id)}
                      >
                        {playingId === message.id && playState === 'loading' ? (
                          <LoaderCircle size={14} className="spin" />
                        ) : playingId === message.id && playState === 'playing' ? (
                          <Pause size={13} />
                        ) : (
                          <Volume2 size={15} />
                        )}{' '}
                        {playingId === message.id && playState === 'playing'
                          ? 'Pausa'
                          : playingId === message.id && playState === 'paused'
                            ? 'Riprendi'
                            : playingId === message.id && playState === 'loading'
                              ? 'Annulla audio'
                              : 'Ascolta'}
                      </button>
                      <button
                        className="listen"
                        aria-label="Fork da questo messaggio"
                        title="Crea una nuova chat fino a questa risposta"
                        disabled={!!forking}
                        onClick={() => void forkChat(message.id)}
                      >
                        {forking === message.id ? (
                          <LoaderCircle size={15} className="spin" />
                        ) : (
                          <GitFork size={15} />
                        )}
                        Fork
                      </button>
                    </div>
                  )}
                </article>
              ))}
              <WorkStatus
                key={current.id}
                chat={current}
                connected={connected}
                sending={sending}
                preview={preview}
                activityOpen={activityOpen}
                onActivityOpenChange={setActivityOpen}
                onStop={() =>
                  api(`/conversations/${current.id}/cancel`, {}).catch((e) => setError(e.message))
                }
                onChanges={(mode) => {
                  stopVoice();
                  setDiffMode(mode);
                  setDiffOpen(true);
                }}
              />
              <div ref={bottom} />
            </div>
            <DiffPanel
              key={current.id}
              chat={current}
              open={diffOpen}
              initialMode={diffMode}
              onClose={() => setDiffOpen(false)}
              running={working}
            />
            <div className="composer-area">
              <QueuePanel
                chat={current}
                refresh={() => refresh(current.id)}
                sendNow={sendNow}
                sendingNow={sendingNow}
                onError={setError}
              />
              {draftError && <p role="alert">{draftError}</p>}
              <form
                className="composer"
                onPaste={(e) => {
                  const pasted = Array.from(e.clipboardData.files);
                  if (pasted.length) {
                    e.preventDefault();
                    addImages(pasted);
                  }
                }}
                onSubmit={(e) => {
                  e.preventDefault();
                  if (draft.trim() || images.length) void send(draft);
                }}
              >
                {images.length > 0 && (
                  <ImageAttachments
                    files={images}
                    disabled={sending || !draftReady}
                    onRemove={(index) => setImages((files) => files.filter((_, i) => i !== index))}
                  />
                )}
                <input
                  ref={imageInput}
                  type="file"
                  hidden
                  multiple
                  accept="image/png,image/jpeg,image/webp,image/gif,.pdf,.docx,.xlsx,.csv,.txt,.md,.json"
                  aria-label="Seleziona allegati"
                  disabled={sending || !draftReady}
                  onChange={(e) => {
                    addImages(Array.from(e.target.files || []));
                    e.target.value = '';
                  }}
                />
                <textarea
                  aria-label="Messaggio"
                  placeholder={
                    run?.status === 'awaiting_input'
                      ? 'Rispondi per proseguire…'
                      : working
                        ? 'Aggiungi un messaggio alla coda…'
                        : 'Scrivi un messaggio…'
                  }
                  value={draft}
                  disabled={sending || !draftReady}
                  maxLength={40000}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      if ((draft.trim() || images.length) && !sending) void send(draft);
                    }
                  }}
                />
                <div className="composer-bottom">
                  <BranchPicker
                    key={current.id}
                    chat={current}
                    running={working}
                    onSaved={() => refresh(current.id)}
                  />
                  <button
                    type="button"
                    className="diff-open"
                    aria-label="Modifiche della chat"
                    onClick={() => {
                      stopVoice();
                      setDiffMode(undefined);
                      setDiffOpen(true);
                    }}
                  >
                    <FileDiff size={17} />
                    <span>Modifiche</span>
                  </button>
                  <div>
                    <button
                      type="button"
                      className="voice-button"
                      aria-label="Allega immagini e documenti"
                      title="Allega fino a 4 file: immagini 5 MB, documenti 20 MB"
                      disabled={sending || !draftReady}
                      onClick={() => imageInput.current?.click()}
                    >
                      <Paperclip size={19} />
                    </button>
                    <button
                      className="voice-button"
                      type="button"
                      aria-label="Apri modalità voce"
                      disabled={!settings}
                      onClick={startVoice}
                    >
                      <AudioLines size={19} />
                      <span>Voce</span>
                    </button>
                    <button
                      className="send-button"
                      aria-label={
                        run?.status === 'awaiting_input'
                          ? 'Invia risposta'
                          : working || current.queue_paused
                            ? 'Aggiungi alla coda'
                            : 'Invia messaggio'
                      }
                      title={
                        working ? 'Il messaggio partirà al termine del task' : 'Invia messaggio'
                      }
                      disabled={sending || !draftReady || (!draft.trim() && !images.length)}
                    >
                      <ArrowUp size={19} />
                    </button>
                  </div>
                </div>
              </form>
              <p className="composer-caption">
                {settings?.demo
                  ? 'Modalità dimostrazione · Nessun agente reale viene eseguito.'
                  : 'Il tuo agente può lavorare sui file e usare gli strumenti del progetto.'}
              </p>
            </div>
          </>
        )}
      </main>
      {markdownDocument && (
        <React.Suspense
          fallback={
            <div className="md-loading" role="status">
              Apro il documento…
            </div>
          }
        >
          <MarkdownReader
            key={markdownDocument.key}
            document={markdownDocument}
            onClose={() => setMarkdownDocument(undefined)}
            onAsk={current ? askAboutMarkdown : undefined}
          />
        </React.Suspense>
      )}
      {notificationsOpen && (
        <NotificationSettings settings={settings} onClose={() => setNotificationsOpen(false)} />
      )}
      {chatMenu && (
        <div className="modal-backdrop">
          <section
            className="modal compact-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="chat-menu-title"
          >
            <button
              className="modal-close icon-button"
              aria-label="Chiudi menu chat"
              disabled={actionPending}
              onClick={() => setChatMenu(null)}
            >
              <X size={20} />
            </button>
            <h2 id="chat-menu-title">
              {chatAction === 'rename'
                ? 'Rinomina chat'
                : chatAction === 'delete'
                  ? 'Elimina chat?'
                  : 'Gestisci chat'}
            </h2>
            <p className="chat-menu-title">{chatMenu.title}</p>
            {!chatAction ? (
              <div className="chat-menu-options">
                <button onClick={() => setChatAction('rename')}>
                  <Pencil size={18} /> Rinomina
                </button>
                <button className="danger-text" onClick={() => setChatAction('delete')}>
                  <Trash2 size={18} /> Elimina
                </button>
              </div>
            ) : (
              <form onSubmit={manageChat}>
                {chatAction === 'rename' ? (
                  <>
                    <label htmlFor="chat-title">Titolo della chat</label>
                    <input
                      id="chat-title"
                      className="settings-input"
                      value={chatTitle}
                      maxLength={120}
                      required
                      autoFocus
                      onChange={(e) => setChatTitle(e.target.value)}
                    />
                  </>
                ) : (
                  <>
                    <p>
                      La conversazione e i messaggi verranno eliminati. I file del progetto restano
                      sul server.
                    </p>
                    {busy(chats.find((c) => c.id === chatMenu.id)?.status) && (
                      <p role="status">
                        Questa chat sta lavorando. Attendi il risultato o interrompi il task prima
                        di eliminarla.
                      </p>
                    )}
                  </>
                )}
                {actionError && (
                  <p className="form-error" role="alert">
                    {actionError}
                  </p>
                )}
                <div className="dialog-actions">
                  <button
                    type="button"
                    className="quiet"
                    disabled={actionPending}
                    onClick={() => setChatMenu(null)}
                  >
                    Annulla
                  </button>
                  <button
                    className={chatAction === 'delete' ? 'primary danger-button' : 'primary'}
                    disabled={
                      actionPending ||
                      (chatAction === 'rename'
                        ? !chatTitle.trim()
                        : busy(chats.find((c) => c.id === chatMenu.id)?.status))
                    }
                  >
                    {actionPending
                      ? 'Salvataggio…'
                      : chatAction === 'rename'
                        ? 'Salva titolo'
                        : 'Elimina chat'}
                  </button>
                </div>
              </form>
            )}
          </section>
        </div>
      )}
      {preferencesOpen && preferencesTab === 'terminal' && (
        <React.Suspense
          fallback={
            <div className="modal-backdrop">
              <p>Carico il terminale…</p>
            </div>
          }
        >
          <TerminalSettings
            chats={chats}
            onClose={() => setPreferencesOpen(false)}
            onTab={(tab) => void openPreferences(tab)}
          />
        </React.Suspense>
      )}
      {preferencesOpen && preferencesTab === 'skills' && (
        <SkillsSettings
          onRead={openMarkdown}
          chats={chats}
          selected={selected}
          onClose={() => setPreferencesOpen(false)}
          onTab={(tab) => void openPreferences(tab)}
        />
      )}
      {preferencesOpen && preferencesTab === 'voice' && (
        <div className="modal-backdrop">
          <section
            className="modal settings-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="preferences-title"
          >
            <button
              className="modal-close icon-button"
              aria-label="Chiudi impostazioni"
              disabled={preferencesPending}
              onClick={() => setPreferencesOpen(false)}
            >
              <X size={20} />
            </button>
            <div className="eyebrow">IMPOSTAZIONI</div>
            <h2 id="preferences-title">Impostazioni voce</h2>
            <nav className="settings-tabs" aria-label="Sezioni impostazioni">
              <button aria-current="page">Voce</button>
              <button onClick={() => void openPreferences('mcp')}>MCP</button>
              <button onClick={() => void openPreferences('skills')}>Skill</button>
              <button onClick={() => void openPreferences('terminal')}>Terminale</button>
            </nav>
            <button className="soft-button" onClick={openNotifications}>
              <Bell size={16} /> Notifiche
            </button>
            <p>
              OpenRouter trascrive quello che dici e legge le risposte. Queste scelte valgono per
              tutte le chat.
            </p>
            {preferencesError && (
              <p className="form-error" role="alert">
                {preferencesError}
              </p>
            )}
            {!audioPreferences ? (
              <p>{preferencesError ? 'Chiudi e riprova.' : 'Carico le impostazioni…'}</p>
            ) : (
              <form onSubmit={savePreferences}>
                {(['sttModel', 'ttsModel'] as const).map((field) => {
                  const candidates = audioCatalog?.[field === 'sttModel' ? 'stt' : 'tts'] || [];
                  const options = new Map(candidates.map((m) => [m.id, m.name]));
                  options.set(
                    audioPreferences[field],
                    options.get(audioPreferences[field]) || audioPreferences[field],
                  );
                  options.set(
                    audioPreferences.defaults[field],
                    options.get(audioPreferences.defaults[field]) ||
                      audioPreferences.defaults[field],
                  );
                  return (
                    <React.Fragment key={field}>
                      <label htmlFor={field}>
                        {field === 'sttModel' ? 'Modello di trascrizione' : 'Modello della voce'}
                      </label>
                      <select
                        id={field}
                        className="settings-input"
                        value={audioPreferences[field]}
                        disabled={preferencesPending}
                        onChange={(e) => {
                          const value = e.target.value;
                          setAudioPreferences(
                            (p) =>
                              p && {
                                ...p,
                                [field]: value,
                                ...(field === 'ttsModel'
                                  ? {
                                      voice: value.startsWith('google/')
                                        ? 'Kore'
                                        : value.startsWith('openai/')
                                          ? 'alloy'
                                          : '',
                                    }
                                  : {}),
                              },
                          );
                        }}
                      >
                        {[...options.entries()].map(([id, name]) => (
                          <option key={id} value={id}>
                            {name}
                          </option>
                        ))}
                      </select>
                    </React.Fragment>
                  );
                })}
                <label htmlFor="tts-voice">Voce</label>
                <input
                  id="tts-voice"
                  className="settings-input"
                  value={audioPreferences.voice}
                  required
                  maxLength={160}
                  disabled={preferencesPending}
                  placeholder="Identificativo della voce"
                  onChange={(e) => setAudioPreferences((p) => p && { ...p, voice: e.target.value })}
                />
                <small>
                  La voce deve essere supportata dal modello scelto.{' '}
                  <a
                    href="https://openrouter.ai/docs/guides/overview/multimodal/tts"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Voci e modelli OpenRouter
                  </a>
                  . Le modifiche si applicano ai prossimi audio.
                </small>
                <p className="settings-note">L’agente della chat rimane Claude Code o Codex.</p>
                <div className="dialog-actions">
                  <button
                    type="button"
                    className="quiet"
                    disabled={preferencesPending}
                    onClick={() => setAudioPreferences((p) => p && { ...p, ...p.defaults })}
                  >
                    Ripristina predefiniti
                  </button>
                  <button
                    className="primary"
                    disabled={preferencesPending || !audioPreferences.voice.trim()}
                  >
                    {preferencesPending ? 'Salvataggio…' : 'Salva impostazioni'}
                  </button>
                </div>
              </form>
            )}
          </section>
        </div>
      )}
      {create && (
        <div className="modal-backdrop">
          <section
            className="modal new-chat-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-title"
          >
            <button
              className="modal-close icon-button"
              aria-label="Chiudi"
              onClick={() => setCreate(false)}
            >
              <X size={20} />
            </button>
            <div className="eyebrow">NUOVA CONVERSAZIONE</div>
            <h2 id="new-title">Nuova chat</h2>
            <p>Scegli un agente e, se serve, un repository.</p>
            <form onSubmit={newChat}>
              <label>Il tuo agente</label>
              <div className="agent-options">
                {(['claude', 'codex'] as const).map((a) => (
                  <button
                    type="button"
                    key={a}
                    aria-label={agentName(a)}
                    aria-pressed={agent === a}
                    className={agent === a ? 'chosen' : ''}
                    onClick={() => setAgent(a)}
                  >
                    <AgentLogo agent={a} />
                    <strong>{agentName(a)}</strong>
                    {agent === a && <Check size={16} />}
                  </button>
                ))}
              </div>
              <RepositoryPicker
                value={repo}
                onChange={(value, required) => {
                  setRepo(value);
                  setRepoRequired(required);
                }}
              />
              <ChatToolsPicker
                agent={agent}
                value={chatTools}
                onChange={setChatTools}
                disabled={creating}
              />
              <button
                className="primary full"
                disabled={creating || (repoRequired && !repo.trim())}
              >
                {creating ? <LoaderCircle size={17} className="spin" /> : <Plus size={17} />} Crea
                chat
              </button>
            </form>
          </section>
        </div>
      )}
      {voiceChat && (
        <section
          className="voice-screen"
          role="dialog"
          aria-modal="true"
          aria-label="Modalità voce"
        >
          <header>
            <button className="quiet" onClick={stopVoice}>
              <ChevronLeft size={18} /> Torna alla chat
            </button>
            <span>{agentName(current?.agent)}</span>
          </header>
          <div className="voice-center">
            <div
              className={`orb ${speaking && !muted ? 'hearing' : ''} ${playState === 'playing' ? 'talking' : ''} ${working ? 'thinking' : ''}`}
              style={{ '--level': level } as React.CSSProperties}
            >
              <div />
              <div />
              <div />
            </div>
            <h1>
              {!settings?.voiceAvailable
                ? 'Prepariamo la voce'
                : playState === 'loading'
                  ? 'Preparo la risposta vocale…'
                  : playState === 'playing'
                    ? 'Ti racconto…'
                    : working
                      ? 'Ci sto lavorando'
                      : muted
                        ? 'Microfono disattivato'
                        : speaking
                          ? 'Ti ascolto'
                          : 'Sono qui. Parliamo.'}
            </h1>
            <p>
              {!settings?.voiceAvailable
                ? 'Aggiungi la chiave OpenRouter nelle impostazioni del server per parlare e ascoltare.'
                : working
                  ? 'Puoi lasciare questa schermata. Ti avviso quando ho finito.'
                  : 'Prenditi il tuo tempo.'}
            </p>
            {error && (
              <p className="voice-error" role="alert">
                {error}
              </p>
            )}
          </div>
          <div className={`microphone-state ${muted ? 'is-muted' : ''}`} role="status">
            {muted ? <MicOff size={17} /> : <Mic size={17} />}
            <span>
              {!settings?.voiceAvailable
                ? 'Voce non configurata'
                : muted
                  ? 'Microfono disattivato · puoi continuare ad ascoltare'
                  : !microphoneReady
                    ? 'Attivo il microfono…'
                    : working || playState !== 'idle'
                      ? 'Microfono in attesa della risposta'
                      : 'Microfono attivo'}
            </span>
          </div>
          <footer>
            <button
              className={`microphone-toggle ${muted ? 'muted' : ''}`}
              aria-label={muted ? 'Riattiva microfono' : 'Disattiva microfono'}
              aria-pressed={muted}
              disabled={!settings?.voiceAvailable}
              onClick={toggleMicrophone}
            >
              {muted ? <MicOff /> : <Mic />}
              <span>{muted ? 'Riattiva microfono' : 'Disattiva microfono'}</span>
            </button>
            <button
              className="round-control end-voice"
              aria-label="Chiudi modalità voce"
              onClick={stopVoice}
            >
              <X />
            </button>
          </footer>
          <div className="voice-caption">
            {current?.repo || 'Chat libera'} · Voce generata con AI
          </div>
        </section>
      )}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
if ('serviceWorker' in navigator && import.meta.env.PROD)
  navigator.serviceWorker.register('/sw.js').catch(() => {});
