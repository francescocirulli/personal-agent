let fallbackId: string | undefined;
export function notificationDeviceId() {
  try {
    const key = 'personal-agent-notification-device';
    let id = localStorage.getItem(key);
    if (!id || !/^[a-f0-9-]{36}$/.test(id)) {
      id = crypto.randomUUID();
      localStorage.setItem(key, id);
    }
    return id;
  } catch {
    return (fallbackId ??= crypto.randomUUID());
  }
}
export function updateAppBadge(count: number) {
  const nav = navigator as Navigator & {
    setAppBadge?(count: number): Promise<void>;
    clearAppBadge?(): Promise<void>;
  };
  void (count ? nav.setAppBadge?.(count) : nav.clearAppBadge?.())?.catch(() => {});
}
