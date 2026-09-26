import { test, expect } from '@playwright/test';

for (const scenario of [
  { name: 'blocked playback', playback: 'blocked', micError: '', contextError: false, message: '' },
  { name: 'pending playback', playback: 'pending', micError: '', contextError: false, message: '' },
  {
    name: 'Home permission denied',
    playback: 'blocked',
    micError: 'NotAllowedError',
    contextError: false,
    message: 'Accesso al microfono negato nell’app aperta dalla Home.',
  },
  {
    name: 'microphone unavailable',
    playback: 'blocked',
    micError: 'NotReadableError',
    contextError: false,
    message: 'Il telefono non riesce ad aprire il microfono.',
  },
  {
    name: 'audio context failure',
    playback: 'blocked',
    micError: '',
    contextError: true,
    message: 'Il microfono è autorizzato, ma non riesco ad avviare l’audio.',
  },
]) {
  test(`voice startup: ${scenario.name}`, async ({ page, request }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/api/config', async (route) => {
      const response = await route.fetch();
      await route.fulfill({ json: { ...(await response.json()), voiceAvailable: true } });
    });
    await page.addInitScript(({ playback, micError, contextError }) => {
      // Model separate Home permissions and audio failures without recording a device.
      const w = window as any;
      const track = {
        enabled: true,
        stopped: false,
        stop() {
          this.stopped = true;
        },
        onended: null,
      };
      w.voiceTest = { requests: 0, track };
      Object.defineProperty(navigator, 'standalone', { value: true });
      HTMLMediaElement.prototype.play = function () {
        if (playback === 'pending') return new Promise<void>(() => {});
        return Promise.reject(new DOMException('Playback blocked', 'NotAllowedError'));
      };
      Object.defineProperty(navigator, 'mediaDevices', {
        value: {
          getUserMedia: async () => {
            w.voiceTest.requests++;
            if (micError) throw new DOMException('Capture failed', micError);
            return { getTracks: () => [track], getAudioTracks: () => [track] };
          },
        },
      });
      w.AudioContext = class {
        resume() {
          return contextError
            ? Promise.reject(new DOMException('Audio blocked', 'NotAllowedError'))
            : Promise.resolve();
        }
        close() {
          return Promise.resolve();
        }
        createMediaStreamSource() {
          return { connect() {} };
        }
        createAnalyser() {
          return {
            fftSize: 1024,
            getFloatTimeDomainData(samples: Float32Array) {
              samples.fill(0);
            },
          };
        }
      };
      w.MediaRecorder = class {};
    }, scenario);
    const chat = await (
      await request.post('/api/conversations', {
        data: { agent: 'codex', title: `Voice startup: ${scenario.name}` },
      })
    ).json();
    try {
      await page.goto(`/?chat=${chat.id}`);
      await page.getByRole('button', { name: 'Apri modalità voce' }).click();
      await expect.poll(() => page.evaluate(() => (window as any).voiceTest.requests)).toBe(1);
      const voice = page.getByRole('dialog', { name: 'Modalità voce' });
      if (scenario.message) {
        await expect(page.getByRole('alert')).toContainText(scenario.message);
        await expect(voice).toHaveCount(0);
        await expect(page.getByRole('alert')).not.toContainText('HTTPS');
        if (scenario.contextError)
          expect(await page.evaluate(() => (window as any).voiceTest.track.stopped)).toBe(true);
      } else {
        await expect(voice.getByRole('status')).toHaveText('Microfono attivo');
        await expect(page.getByRole('alert')).toHaveCount(0);
        await voice.getByRole('button', { name: 'Torna alla chat' }).click();
        expect(await page.evaluate(() => (window as any).voiceTest.track.stopped)).toBe(true);
      }
      expect(errors).toEqual([]);
    } finally {
      await request.post(`/api/conversations/${chat.id}/delete`, { data: {} });
    }
  });
}
