import type { LoaderDecodeOptions } from './LoaderDecodeOptions';
import type {
  LoaderXhrRequestError,
  LoaderXhrRequestParams,
} from './XHRRequest';

/** Named Cache API store for rendered JPEG frames. Shared with the viewer and logout. */
export const IMAGE_BYTE_CACHE_NAME = 'sp-ohif-frames-v1';

export type ImageByteCacheResult =
  | 'hit'
  | 'promoted'
  | 'miss'
  | 'store_fail'
  | 'prefetch_full'
  | 'evict';

export interface ImageByteCacheEvent {
  result: ImageByteCacheResult;
  durationMs: number;
  bytes: number;
  url: string;
  imageId: string;
  /** Frames deleted by this store. Set when result is evict. */
  evicted?: number;
}

export interface ImageByteCacheOptions {
  enabled?: boolean;
  cacheName?: string;
  /**
   * When set, eviction compares origin usage to this cap instead of the
   * browser quota. Used to test a full cache without filling the disk.
   */
  quotaBytes?: number;
  /**
   * Cache entries whose URL returns true are kept. Eviction still deletes
   * every other entry, oldest first. A prefetch run passes its frame URLs.
   */
  isProtectedUrl?: (url: string) => boolean;
  onEvent?: (event: ImageByteCacheEvent) => void;
}

export interface LoaderOptions {
  maxWebWorkers?: number;
  // callback to open the object
  open?: (
    xhr: XMLHttpRequest,
    url: string,
    defaultHeaders: Record<string, string>,
    params: LoaderXhrRequestParams
  ) => void;
  // callback allowing customization of the xhr (e.g. adding custom auth headers, cors, etc)
  beforeSend?: (
    xhr: XMLHttpRequest,
    imageId: string,
    defaultHeaders: Record<string, string>,
    params: LoaderXhrRequestParams
  ) => Promise<Record<string, string> | void> | Record<string, string> | void;
  // callback allowing modification of the xhr response before creating image objects
  beforeProcessing?: (xhr: XMLHttpRequest) => Promise<ArrayBuffer>;
  // callback allowing modification of newly created image objects
  imageCreated?: (imageObject: unknown) => void;
  onloadstart?: (event: ProgressEvent<EventTarget>, params: unknown) => void;
  onloadend?: (event: ProgressEvent<EventTarget>, params: unknown) => void;
  onreadystatechange?: (event: Event, params: unknown) => void;
  onprogress?: (event: ProgressEvent<EventTarget>, params: unknown) => void;
  errorInterceptor?: (error: LoaderXhrRequestError) => void;
  strict?: boolean;
  decodeConfig?: LoaderDecodeOptions;
  /**
   * Persistent compressed-byte cache for `/frames-rendered/` JPEG responses.
   * Off unless `enabled` is set. Raw `/frames/` and HTTP 206 are not stored.
   */
  imageByteCache?: ImageByteCacheOptions;
}
