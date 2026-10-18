import {
  IMAGE_BYTE_CACHE_NAME,
  type ImageByteCacheEvent,
  type LoaderOptions,
} from '../../types/LoaderOptions';

const RENDERED_FRAME_PATH = '/frames-rendered/';

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
      return Array.from(this._headers.entries())
        .map(([key, value]) => `${key}: ${value}`)
        .join('\r\n');
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

export async function matchRenderedFrame(
  cacheName: string,
  url: string
): Promise<Response | undefined> {
  const cache = await caches.open(cacheName);
  const match = await cache.match(cacheKeyForUrl(url));
  return match ?? undefined;
}

export async function storeRenderedFrame(
  cacheName: string,
  url: string,
  body: ArrayBuffer,
  contentType: string | null
): Promise<void> {
  if (body.byteLength === 0) {
    return;
  }
  const cache = await caches.open(cacheName);
  const headers = new Headers();
  if (contentType) {
    headers.set('Content-Type', contentType);
  }
  await cache.put(cacheKeyForUrl(url), new Response(body, { status: 200, headers }));
}
