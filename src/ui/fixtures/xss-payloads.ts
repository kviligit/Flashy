/**
 * Payloads that must never execute.
 *
 * Every one of these was demonstrated firing against the previous,
 * regex-based sanitiser during a security audit. They live in a plain
 * module rather than a test file so that both the node suite and the
 * browser suite can load the identical corpus — and the browser one is the
 * test that counts, since the whole class of bug comes from how a real
 * parser differs from what you expect.
 *
 * Nothing in the application imports this.
 */

export interface XssPayload {
  name: string;
  html: string;
}

export const XSS_PAYLOADS: readonly XssPayload[] = [
  { name: 'slash separator before handler', html: '<img src="x"/onerror="window.__xss=1">' },
  { name: 'quote separator before handler', html: '<img src="x"onerror="window.__xss=1">' },
  { name: 'slash separators throughout', html: '<img/src="x"/onerror="window.__xss=1">' },
  { name: 'image alias for img', html: '<image src=x /onerror=window.__xss=1>' },
  { name: 'plain handler', html: '<img src=x onerror=window.__xss=1>' },
  { name: 'svg onload', html: '<svg/onload=window.__xss=1>' },
  { name: 'body onload', html: '<body onload=window.__xss=1>' },
  { name: 'script element', html: '<script>window.__xss=1<\/script>' },
  { name: 'iframe srcdoc', html: '<iframe srcdoc="<script>parent.__xss=1<\/script>"></iframe>' },
  { name: 'details ontoggle', html: '<details open ontoggle=window.__xss=1>x</details>' },
  { name: 'video onerror', html: '<video><source onerror="window.__xss=1"></video>' },
  { name: 'uppercase handler', html: '<IMG SRC=x ONERROR=window.__xss=1>' },
  { name: 'mixed case tag', html: '<ImG src=x OnErRoR=window.__xss=1>' },
  { name: 'newline separated', html: '<img src=x\nonerror=window.__xss=1>' },
  { name: 'tab separated', html: '<img src=x\tonerror=window.__xss=1>' },
  { name: 'form action', html: '<form action="javascript:window.__xss=1"><button>go</button></form>' },
  { name: 'base hijack', html: '<base href="https://evil.invalid/">' },
  { name: 'object data', html: '<object data="javascript:window.__xss=1"></object>' },
  { name: 'embed src', html: '<embed src="javascript:window.__xss=1">' },
  { name: 'style expression', html: '<div style="background:url(javascript:window.__xss=1)">x</div>' },
  { name: 'meta refresh', html: '<meta http-equiv="refresh" content="0;url=javascript:window.__xss=1">' },
];

