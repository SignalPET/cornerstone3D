import {
  IMAGE_BYTE_CACHE_NAME,
  type ImageByteCacheEvent,
  type LoaderOptions,
} from '../../types/LoaderOptions';

const RENDERED_FRAME_PATH = '/frames-rendered/';
const FULL_QUALITY = 100;
const QUALITY_HEADER = 'x-sp-quality';
const STORED_AT_HEADER = 'x-sp-stored-at';
/** Set on a response that served a cached quality=100 body in place of a lower request. */
export const BYTE_CACHE_FULL_HEADER = 'x-sp-byte-cache-full';
const HIGH_WATER = 0.9;
const EVICT_BATCH = 20;
const EVICT_ROUNDS = 6;

export type ByteCacheFacade = {
  status: number;
  response: ArrayBuffer | null;
  readyState: number;
  responseURL: string;
  responseType: string;
  _headers: Map<string, string>;
  getResponseHeader(name: string): string | null;
  getAllResponseHeaders(): string;
};

export function isImageByteCacheActive(options: LoaderOptions, url: string): boolean {
  return (
    Boolean(options.imageByteCache?.enabled) &&
    url.includes(RENDERED_FRAME_PATH) &&
    typeof caches !== 'undefined'
  );
}

export function imageByteCacheName(options: LoaderOptions): string {
  return options.imageByteCache?.cacheName || IMAGE_BYTE_CACHE_NAME;
}

export function cacheKeyForUrl(url: string): string {
  if (typeof window === 'undefined') {
    return url;
  }
  try {
    return new URL(url, window.location.href).href;
  } catch {
    return url;
  }
}

export function createByteCacheFacade(url: string): ByteCacheFacade {
  return {
    status: 0,
    response: null,
    readyState: 0,
    responseURL: url,
    responseType: 'arraybuffer',
    _headers: new Map(),
    getResponseHeader(name: string): string | null {
      return this._headers.get(name.toLowerCase()) ?? null;
    },
    getAllResponseHeaders(): string {
      const lines: string[] = [];
      this._headers.forEach((value, key) => {
        lines.push(`${key}: ${value}`);
      });
      return lines.join('\r\n');
    },
  };
}

export function copyXhrOntoFacade(facade: ByteCacheFacade, xhr: XMLHttpRequest): void {
  facade._headers.clear();
  const raw = xhr.getAllResponseHeaders?.() ?? '';
  raw.split(/[\r\n]+/).forEach(line => {
    const separator = line.indexOf(':');
    if (separator <= 0) {
      return;
    }
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key) {
      facade._headers.set(key, value);
    }
  });
  facade.status = xhr.status;
  facade.readyState = xhr.readyState;
  facade.responseURL = xhr.responseURL || facade.responseURL;
  facade.response = xhr.response instanceof ArrayBuffer ? xhr.response : null;
}

export function copyResponseOntoFacade(
  facade: ByteCacheFacade,
  response: Response,
  buffer: ArrayBuffer
): void {
  facade._headers.clear();
  response.headers.forEach((value, key) => {
    facade._headers.set(key.toLowerCase(), value);
  });
  facade.status = 200;
  facade.readyState = 4;
  facade.response = buffer;
}

export function emitImageByteCache(options: LoaderOptions, event: ImageByteCacheEvent): void {
  options.imageByteCache?.onEvent?.(event);
}

export function renderedFrameQuality(url: string): number | null {
  try {
    const base = typeof window === 'undefined' ? 'http://localhost' : window.location.href;
    const parsed = new URL(url, base);
    if (!parsed.pathname.includes(RENDERED_FRAME_PATH)) {
      return null;
    }
    const raw = parsed.searchParams.get('quality');
    if (raw == null || raw === '') {
      return null;
    }
    const quality = Number(raw);
    return Number.isFinite(quality) ? quality : null;
  } catch {
    return null;
  }
}

/** quality=100 URL for the same rendered frame, when the request is a lower quality. */
export function fullQualityUrl(url: string): string | null {
  const quality = renderedFrameQuality(url);
  if (quality == null || quality >= FULL_QUALITY || typeof window === 'undefined') {
    return null;
  }
  const parsed = new URL(url, window.location.href);
  parsed.searchParams.set('quality', String(FULL_QUALITY));
  return parsed.href;
}

