import { useEffect, useRef, useState } from 'react';
import { api } from './api';

// Cloudflare Turnstile (explicit render) + the public sample-site discovery
// endpoint. The site key is public; the secret never reaches the browser.

interface TurnstileApi {
  render: (element: HTMLElement, options: Record<string, unknown>) => string;
  reset: (widgetId?: string) => void;
  remove: (widgetId?: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
    __suzubaseTurnstileLoading?: Promise<void>;
  }
}

function loadTurnstile(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  window.__suzubaseTurnstileLoading ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('本人確認コンポーネントの読み込みに失敗しました'));
    document.head.appendChild(script);
  });
  return window.__suzubaseTurnstileLoading;
}

export interface SampleInfo { enabled: boolean; siteKey?: string }

let sampleInfoCache: Promise<SampleInfo> | undefined;
export function sampleInfo(): Promise<SampleInfo> {
  sampleInfoCache ??= api<SampleInfo>('/auth/sample', undefined).catch(() => ({ enabled: false }));
  return sampleInfoCache;
}

export function useSampleSiteKey(active: boolean): string | undefined {
  const [siteKey, setSiteKey] = useState<string>();
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void sampleInfo().then((info) => {
      if (!cancelled && info.enabled) setSiteKey(info.siteKey);
    });
    return () => { cancelled = true; };
  }, [active]);
  return siteKey;
}

export function Turnstile({ siteKey, onToken, resetSignal }: {
  siteKey: string;
  onToken: (token: string | null) => void;
  resetSignal?: number;
}) {
  const element = useRef<HTMLDivElement>(null);
  const widget = useRef<string | undefined>(undefined);
  const notify = useRef(onToken);
  notify.current = onToken;
  useEffect(() => {
    let cancelled = false;
    void loadTurnstile().then(() => {
      if (cancelled || !element.current || !window.turnstile) return;
      widget.current = window.turnstile.render(element.current, {
        sitekey: siteKey,
        callback: (token: string) => notify.current(token),
        'expired-callback': () => notify.current(null),
        'error-callback': () => notify.current(null),
      });
    }).catch(() => notify.current(null));
    return () => {
      cancelled = true;
      if (widget.current && window.turnstile) window.turnstile.remove(widget.current);
      widget.current = undefined;
    };
  }, [siteKey]);
  useEffect(() => {
    if (resetSignal && widget.current && window.turnstile) window.turnstile.reset(widget.current);
  }, [resetSignal]);
  return <div ref={element} className="turnstile" />;
}
