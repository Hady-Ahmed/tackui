import { describe, it, expect, vi } from "vitest";
import { wrapStreamWithRelease } from "./stream-wrap";

/**
 * Helper: create a Response with a ReadableStream body that emits the
 * given chunks then closes.
 */
function makeStreamResponse(
  chunks: Uint8Array[],
  status = 200,
  headers: Record<string, string> = {},
): Response {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { "Content-Type": "text/event-stream", ...headers },
  });
}

describe("wrapStreamWithRelease", () => {
  it("releases immediately when response has no body", async () => {
    const release = vi.fn();
    const response = new Response(null, { status: 204 });
    const result = wrapStreamWithRelease(response, release);
    expect(release).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(204);
    expect(result.body).toBeNull();
  });

  it("releases when stream completes naturally", async () => {
    const release = vi.fn();
    const data = new TextEncoder().encode("hello");
    const response = makeStreamResponse([data]);
    const result = wrapStreamWithRelease(response, release);

    // Consume the wrapped stream
    const reader = result.body!.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    expect(release).toHaveBeenCalledTimes(1);
    expect(new TextDecoder().decode(chunks[0])).toBe("hello");
  });

  it("releases when source stream errors", async () => {
    const release = vi.fn();
    const stream = new ReadableStream({
      pull(controller) {
        controller.error(new Error("stream broke"));
      },
    });
    const response = new Response(stream, { status: 200 });
    const result = wrapStreamWithRelease(response, release);

    const reader = result.body!.getReader();
    await expect(reader.read()).rejects.toThrow("stream broke");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("releases when consumer cancels the stream", async () => {
    const release = vi.fn();
    const stream = new ReadableStream({
      pull(controller) {
        // Never close — simulates a long-lived SSE stream
        controller.enqueue(new TextEncoder().encode("data: ping\n\n"));
      },
    });
    const response = new Response(stream, { status: 200 });
    const result = wrapStreamWithRelease(response, release);

    const reader = result.body!.getReader();
    await reader.read(); // consume one chunk
    await reader.cancel("client disconnected");

    expect(release).toHaveBeenCalledTimes(1);
  });

  it("preserves response status, statusText, and headers", async () => {
    const release = vi.fn();
    const data = new TextEncoder().encode("ok");
    const response = makeStreamResponse([data], 200, {
      "X-Custom-Header": "test-value",
    });
    const result = wrapStreamWithRelease(response, release);

    expect(result.status).toBe(200);
    expect(result.headers.get("Content-Type")).toBe("text/event-stream");
    expect(result.headers.get("X-Custom-Header")).toBe("test-value");

    // Consume to trigger release
    await result.body!.getReader().read();
  });

  it("pipes all data chunks through correctly", async () => {
    const release = vi.fn();
    const encoder = new TextEncoder();
    const response = makeStreamResponse([
      encoder.encode("chunk1 "),
      encoder.encode("chunk2 "),
      encoder.encode("chunk3"),
    ]);
    const result = wrapStreamWithRelease(response, release);

    const reader = result.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    expect(text).toBe("chunk1 chunk2 chunk3");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("release is idempotent via the release fn (not double-called on stream end)", async () => {
    // The wrapStreamWithRelease calls release once on stream end.
    // If the caller also calls release manually (e.g. in an error path),
    // the release fn itself should be idempotent (the middleware's
    // acquireConcurrent returns an idempotent release). Here we just
    // verify wrapStreamWithRelease itself only calls it once.
    const release = vi.fn();
    const data = new TextEncoder().encode("x");
    const response = makeStreamResponse([data]);
    const result = wrapStreamWithRelease(response, release);

    const reader = result.body!.getReader();
    await reader.read();
    await reader.read(); // done

    expect(release).toHaveBeenCalledTimes(1);
  });
});
