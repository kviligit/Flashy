/**
 * Minimal ambient declarations for the Node built-ins used by the test
 * suite. This project installs no packages (@types/node included), so the
 * handful of APIs `node --test` needs are declared here instead.
 *
 * Only add to this file what the tests actually call.
 */

declare module 'node:test' {
  interface TestContext {
    name: string;
    diagnostic(message: string): void;
    skip(message?: string): void;
  }
  type TestFn = (t: TestContext) => void | Promise<void>;

  export function test(name: string, fn: TestFn): Promise<void>;
  export function it(name: string, fn: TestFn): Promise<void>;
  export function describe(name: string, fn: () => void): void;
  export function before(fn: () => void | Promise<void>): void;
  export function beforeEach(fn: () => void | Promise<void>): void;
  export function after(fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;
  export default test;
}

declare module 'node:fs' {
  export function readFileSync(path: string | URL, encoding: 'utf8'): string;
  export function writeFileSync(path: string | URL, data: string): void;
}

declare module 'node:assert/strict' {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    ok(value: unknown, message?: string): asserts value;
    equal<T>(actual: unknown, expected: T, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual<T>(actual: unknown, expected: T, message?: string): void;
    notDeepEqual(actual: unknown, expected: unknown, message?: string): void;
    throws(fn: () => unknown, expected?: unknown, message?: string): void;
    doesNotThrow(fn: () => unknown, message?: string): void;
    rejects(fn: () => Promise<unknown>, expected?: unknown, message?: string): Promise<void>;
    match(value: string, regexp: RegExp, message?: string): void;
    fail(message?: string): never;
  }
  const assert: Assert;
  export default assert;
}
