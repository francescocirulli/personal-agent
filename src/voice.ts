// Use a single media element for spoken audio. Unlike ambient Web Audio output,
// it uses the media playback route on iOS. Start play() within the actual tap;
// the server may generate the response while the element is buffering.
export type PlaybackState = 'idle' | 'loading' | 'playing' | 'paused';
function audioSessionType(type: 'playback' | 'play-and-record') {
  const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
  if (session) {
    try {
      session.type = type;
    } catch {
      /* Optional Safari routing API. */
    }
  }
}
export class Speaker {
  private media?: HTMLAudioElement;
  private generation = 0;
  private priming = false;
  state: PlaybackState = 'idle';
  constructor(private change: (state: PlaybackState) => void) {}
  private element() {
    if (this.media) return this.media;
    const media = document.createElement('audio');
    media.preload = 'auto';
    media.setAttribute('playsinline', '');
    media.hidden = true;
    document.body.appendChild(media);
    media.addEventListener('playing', () => {
      if (!this.priming && this.state !== 'idle') this.set('playing');
    });
    media.addEventListener('waiting', () => {
      if (!this.priming && this.state !== 'idle' && !media.paused) this.set('loading');
    });
    media.addEventListener('pause', () => {
      if (!this.priming && this.state === 'playing') this.set(media.ended ? 'idle' : 'paused');
    });
    media.addEventListener('ended', () => {
      if (!this.priming) this.set('idle');
    });
    media.addEventListener('error', () => {
      if (!this.priming) this.set('idle');
    });
    this.media = media;
    return media;
  }
  private playbackRoute() {
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
    if (session?.type !== 'play-and-record') audioSessionType('playback');
  }
  async unlock() {
    const media = this.element();
    this.playbackRoute();
    const token = ++this.generation;
    this.priming = true;
    media.src = '/silence.wav';
    try {
      await media.play();
    } finally {
      if (token === this.generation) {
        media.pause();
        this.priming = false;
      }
    }
  }
  stop() {
    this.generation++;
    this.priming = false;
    this.set('idle');
    if (this.media) {
      this.media.pause();
      this.media.removeAttribute('src');
      this.media.load();
    }
  }
  async pause() {
    if (this.state !== 'playing') return;
    this.media?.pause();
    this.set('paused');
  }
  async resume() {
    if (this.state !== 'paused') return;
    this.playbackRoute();
    try {
      await this.media!.play();
    } catch {
      throw new Error('Non riesco a riprendere questo audio. Riprova.');
    }
  }
  private set(state: PlaybackState) {
    this.state = state;
    this.change(state);
  }
  async play(url: string) {
    this.stop();
    const token = this.generation,
      media = this.element();
    this.playbackRoute();
    this.set('loading');
    media.src = url;
    try {
      // No awaited fetch before this call: preserve Safari's user activation.
      await media.play();
    } catch (e) {
      if (token !== this.generation) return;
      this.set('idle');
      throw new Error(
        (e as DOMException).name === 'NotAllowedError'
          ? 'La riproduzione è stata bloccata dal telefono. Tocca Ascolta per avviarla.'
          : 'Non riesco a riprodurre questo audio. Premi Ascolta per riprovare.',
      );
    }
  }
}

