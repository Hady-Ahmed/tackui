/**
 * Wrap a Response so that `release()` is called when the response body
 * stream finishes (on natural completion, error, or client cancellation).
 *
 * This is necessary for the concurrent-stream cap: we increment before
 * the run starts and must decrement when the stream closes. The SSE
 * response from CopilotKit is a standard `Response` with a `ReadableStream`
 * body — we tee/wrap it to intercept the close event.
 *
 * If the response has no body (e.g. a 429 or error JSON), release
 * immediately.
 */
export function wrapStreamWithRelease(
  response: Response,
  release: () => void,
): Response {
  if (!response.body) {
    release();
    return response;
  }

  const stream = response.body;
  const reader = stream.getReader();

  // Create a new stream that pipes through the reader and calls release
  // when the source stream closes or errors.
  const wrappedStream = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          release();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        release();
        controller.error(err);
      }
    },
    cancel() {
      release();
      reader.cancel().catch(() => {});
    },
  });

  // Copy headers + status from the original response.
  const headers = new Headers(response.headers);
  return new Response(wrappedStream, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
