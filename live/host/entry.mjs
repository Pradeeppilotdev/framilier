// The build embeds staticResponses and handleApi in this module. No browser request can pick an upstream.
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    const asset = staticResponses.get(path === "/" ? "/index.html" : path);
    if (asset) {
      if (!["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
      const [type, contents] = asset;
      return new Response(request.method === "HEAD" ? null : contents, { headers: {
        "Content-Type": type + "; charset=utf-8",
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'",
      } });
    }
    try {
      return await handleApi(request, env) || new Response(null, { status: 404 });
    } catch {
      return Response.json({ error: "The live runner is temporarily unavailable. Try again shortly." }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
  },
};
