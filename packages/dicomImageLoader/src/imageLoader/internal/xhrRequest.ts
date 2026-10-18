import { getOptions } from './options';
import type {
  LoaderXhrRequestError,
  LoaderXhrRequestParams,
  LoaderXhrRequestPromise,
} from '../../types';
import { triggerEvent, eventTarget } from '@cornerstonejs/core';
import {
  copyResponseOntoFacade,
  copyXhrOntoFacade,
  createByteCacheFacade,
  emitImageByteCache,
  imageByteCacheName,
  isImageByteCacheActive,
  matchRenderedFrame,
  storeRenderedFrame,
} from './imageByteCache';

function xhrRequest(
  url: string,
  imageId: string,
  defaultHeaders: Record<string, string> = {},
  params: LoaderXhrRequestParams = {}
): LoaderXhrRequestPromise<ArrayBuffer> {
  const options = getOptions();
  if (!isImageByteCacheActive(options, url)) {
    return xhrRequestNetwork(url, imageId, defaultHeaders, params);
  }

  const facade = createByteCacheFacade(url);
  const promise: LoaderXhrRequestPromise<ArrayBuffer> = new Promise<ArrayBuffer>(
    async (resolve, reject) => {
      const cacheName = imageByteCacheName(options);
      const readStarted = performance.now();
      try {
        const cached = await matchRenderedFrame(cacheName, url);
        if (cached) {
          const buffer = await cached.arrayBuffer();
          copyResponseOntoFacade(facade, cached, buffer);
          emitImageByteCache(options, {
            result: 'hit',
            durationMs: performance.now() - readStarted,
            bytes: buffer.byteLength,
            url,
            imageId,
          });
          try {
            resolve(await options.beforeProcessing(facade as unknown as XMLHttpRequest));
          } catch {
            reject(facade);
          }
          return;
        }
      } catch {
        // A cache read failure falls through to the network.
      }

      const downloadStarted = performance.now();
      const networkPromise = xhrRequestNetwork(url, imageId, defaultHeaders, params);
      try {
        const buffer = await networkPromise;
        const realXhr = networkPromise.xhr;
        if (realXhr) {
          copyXhrOntoFacade(facade, realXhr);
        }
        const bytes =
          realXhr?.response instanceof ArrayBuffer ? realXhr.response.byteLength : buffer.byteLength;
        emitImageByteCache(options, {
          result: 'miss',
          durationMs: performance.now() - downloadStarted,
          bytes,
          url,
          imageId,
        });
        if (realXhr && realXhr.status === 200 && realXhr.response instanceof ArrayBuffer) {
          const storedBody = realXhr.response.slice(0);
          const contentType = realXhr.getResponseHeader('Content-Type');
          const storeStarted = performance.now();
          void storeRenderedFrame(cacheName, url, storedBody, contentType).catch(() => {
            emitImageByteCache(options, {
              result: 'store_fail',
              durationMs: performance.now() - storeStarted,
              bytes,
              url,
              imageId,
            });
          });
        }
        resolve(buffer);
      } catch (error) {
        reject(error);
      }
    }
  );

  promise.xhr = facade as unknown as XMLHttpRequest;
  return promise;
}

function xhrRequestNetwork(
  url: string,
  imageId: string,
  defaultHeaders: Record<string, string> = {},
  params: LoaderXhrRequestParams = {}
): LoaderXhrRequestPromise<ArrayBuffer> {
  const options = getOptions();

  const errorInterceptor = (xhr: XMLHttpRequest) => {
    if (typeof options.errorInterceptor === 'function') {
      const error = new Error('request failed') as LoaderXhrRequestError;

      error.request = xhr;
      error.response = xhr.response;
      error.status = xhr.status;
      options.errorInterceptor(error);
    }
  };

  const xhr = new XMLHttpRequest();

  // Make the request for the DICOM P10 SOP Instance
  const promise: LoaderXhrRequestPromise<ArrayBuffer> =
    new Promise<ArrayBuffer>(async (resolve, reject) => {
      options.open(xhr, url, defaultHeaders, params);
      const beforeSendHeaders = await options.beforeSend(
        xhr,
        imageId,
        defaultHeaders,
        params
      );

      xhr.responseType = 'arraybuffer';

      const headers = Object.assign({}, defaultHeaders, beforeSendHeaders);

      Object.keys(headers).forEach(function (key) {
        if (headers[key] === null) {
          return;
        }
        if (key === 'Accept' && url.indexOf('accept=') !== -1) {
          return;
        }
        xhr.setRequestHeader(key, headers[key]);
      });

      params.deferred = {
        resolve,
        reject,
      };
      params.url = url;
      params.imageId = imageId;

      // Event triggered when downloading an image starts
      xhr.onloadstart = function (event) {
        // Action
        if (options.onloadstart) {
          options.onloadstart(event, params);
        }

        // Event
        const eventData = {
          url,
          imageId,
        };

        triggerEvent(eventTarget, 'cornerstoneimageloadstart', eventData);
      };

      // Event triggered when downloading an image ends
      xhr.onloadend = function (event) {
        // Action
        if (options.onloadend) {
          options.onloadend(event, params);
        }

        const eventData = {
          url,
          imageId,
        };

        // Event
        triggerEvent(eventTarget, 'cornerstoneimageloadend', eventData);
      };

      // handle response data
      xhr.onreadystatechange = function (event) {
        // Action
        if (options.onreadystatechange) {
          options.onreadystatechange(event, params);

          // This should not return, because if a hook is defined, that function
          // will be called but the image load promise will never resolve.
          // return;
        }

        // Default action
        // TODO: consider sending out progress messages here as we receive
        // the pixel data
        if (xhr.readyState === 4) {
          // Status OK (200) and partial content (206) are both handled
          if (xhr.status === 200 || xhr.status === 206) {
            options
              .beforeProcessing(xhr)
              .then(resolve)
              .catch(() => {
                errorInterceptor(xhr);
                // request failed, reject the Promise
                reject(xhr);
              });
          } else {
            errorInterceptor(xhr);
            // request failed, reject the Promise
            reject(xhr);
          }
        }
      };

      // Event triggered when downloading an image progresses
      xhr.onprogress = function (oProgress) {
        // console.log('progress:',oProgress)
        const loaded = oProgress.loaded; // evt.loaded the bytes browser receive

        let total: number;

        let percentComplete: number;

        if (oProgress.lengthComputable) {
          total = oProgress.total; // evt.total the total bytes seted by the header
          percentComplete = Math.round((loaded / total) * 100);
        }

        const eventData = {
          url,
          imageId,
          loaded,
          total,
          percentComplete,
        };

        triggerEvent(eventTarget, 'cornerstoneimageloadprogress', eventData);

        // Action
        if (options.onprogress) {
          options.onprogress(oProgress, params);
        }
      };
      xhr.onerror = function () {
        errorInterceptor(xhr);
        reject(xhr);
      };

      xhr.onabort = function () {
        errorInterceptor(xhr);
        reject(xhr);
      };
      xhr.send();
    });

  promise.xhr = xhr;

  return promise;
}

export default xhrRequest;
