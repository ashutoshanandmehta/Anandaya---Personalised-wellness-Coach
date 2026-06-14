/**
 * API Client
 * Wraps fetch to handle standard JSON, errors, and authentication state.
 */

export const apiClient = {
  async fetch(url, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...options.headers,
    };

    const config = {
      ...options,
      headers,
    };

    if (config.body && typeof config.body === 'object') {
      config.body = JSON.stringify(config.body);
    }

    try {
      const response = await fetch(url, config);
      
      // Handle 401 Unauthorized globally
      if (response.status === 401 && !url.includes('/api/auth/login')) {
        window.dispatchEvent(new CustomEvent('auth:unauthorized'));
        throw new Error('Unauthorized');
      }

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'API Request Failed');
      }

      return data;
    } catch (error) {
      console.error(`[API Error] ${url}:`, error.message);
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