// Lightweight, adaptive energy VAD for the first vertical slice. No browser
// speech recognition: recorded clips are always transcribed by the server.
export class HandsFree {
  private stream?: MediaStream;
  private context?: AudioContext;
  private timer?: ReturnType<typeof setInterval>;
  private recorder?: MediaRecorder;
  private stopped = false;
  private enabled = false;
  private ignoreClip = false;
  private speechAt = 0;
  private lastLoud = 0;
  private loudFrames = 0;
  private noise = 0.005;
  constructor(
    private onClip: (blob: Blob) => void,
    private onLevel: (level: number, speaking: boolean) => void,
    private onError: (error: string) => void,
  ) {}
  async start() {
    if (!window.isSecureContext)
      throw new Error('Il microfono richiede una connessione HTTPS. Apri il sito con HTTPS.');
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder)
      throw new Error(
        'La registrazione vocale non è disponibile in questo browser. Prova Safari aggiornato.',
      );
    audioSessionType('play-and-record');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    } catch (e) {
      const name = (e as Error).name;
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        const standalone =
          (navigator as Navigator & { standalone?: boolean }).standalone ||
          window.matchMedia('(display-mode: standalone)').matches;
        throw new Error(
          standalone
            ? 'Accesso al microfono negato nell’app aperta dalla Home. Chiudi e riapri l’app e consenti l’accesso se richiesto. Se continua, usa il sito in Safari.'
            : 'Accesso al microfono negato. Consenti il microfono nelle impostazioni del sito e riprova.',
          { cause: e },
        );
      }
      if (name === 'NotFoundError')
        throw new Error('Nessun microfono disponibile. Controlla il dispositivo e riprova.', {
          cause: e,
        });
      if (name === 'NotReadableError' || name === 'AbortError')
        throw new Error(
          'Il telefono non riesce ad aprire il microfono. Termina eventuali chiamate o registrazioni e riprova.',
          { cause: e },
        );
      throw new Error(
        `Non riesco ad aprire il microfono (${name || 'errore sconosciuto'}). Chiudi e riapri l’app.`,
        { cause: e },
      );
    }
    // Start closed: the caller applies its current mute state after permission resolves.
    this.stream.getAudioTracks().forEach((track) => {
      track.enabled = false;
    });
    if (this.stopped) {
      this.stream.getTracks().forEach((t) => t.stop());
      return;
    }
    try {
      this.context = new AudioContext();
      await this.context.resume();
    } catch (e) {
      throw new Error(
        'Il microfono è autorizzato, ma non riesco ad avviare l’audio. Chiudi e riapri l’app, poi riprova Voce.',
        { cause: e },
      );
    }
    if (this.stopped) return;
    const source = this.context.createMediaStreamSource(this.stream),
      analyser = this.context.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    this.stream.getAudioTracks()[0].onended = () => {
      if (!this.stopped) this.onError('Il microfono si è disconnesso. Riapri la modalità voce.');
    };
    this.timer = setInterval(() => {
      if (!this.enabled || this.stopped) return;
      analyser.getFloatTimeDomainData(samples);
      const rms = Math.sqrt(samples.reduce((sum, n) => sum + n * n, 0) / samples.length);
      const loud = rms > Math.max(0.018, this.noise * 3);
      const now = Date.now();
      if (!this.recorder && !loud) this.noise = this.noise * 0.98 + rms * 0.02;
      if (loud) {
        this.lastLoud = now;
        this.loudFrames++;
      } else this.loudFrames = 0;
      if (!this.recorder && this.loudFrames >= 2) this.record(now);
      this.onLevel(Math.min(rms * 12, 1), !!this.recorder);
      if (this.recorder && (now - this.lastLoud > 1300 || now - this.speechAt > 60000)) {
        this.enabled = false;
        this.stream?.getAudioTracks().forEach((track) => {
          track.enabled = false;
        });
        this.finish(false);
        this.onLevel(0, false);
      }
    }, 50);
  }
  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    this.loudFrames = 0;
    if (!enabled && this.recorder) this.finish(true);
    if (!enabled) this.onLevel(0, false);
    if (this.stream)
      this.stream.getAudioTracks().forEach((track) => {
        track.enabled = enabled;
      });
  }
  private record(now: number) {
    const mimeType = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((type) =>
      MediaRecorder.isTypeSupported(type),
    );
    const recorder = new MediaRecorder(this.stream!, mimeType ? { mimeType } : undefined),
      chunks: BlobPart[] = [];
    this.recorder = recorder;
    this.ignoreClip = false;
    this.speechAt = now;
    recorder.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    recorder.onerror = () => this.onError('Registrazione interrotta. Riprova.');
    recorder.onstop = () => {
      const ignore = this.ignoreClip || this.stopped;
      this.recorder = undefined;
      if (!ignore) {
        const blob = new Blob(chunks, { type: recorder.mimeType });
        if (blob.size) this.onClip(blob);
      }
    };
    recorder.start(250);
  }
  private finish(ignore: boolean) {
    this.ignoreClip = ignore;
    if (this.recorder?.state === 'recording') this.recorder.stop();
  }
  stop() {
    this.stopped = true;
    this.enabled = false;
    clearInterval(this.timer);
    this.finish(true);
    this.stream?.getTracks().forEach((t) => t.stop());
    audioSessionType('playback');
    void this.context?.close();
  }
}
