export interface LoaderXhrRequestError extends Error {
  request: XMLHttpRequest;
  response: unknown;
  status: number;
}

/**
 * @description mutable object
 */
export interface LoaderXhrRequestParams {
  url?: string;
  deferred?: {
    resolve: (value: ArrayBuffer | PromiseLike<ArrayBuffer>) => void;
    reject: (reason) => void;
  };
  imageId?: string;
}

export interface LoaderXhrRequestPromise<T> extends Promise<T> {
  xhr?: XMLHttpRequest;
  /** Resolves after the rendered-frame byte cache store finishes. */
  byteStore?: Promise<void>;
}
