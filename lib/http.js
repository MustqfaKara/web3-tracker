// Timeout'lu fetch helper'i. Dis servislerden cevap gelmezse bot loop'u takilmasin.
import { env } from './config.js';

export async function fetchWithTimeout(url, options = {}, timeoutMs = env.FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: options.signal || controller.signal
    });
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error(`Fetch timeout after ${timeoutMs}ms`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