export async function matchRenderedFrame(
  cacheName: string,
  url: string
): Promise<Response | undefined> {
  const cache = await caches.open(cacheName);
  const match = await cache.match(cacheKeyForUrl(url));
  return match ?? undefined;
}

function isQuotaError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name: string }).name === 'QuotaExceededError'
  );
}

type RankedEntry = {
  request: Request;
  quality: number;
  storedAt: number;
};

async function evictLowerPriority(
  cache: Cache,
  incomingQuality: number,
  keepUrl: string,
  isProtectedUrl?: (url: string) => boolean
): Promise<number> {
  const requests = await cache.keys();
  const ranked: RankedEntry[] = [];
  for (const request of requests) {
    if (request.url === keepUrl || isProtectedUrl?.(request.url)) {
      continue;
    }
    const response = await cache.match(request);
    if (!response) {
      continue;
    }
    const headerQuality = Number(response.headers.get(QUALITY_HEADER));
    const quality = Number.isFinite(headerQuality)
      ? headerQuality
      : (renderedFrameQuality(request.url) ?? FULL_QUALITY);
    if (quality > incomingQuality) {
      continue;
    }
    const storedAt = Number(response.headers.get(STORED_AT_HEADER));
    ranked.push({
      request,
      quality,
      storedAt: Number.isFinite(storedAt) ? storedAt : 0,
    });
  }
  ranked.sort((a, b) => a.quality - b.quality || a.storedAt - b.storedAt);
  const batch = ranked.slice(0, EVICT_BATCH);
  await Promise.all(batch.map(entry => cache.delete(entry.request)));
  return batch.length;
}

/** True when usage stays over the high-water mark and no older entry can be deleted. */
async function makeRoom(
  cache: Cache,
  incomingQuality: number,
  keepUrl: string,
  incomingBytes: number,
  quotaBytes?: number,
  isProtectedUrl?: (url: string) => boolean
): Promise<boolean> {
  const quotaOverride = quotaBytes && quotaBytes > 0 ? quotaBytes : 0;
  if ((typeof navigator === 'undefined' || !navigator.storage?.estimate) && !quotaOverride) {
    return false;
  }
  for (let round = 0; round < EVICT_ROUNDS; round++) {
    const estimate = navigator.storage?.estimate ? await navigator.storage.estimate() : {};
    const quota = quotaOverride || (estimate.quota ?? 0);
    const usage = estimate.usage ?? 0;
    if (!quota || usage + incomingBytes <= quota * HIGH_WATER) {
      return false;
    }
    const removed = await evictLowerPriority(
      cache,
      incomingQuality,
      keepUrl,
      isProtectedUrl
    );
    if (removed === 0) {
      return true;
    }
  }
  return false;
}

export type StoreRenderedFrameResult = {
  saturated: boolean;
  stored: boolean;
};

export async function storeRenderedFrame(
  cacheName: string,
  url: string,
  body: ArrayBuffer,
  contentType: string | null,
  quotaBytes?: number,
  isProtectedUrl?: (url: string) => boolean
): Promise<StoreRenderedFrameResult> {
  if (body.byteLength === 0) {
    return { saturated: false, stored: true };
  }
  const key = cacheKeyForUrl(url);
  const quality = renderedFrameQuality(url) ?? FULL_QUALITY;
  const cache = await caches.open(cacheName);
  let saturated = await makeRoom(
    cache,
    quality,
    key,
    body.byteLength,
    quotaBytes,
    isProtectedUrl
  );
  const buildResponse = () => {
    const headers = new Headers();
    if (contentType) {
      headers.set('Content-Type', contentType);
    }
    headers.set(QUALITY_HEADER, String(quality));
    headers.set(STORED_AT_HEADER, String(Date.now()));
    return new Response(body, { status: 200, headers });
  };
  try {
    await cache.put(key, buildResponse());
  } catch (error) {
    if (!isQuotaError(error)) {
      throw error;
    }
    const removed = await evictLowerPriority(cache, quality, key, isProtectedUrl);
    if (removed === 0) {
      return { saturated: true, stored: false };
    }
    await cache.put(key, buildResponse());
  }
  return { saturated, stored: true };
}
