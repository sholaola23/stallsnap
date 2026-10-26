// A fake Meta API for tests: no network, no spend. Each handler gets the
// request and returns a JSON body, or a Response for error cases.
export type FakeCall = { url: string; method: string; headers: Headers; body: unknown };

export function fakeMeta(handler: (call: FakeCall) => unknown | Response | Promise<unknown | Response>) {
  const calls: FakeCall[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    let body: unknown = init?.body;
    if (typeof body === "string") body = JSON.parse(body);
    const call = { url, method: init?.method ?? "GET", headers, body };
    calls.push(call);
    const out = await handler(call);
    return out instanceof Response ? out : new Response(JSON.stringify(out), { status: 200 });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}
