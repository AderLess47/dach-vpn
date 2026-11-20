/**
 * Ruft einen Next.js-Route-Handler direkt mit einem `Request` auf.
 *
 * Gemeinsam genutzt von den Routen-Tests, damit jeder Test nur noch Status,
 * Code und Body prüfen muss — und nicht jedes Mal Request-Bau und JSON-Parsing
 * nachbaut.
 *
 * `body` darf ein Objekt (wird serialisiert) oder ein roher String sein; der
 * String-Fall ist für kaputtes JSON gedacht.
 */
export async function callRoute(handler, options = {}) {
  const { body, token, method = "POST", headers = {}, url = "http://127.0.0.1/api" } = options;

  const requestHeaders = { ...headers };
  if (token) requestHeaders.authorization = `Bearer ${token}`;
  if (body !== undefined && !("content-type" in requestHeaders)) {
    requestHeaders["content-type"] = "application/json";
  }

  const request = new Request(url, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });

  const response = await handler(request);
  const text = await response.text();

  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  return { response, status: response.status, payload };
}
