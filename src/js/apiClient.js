import { Capacitor } from '@capacitor/core';

/**
 * API Client
 * Wraps fetch to handle standard JSON, errors, and authentication state.
 */

const REMOTE_API_ORIGIN = 'https://health-coach-ai.onrender.com';
const MOBILE_SESSION_KEY = 'anandaya:mobileSessionId';

function shouldUseRemoteApi() {
  const protocol = window.location.protocol;
  const hostname = window.location.hostname;
  const isNative = Capacitor.isNativePlatform?.() || window.Capacitor?.isNativePlatform?.();
  return isNative || protocol === 'capacitor:' || hostname === 'localhost';
}

function getMobileSessionId() {
  try { return localStorage.getItem(MOBILE_SESSION_KEY); } catch { return null; }
}

function resolveApiUrl(url) {
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('/api') && shouldUseRemoteApi()) {
    return `${REMOTE_API_ORIGIN}${url}`;
  }
  return url;
}

export const apiClient = {
  setMobileSession(sessionId) {
    try { localStorage.setItem(MOBILE_SESSION_KEY, sessionId); } catch {}
  },

  clearMobileSession() {
    try { localStorage.removeItem(MOBILE_SESSION_KEY); } catch {}
  },

  async fetch(url, options = {}) {
    const requestUrl = resolveApiUrl(url);
    const mobileSessionId = getMobileSessionId();
    const headers = {
      'Content-Type': 'application/json',
      ...(mobileSessionId ? { Authorization: `Bearer ${mobileSessionId}` } : {}),
      ...options.headers,
    };

    const config = {
      ...options,
      headers,
      credentials: 'include',
    };

    if (config.body && typeof config.body === 'object') {
      config.body = JSON.stringify(config.body);
    }

    try {
      const response = await fetch(requestUrl, config);

      // Handle 401 Unauthorized globally, but do not interrupt auth exchange flows.
      const isAuthExchange = url.includes('/api/auth/login') || url.includes('/api/auth/mobile/exchange');
      if (response.status === 401 && !isAuthExchange) {
        this.clearMobileSession();
        window.dispatchEvent(new CustomEvent('auth:unauthorized'));
        throw new Error('Unauthorized');
      }

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'API Request Failed');
      }

      return data;
    } catch (error) {
      console.error(`[API Error] ${requestUrl}:`, error.message);
      throw error;
    }
  },

  get(url) {
    return this.fetch(url, { method: 'GET' });
  },

  post(url, data) {
    return this.fetch(url, { method: 'POST', body: data });
  },

  patch(url, data) {
    return this.fetch(url, { method: 'PATCH', body: data });
  },

  put(url, data) {
    return this.fetch(url, { method: 'PUT', body: data });
  },

  delete(url) {
    return this.fetch(url, { method: 'DELETE' });
  }
};
